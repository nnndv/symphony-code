import { Effect, PubSub, Queue } from "effect"
import { Config } from "../config.js"
import { EventBus, type SymphonyEvent } from "../event-bus.js"
import { ui } from "../ui.js"

/** Log orchestrator events to terminal via clack. Used in --no-tui mode. */
export function startTerminalLog(): Effect.Effect<void, never, EventBus | Config> {
  return Effect.scoped(Effect.gen(function* () {
    const config = yield* Config
    const pubsub = yield* EventBus
    const sub = yield* PubSub.subscribe(pubsub)

    let firstPoll = true

    yield* Effect.forever(
      Effect.gen(function* () {
        const event = yield* Queue.take(sub)
        logEvent(event, firstPoll, config.verbose)
        if (event._tag === "PollCompleted" || event._tag === "PollFailed") {
          firstPoll = false
        }
      }),
    )
  }))
}

function logEvent(event: SymphonyEvent, firstPoll: boolean, verbose: boolean): void {
  switch (event._tag) {
    case "PollCompleted":
      if (firstPoll) {
        ui.success(`GitHub connected — ${event.issuesFound} issue${event.issuesFound !== 1 ? "s" : ""} found, ${event.candidateCount} candidate${event.candidateCount !== 1 ? "s" : ""}`)
      } else if (event.dispatchedCount > 0) {
        ui.info(`Poll: ${event.issuesFound} issues, dispatching ${event.dispatchedCount}`)
      }
      break

    case "PollFailed":
      if (firstPoll) {
        ui.error(`GitHub connection failed: ${event.error}`)
      } else {
        ui.warn(`Poll failed: ${event.error}`)
      }
      break

    case "IssueDispatched":
      ui.info(`Dispatched #${event.issueNumber}: ${event.title}`)
      break

    case "IssueCompleted":
      ui.success(`Completed #${event.issueNumber} ($${event.costUsd.toFixed(4)}, ${event.turns} turns)`)
      break

    case "IssueFailed":
      ui.warn(`Failed #${event.issueNumber}: ${event.error} (retry ${event.retryAttempt} in ${Math.round(event.retryInMs / 1000)}s)`)
      break

    case "IssueStalled":
      ui.warn(`Stalled #${event.issueNumber} — interrupted`)
      break

    case "AgentFailed":
      ui.error(`Agent error on #${event.issueNumber}: ${event.error}`)
      break

    case "ClaudeMessage":
      if (verbose) {
        const text = extractMessageText(event.message)
        if (text) {
          const session = event.sessionId.replace(/^symphony-/, "")
          ui.info(`[${session}] ${text}`)
        }
      }
      break

    case "ClaudeStatus":
      if (verbose) {
        const session = event.sessionId.replace(/^symphony-/, "")
        ui.info(`[${session}] (${event.type})`)
      }
      break

    default:
      break
  }
}

/** Extract displayable text from a Claude assistant message. */
function extractMessageText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null
  const msg = message as { role?: string; content?: unknown[] }
  if (!Array.isArray(msg.content)) return null

  const parts: string[] = []
  for (const block of msg.content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>
      if (b["type"] === "text" && typeof b["text"] === "string") {
        parts.push(b["text"] as string)
      } else if (b["type"] === "tool_use") {
        parts.push(`[tool: ${b["name"]}]`)
      }
    }
  }
  return parts.length > 0 ? parts.join(" ").slice(0, 200) : null
}
