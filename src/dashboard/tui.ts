import { Effect, PubSub, Queue, Schedule, Duration, Ref } from "effect"
import { EventBus, type SymphonyEvent } from "../event-bus.js"
import { type OrchestratorState } from "../orchestrator.js"

interface TuiState {
  running: Map<string, { title: string; startedAt: number }>
  completed: Array<{ issueNumber: string; costUsd: number }>
  retryQueue: Array<{ issueNumber: string; attempt: number }>
  totals: { costUsd: number; turns: number }
}

const initialTuiState: TuiState = {
  running: new Map(),
  completed: [],
  retryQueue: [],
  totals: { costUsd: 0, turns: 0 },
}

/** Start the TUI dashboard. Subscribes to events and renders ANSI output every second. */
export function startTui(
  orchestratorState: Ref.Ref<OrchestratorState>,
): Effect.Effect<void, never, EventBus> {
  return Effect.scoped(Effect.gen(function* () {
    const pubsub = yield* EventBus
    const tuiState = yield* Ref.make(initialTuiState)
    const sub = yield* PubSub.subscribe(pubsub)

    // Enter alternate screen buffer to avoid polluting terminal history
    process.stdout.write("\x1b[?1049h")
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => process.stdout.write("\x1b[?1049l")),
    )

    // Event consumer fiber
    yield* Effect.fork(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* Queue.take(sub)
          yield* handleEvent(tuiState, event)
        }),
      ),
    )

    // Render loop
    yield* Effect.forever(
      Effect.gen(function* () {
        const state = yield* Ref.get(tuiState)
        render(state)
        yield* Effect.sleep(Duration.seconds(1))
      }),
    )
  }))
}

function handleEvent(
  stateRef: Ref.Ref<TuiState>,
  event: SymphonyEvent,
): Effect.Effect<void> {
  return Ref.update(stateRef, (state) => {
    switch (event._tag) {
      case "IssueDispatched": {
        const running = new Map(state.running)
        running.set(event.issueNumber, { title: event.title, startedAt: Date.now() })
        return { ...state, running }
      }
      case "IssueCompleted": {
        const running = new Map(state.running)
        running.delete(event.issueNumber)
        const completed = [
          { issueNumber: event.issueNumber, costUsd: event.costUsd },
          ...state.completed,
        ].slice(0, 20)
        return {
          ...state,
          running,
          completed,
          totals: {
            costUsd: state.totals.costUsd + event.costUsd,
            turns: state.totals.turns + event.turns,
          },
        }
      }
      case "IssueFailed": {
        const running = new Map(state.running)
        running.delete(event.issueNumber)
        const retryQueue = [
          { issueNumber: event.issueNumber, attempt: event.retryAttempt },
          ...state.retryQueue,
        ].slice(0, 20)
        return { ...state, running, retryQueue }
      }
      default:
        return state
    }
  })
}

function render(state: TuiState): void {
  const now = Date.now()

  // Clear screen + cursor home
  process.stdout.write("\x1b[2J\x1b[H")
  console.log("\x1b[1;36m=== Symphony Status Dashboard ===\x1b[0m\n")

  // Running agents
  console.log(`\x1b[1;33mRunning Agents (${state.running.size}):\x1b[0m`)
  if (state.running.size === 0) {
    console.log("  (none)")
  } else {
    console.log(`  \x1b[90m${"#".padEnd(8)}  ${"Title".padEnd(50)}  Duration\x1b[0m`)
    for (const [num, info] of state.running) {
      const elapsed = Math.floor((now - info.startedAt) / 1000)
      const title = info.title.slice(0, 48)
      console.log(`  ${`#${num}`.padEnd(8)}  ${title.padEnd(50)}  ${formatDuration(elapsed)}`)
    }
  }

  console.log("")

  // Retry queue
  if (state.retryQueue.length > 0) {
    console.log("\x1b[1;31mRetry Queue:\x1b[0m")
    for (const { issueNumber, attempt } of state.retryQueue) {
      console.log(`  #${issueNumber} (attempt ${attempt})`)
    }
    console.log("")
  }

  // Recent completions
  if (state.completed.length > 0) {
    console.log("\x1b[1;32mRecent Completions:\x1b[0m")
    for (const { issueNumber, costUsd } of state.completed.slice(0, 5)) {
      console.log(`  #${issueNumber} ($${costUsd.toFixed(4)})`)
    }
    console.log("")
  }

  // Totals
  console.log(
    `\x1b[1mTotals:\x1b[0m  Cost: $${state.totals.costUsd.toFixed(4)}  |  Turns: ${state.totals.turns}`,
  )
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
