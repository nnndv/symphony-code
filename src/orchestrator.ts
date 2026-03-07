import { Effect, Ref, PubSub, Fiber, Schedule, Duration, Layer } from "effect"
import { Config, ConfigLive, type SymphonyConfig } from "./config.js"
import { EventBus, EventBusLive, type SymphonyEvent } from "./event-bus.js"
import { TrackerService, TrackerLive, type Tracker } from "./github/tracker.js"
import { type Issue, identifier } from "./github/issue.js"
import { type Workflow } from "./workflow.js"
import { runAgent } from "./agent-runner.js"

interface RunningTask {
  readonly fiber: Fiber.RuntimeFiber<unknown, unknown>
  readonly issue: Issue
  readonly startedAt: number
}

interface RetryEntry {
  readonly id: string
  readonly attempt: number
  readonly retryAt: number
}

export interface OrchestratorState {
  readonly running: Map<string, RunningTask>
  readonly completed: Set<string>
  readonly claimed: Set<string>
  readonly retryQueue: RetryEntry[]
  readonly tokenTotals: { costUsd: number; turns: number }
}

const initialState: OrchestratorState = {
  running: new Map(),
  completed: new Set(),
  claimed: new Set(),
  retryQueue: [],
  tokenTotals: { costUsd: 0, turns: 0 },
}

export interface OrchestratorHandle {
  readonly state: Ref.Ref<OrchestratorState>
  readonly fiber: Fiber.RuntimeFiber<void, never>
  readonly refresh: () => Effect.Effect<void>
}

/** Start the orchestrator loop. Returns a handle for state access and control. */
export function startOrchestrator(
  workflow: Workflow | null,
  hooks: Record<string, string> = {},
): Effect.Effect<OrchestratorHandle, never, Config | EventBus | TrackerService> {
  return Effect.gen(function* () {
    const config = yield* Config
    const pubsub = yield* EventBus
    const tracker = yield* TrackerService
    const stateRef = yield* Ref.make(initialState)

    // Build a layer to provide to forked agent effects
    const agentLayer = Layer.mergeAll(
      ConfigLive(config),
      EventBusLive,
      TrackerLive.pipe(Layer.provide(ConfigLive(config))),
    )

    const tick = Effect.gen(function* () {
      yield* pollAndDispatch(stateRef, config, pubsub, tracker, workflow, hooks, agentLayer)
      yield* checkStalls(stateRef, config)
      yield* processRetries(stateRef, tracker)
    }).pipe(Effect.catchAllCause((cause) => Effect.logError(`Orchestrator tick failed: ${cause}`)))

    const loop = tick.pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(config.pollIntervalMs))),
      Effect.asVoid,
    )

    const fiber = yield* Effect.fork(loop)

    return { state: stateRef, fiber, refresh: () => tick } satisfies OrchestratorHandle
  })
}

/** Get a snapshot of orchestrator state for API/dashboard. */
export function getStateSnapshot(stateRef: Ref.Ref<OrchestratorState>) {
  return Ref.get(stateRef).pipe(
    Effect.map((s) => ({
      running: Array.from(s.running.keys()),
      completed: Array.from(s.completed),
      claimed: Array.from(s.claimed),
      retryQueue: s.retryQueue.map(({ id, attempt }) => ({ id, attempt })),
      tokenTotals: s.tokenTotals,
    })),
  )
}

// --- Internal ---

function filterCandidates(issues: Issue[], state: OrchestratorState): Issue[] {
  const runningIds = new Set(state.running.keys())

  return issues
    .filter((issue) => {
      const id = identifier(issue)
      return (
        !runningIds.has(id) &&
        !state.completed.has(id) &&
        !state.claimed.has(id) &&
        issue.state === "open" &&
        issue.blockers.every((b) => state.completed.has(String(b)))
      )
    })
    .sort((a, b) => priorityOrder(a.priority) - priorityOrder(b.priority))
}

function priorityOrder(p: string): number {
  switch (p) {
    case "p1": return 1
    case "p2": return 2
    case "p3": return 3
    case "p4": return 4
    default: return 3
  }
}

