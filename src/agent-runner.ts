import { Effect, PubSub } from "effect"
import { Config } from "./config.js"
import { EventBus, type SymphonyEvent } from "./event-bus.js"
import { TrackerService } from "./github/tracker.js"
import { type Issue, identifier } from "./github/issue.js"
import { type Workflow } from "./workflow.js"
import { ensureWorkspace, beforeRun, afterRun, type WorkspaceError } from "./workspace.js"
import { render, type TemplateError } from "./prompt-builder.js"
import { runTurn, type TurnResult } from "./claude-session.js"
import { GhCliError } from "./github/client.js"

const DEFAULT_TEMPLATE = `You are working on issue #{{identifier}}: {{title}}

## Description
{{description}}

## Instructions
Implement the requested changes. Create a branch, make commits,
and open a PR that references this issue.`

export interface AgentResult {
  readonly result: string
  readonly costUsd: number
  readonly numTurns: number
  readonly exitReason: "normal" | "error"
}

/**
 * Run the full agent pipeline for a single issue.
 * Loops through multiple turns (up to max_turns), re-checking issue state
 * after each turn per the spec (Section 7.1 / 16.5).
 */
export function runAgent(
  issue: Issue,
  workflow: Workflow | null,
  hooks: Record<string, string> = {},
  attempt: number | null = null,
): Effect.Effect<AgentResult, WorkspaceError | TemplateError | GhCliError | Error, Config | EventBus | TrackerService> {
  const id = identifier(issue)

  return Effect.gen(function* () {
    const config = yield* Config
    const pubsub = yield* EventBus
    const tracker = yield* TrackerService

    yield* PubSub.publish(pubsub, {
      _tag: "AgentStarted",
      issueNumber: id,
      title: issue.title,
    } satisfies SymphonyEvent)

    // Ensure workspace (persists across runs)
    const ws = yield* ensureWorkspace(issue, hooks, config.hookTimeoutMs)
    yield* beforeRun(ws.path, issue, hooks, config.hookTimeoutMs)

    const template = workflow?.template ?? DEFAULT_TEMPLATE
    const maxTurns = config.maxTurns
    let turnNumber = 1
    let totalCostUsd = 0
    let totalTurns = 0
    let lastResult = ""

    if (config.dryRun) {
      // Simulate agent work without calling Claude
      const delayMs = 2000 + Math.random() * 3000
      yield* Effect.sleep(`${Math.round(delayMs)} millis`)
      totalCostUsd = 0
      totalTurns = 1
      lastResult = `[dry-run] Simulated agent work for issue #${id}: ${issue.title}`
    } else {
      while (turnNumber <= maxTurns) {
        // First turn: full rendered prompt. Continuation turns: guidance only.
        const prompt = turnNumber === 1
          ? yield* render(template, issue, attempt)
          : `Continue working on issue #${id}: ${issue.title}. This is turn ${turnNumber}/${maxTurns}. Check the current state and continue where you left off.`

        const sessionId = `symphony-${id}-${Date.now()}`
        const turnResult: TurnResult = yield* runTurn(
          {
            sessionId,
            model: config.model,
            permissionMode: config.permissionMode,
            allowedTools: config.allowedTools,
            maxTurns: 0, // let Claude CLI decide when done; outer loop controls symphony turns
            workspaceDir: ws.path,
          },
          { sessionId, prompt },
        )

        totalCostUsd += turnResult.costUsd
        totalTurns += turnResult.numTurns
        lastResult = turnResult.result

        // Re-check issue state from tracker after each turn
        const currentIssue = yield* tracker.getIssue(id).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        )

        // If issue is no longer in an active state, stop
        if (!currentIssue || !isActiveState(currentIssue.state, config.trackerActiveStates)) {
          break
        }

        if (turnNumber >= maxTurns) {
          break
        }

        turnNumber++
      }
    }

    // Best-effort after_run hook
    yield* afterRun(ws.path, issue, hooks, config.hookTimeoutMs)

    // Verify a PR was actually created
    const hasPR = yield* tracker.hasLinkedPR(id).pipe(
      Effect.catchAll(() => Effect.succeed(false)),
    )

    const status = hasPR ? "Completed" : "Completed (no PR found)"

    // Post result comment (best-effort)
    const commentBody = [
      "## Symphony Agent Result",
      "",
      `**Status:** ${status}`,
      `**Turns:** ${totalTurns}`,
      `**Cost:** $${totalCostUsd.toFixed(4)}`,
      ...(hasPR ? [] : ["", "> **Warning:** No linked pull request was found for this issue."]),
      "",
      "### Output",
      lastResult.slice(0, 60_000),
    ].join("\n")

    yield* tracker.comment(id, commentBody).pipe(
      Effect.catchAll(() => Effect.void),
    )

    const result: AgentResult = {
      result: lastResult,
      costUsd: totalCostUsd,
      numTurns: totalTurns,
      exitReason: "normal",
    }

    yield* PubSub.publish(pubsub, {
      _tag: "AgentCompleted",
      issueNumber: id,
      result: result.result,
      costUsd: result.costUsd,
      numTurns: result.numTurns,
    } satisfies SymphonyEvent)

    if (!hasPR) {
      yield* PubSub.publish(pubsub, {
        _tag: "AgentCompletedWithoutPR",
        issueNumber: id,
        costUsd: result.costUsd,
        numTurns: result.numTurns,
      } satisfies SymphonyEvent)
    }

    return result
  }).pipe(
    Effect.tapError((err) =>
      Effect.gen(function* () {
        const pubsub = yield* EventBus
        const tracker = yield* TrackerService
        yield* PubSub.publish(pubsub, {
          _tag: "AgentFailed",
          issueNumber: id,
          error: String(err),
        } satisfies SymphonyEvent)
        // Best-effort error comment
        yield* tracker.comment(id, `Symphony agent failed: ${String(err)}`).pipe(
          Effect.catchAll(() => Effect.void),
        )
      }),
    ),
  )
}

function isActiveState(state: string, activeStates: readonly string[]): boolean {
  const normalized = state.toLowerCase()
  return activeStates.some((s) => s.toLowerCase() === normalized)
}
