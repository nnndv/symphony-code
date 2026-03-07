import { Effect, PubSub } from "effect"
import { Config } from "./config.js"
import { EventBus, type SymphonyEvent } from "./event-bus.js"
import { TrackerService } from "./github/tracker.js"
import { type Issue, identifier } from "./github/issue.js"
import { type Workflow } from "./workflow.js"
import { withWorkspace, beforeRun, afterRun, type WorkspaceError } from "./workspace.js"
import { render, type TemplateError } from "./prompt-builder.js"
import { runTurn, type TurnResult } from "./claude-session.js"
import { GhCliError } from "./github/client.js"

const DEFAULT_TEMPLATE = `You are working on issue #{{identifier}}: {{title}}

## Description
{{description}}

## Instructions
Implement the requested changes. Create a branch, make commits, and open a PR when done.`

interface AgentResult {
  readonly result: string
  readonly costUsd: number
  readonly numTurns: number
}

/** Run the full agent pipeline for a single issue. */
export function runAgent(
  issue: Issue,
  workflow: Workflow | null,
  hooks: Record<string, string> = {},
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

    // Use scoped workspace with auto-cleanup
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* withWorkspace(issue, hooks)
        yield* beforeRun(dir, issue, hooks)

        // Build prompt
        const template = workflow?.template ?? DEFAULT_TEMPLATE
        const prompt = yield* render(template, issue)

        // Execute Claude
        const sessionId = `symphony-${id}-${Date.now()}`
        const turnResult = yield* runTurn(
          {
            sessionId,
            model: config.model,
            permissionMode: config.permissionMode,
            allowedTools: config.allowedTools,
            maxTurns: config.maxTurns,
            workspaceDir: dir,
          },
          { sessionId, prompt },
        )

        // Post result comment
        const commentBody = [
          "## Symphony Agent Result",
          "",
          `**Status:** Completed`,
          `**Turns:** ${turnResult.numTurns}`,
          `**Cost:** $${turnResult.costUsd.toFixed(4)}`,
          "",
          "### Output",
          turnResult.result.slice(0, 60_000),
        ].join("\n")

        yield* tracker.comment(id, commentBody)
        yield* afterRun(dir, issue, hooks)

        return turnResult
      }),
    )

    yield* PubSub.publish(pubsub, {
      _tag: "AgentCompleted",
      issueNumber: id,
      result: result.result,
      costUsd: result.costUsd,
      numTurns: result.numTurns,
    } satisfies SymphonyEvent)

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