function pollAndDispatch(
  stateRef: Ref.Ref<OrchestratorState>,
  config: SymphonyConfig,
  pubsub: PubSub.PubSub<SymphonyEvent>,
  tracker: Tracker,
  workflow: Workflow | null,
  hooks: Record<string, string>,
  agentLayer: Layer.Layer<Config | EventBus | TrackerService>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const issuesResult = yield* tracker.listIssues().pipe(
      Effect.catchAll((err) =>
        Effect.logError(`Poll failed: ${err}`).pipe(Effect.map(() => [] as Issue[])),
      ),
    )

    const currentState = yield* Ref.get(stateRef)
    const candidates = filterCandidates(issuesResult, currentState)
    const slots = config.maxConcurrent - currentState.running.size
    const toDispatch = candidates.slice(0, Math.max(slots, 0))

    for (const issue of toDispatch) {
      const id = identifier(issue)

      const agentEffect = runAgent(issue, workflow, hooks).pipe(
        Effect.tap((result) =>
          Effect.gen(function* () {
            yield* Effect.sync(() =>
              PubSub.publish(pubsub, {
                _tag: "IssueCompleted",
                issueNumber: id,
                costUsd: result.costUsd,
                turns: result.numTurns,
              } satisfies SymphonyEvent),
            ).pipe(Effect.flatten)

            yield* Ref.update(stateRef, (s) => {
              const running = new Map(s.running)
              running.delete(id)
              const completed = new Set(s.completed)
              completed.add(id)
              return {
                ...s,
                running,
                completed,
                tokenTotals: {
                  costUsd: s.tokenTotals.costUsd + result.costUsd,
                  turns: s.tokenTotals.turns + result.numTurns,
                },
              }
            })
          }),
        ),
        Effect.tapError((err) =>
          Effect.gen(function* () {
            const attempt = getRetryAttempt(currentState, id) + 1
            const backoff = Math.min(Math.pow(2, attempt) * 1000, config.maxRetryBackoffMs)

            yield* PubSub.publish(pubsub, {
              _tag: "IssueFailed",
              issueNumber: id,
              error: String(err),
              retryAttempt: attempt,
              retryInMs: backoff,
            } satisfies SymphonyEvent)

            yield* Ref.update(stateRef, (s) => {
              const running = new Map(s.running)
              running.delete(id)
              return {
                ...s,
                running,
                retryQueue: [...s.retryQueue, { id, attempt, retryAt: Date.now() + backoff }],
              }
            })
          }),
        ),
        Effect.catchAll(() => Effect.void),
        Effect.provide(agentLayer),
      )

      const fiber = yield* Effect.fork(agentEffect)

      yield* Ref.update(stateRef, (s) => {
        const running = new Map(s.running)
        running.set(id, { fiber, issue, startedAt: Date.now() })
        const claimed = new Set(s.claimed)
        claimed.add(id)
        return { ...s, running, claimed }
      })

      yield* PubSub.publish(pubsub, {
        _tag: "IssueDispatched",
        issueNumber: id,
        title: issue.title,
      } satisfies SymphonyEvent)
    }
  })
}

function checkStalls(
  stateRef: Ref.Ref<OrchestratorState>,
  config: SymphonyConfig,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const now = Date.now()
    const state = yield* Ref.get(stateRef)

    for (const [id, task] of state.running) {
      if (now - task.startedAt > config.stallTimeoutMs) {
        yield* Effect.logWarning(`Issue #${id} stalled, interrupting`)
        yield* Fiber.interrupt(task.fiber)
        yield* Ref.update(stateRef, (s) => {
          const running = new Map(s.running)
          running.delete(id)
          return { ...s, running }
        })
      }
    }
  })
}

function processRetries(
  stateRef: Ref.Ref<OrchestratorState>,
  tracker: Tracker,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const now = Date.now()
    const state = yield* Ref.get(stateRef)

    const ready = state.retryQueue.filter((r) => r.retryAt <= now)
    const pending = state.retryQueue.filter((r) => r.retryAt > now)

    yield* Ref.update(stateRef, (s) => ({ ...s, retryQueue: pending }))

    for (const entry of ready) {
      const issueResult = yield* tracker.getIssue(entry.id).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )

      if (issueResult && issueResult.state === "open") {
        yield* Ref.update(stateRef, (s) => {
          const claimed = new Set(s.claimed)
          claimed.delete(entry.id)
          return { ...s, claimed }
        })
      }
    }
  })
}

function getRetryAttempt(state: OrchestratorState, id: string): number {
  return state.retryQueue.find((r) => r.id === id)?.attempt ?? 0
}
