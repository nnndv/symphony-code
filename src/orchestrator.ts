import { Effect, Ref, PubSub, Fiber, Schedule, Duration, Layer } from "effect"
import { Config, ConfigLive, type SymphonyConfig } from "./config.js"
import { EventBus, EventBusLive, type SymphonyEvent } from "./event-bus.js"
import { TrackerService, TrackerLive, type Tracker } from "./github/tracker.js"
import { type Issue, identifier } from "./github/issue.js"
import { type Workflow } from "./workflow.js"
import { runAgent } from "./agent-runner.js"
import { removeWorkspace, sanitizeKey } from "./workspace.js"
import { join } from "node:path"

// --- Domain types ---

interface RunningTask {
  readonly fiber: Fiber.RuntimeFiber<unknown, unknown>
  readonly issue: Issue
  readonly startedAt: number
  readonly lastEventAt: number
  readonly attempt: number | null
}

interface RetryEntry {
  readonly id: string
  readonly identifier: string
  readonly attempt: number
  readonly retryAt: number
  readonly error: string | null
  readonly isContinuation: boolean
}

export interface OrchestratorState {
  readonly running: Map<string, RunningTask>
  readonly completed: Set<string>        // bookkeeping only — does NOT gate dispatch
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

    const agentLayer = Layer.mergeAll(
      ConfigLive(config),
      Layer.succeed(EventBus, pubsub),
      TrackerLive.pipe(Layer.provide(ConfigLive(config))),
    )

    const tick = Effect.gen(function* () {
      yield* reconcileRunningIssues(stateRef, config, pubsub, tracker, hooks)
      yield* pollAndDispatch(stateRef, config, pubsub, tracker, workflow, hooks, agentLayer)
      yield* processRetries(stateRef, config, pubsub, tracker, workflow, hooks, agentLayer)
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
      running: Array.from(s.running.entries()).map(([id, task]) => ({
        id,
        identifier: identifier(task.issue),
        title: task.issue.title,
        state: task.issue.state,
        startedAt: new Date(task.startedAt).toISOString(),
        lastEventAt: new Date(task.lastEventAt).toISOString(),
        attempt: task.attempt,
      })),
      completed: Array.from(s.completed),
      retryQueue: s.retryQueue.map(({ id, identifier, attempt, retryAt, error, isContinuation }) => ({
        id,
        identifier,
        attempt,
        dueAt: new Date(retryAt).toISOString(),
        error,
        isContinuation,
      })),
      tokenTotals: s.tokenTotals,
      repo: "",
    })),
  )
}

// --- Internal ---

function isActiveState(state: string, config: SymphonyConfig): boolean {
  const normalized = state.toLowerCase()
  return config.trackerActiveStates.some((s) => s.toLowerCase() === normalized)
}

function isTerminalState(state: string, config: SymphonyConfig): boolean {
  const normalized = state.toLowerCase()
  return config.trackerTerminalStates.some((s) => s.toLowerCase() === normalized)
}

function filterCandidates(issues: Issue[], state: OrchestratorState, config: SymphonyConfig): Issue[] {
  const runningIds = new Set(state.running.keys())

  return issues
    .filter((issue) => {
      const id = identifier(issue)
      if (runningIds.has(id)) return false
      if (state.claimed.has(id)) return false

      // Must be in active state and not terminal
      if (!isActiveState(issue.state, config)) return false
      if (isTerminalState(issue.state, config)) return false

      // Blocker rule: if issue state is "open" (todo-equivalent), block if any blocker is non-terminal
      if (issue.state.toLowerCase() === "open") {
        const hasNonTerminalBlocker = issue.blockers.some(
          (b) => !state.completed.has(String(b)),
        )
        if (hasNonTerminalBlocker) return false
      }

      return true
    })
    .sort((a, b) => {
      // 1. Priority ascending (lower number = higher priority, null sorts last)
      const pa = priorityOrder(a.priority)
      const pb = priorityOrder(b.priority)
      if (pa !== pb) return pa - pb

      // 2. created_at oldest first
      const ca = new Date(a.createdAt).getTime()
      const cb = new Date(b.createdAt).getTime()
      if (ca !== cb) return ca - cb

      // 3. identifier lexicographic tie-breaker
      return identifier(a).localeCompare(identifier(b))
    })
}

function priorityOrder(p: string): number {
  switch (p) {
    case "p1": return 1
    case "p2": return 2
    case "p3": return 3
    case "p4": return 4
    default: return 99 // null/unknown sorts last per spec
  }
}

// --- Reconciliation (Section 8.5) ---

function reconcileRunningIssues(
  stateRef: Ref.Ref<OrchestratorState>,
  config: SymphonyConfig,
  pubsub: PubSub.PubSub<SymphonyEvent>,
  tracker: Tracker,
  hooks: Record<string, string>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const now = Date.now()
    const state = yield* Ref.get(stateRef)

    if (state.running.size === 0) return

    // Part A: Stall detection
    if (config.stallTimeoutMs > 0) {
      for (const [id, task] of state.running) {
        const lastActivity = task.lastEventAt || task.startedAt
        if (now - lastActivity > config.stallTimeoutMs) {
          yield* Effect.logWarning(`Issue #${id} stalled, interrupting`)
          yield* Fiber.interrupt(task.fiber)
          yield* PubSub.publish(pubsub, {
            _tag: "IssueStalled",
            issueNumber: id,
          } satisfies SymphonyEvent)
          yield* Ref.update(stateRef, (s) => {
            const running = new Map(s.running)
            running.delete(id)
            // Keep claimed so retry can re-dispatch; retry handler will release if ineligible
            const retryQueue = [...s.retryQueue, {
              id,
              identifier: identifier(task.issue),
              attempt: (task.attempt ?? 0) + 1,
              retryAt: now + computeBackoff((task.attempt ?? 0) + 1, config.maxRetryBackoffMs),
              error: "stalled",
              isContinuation: false,
            }]
            return { ...s, running, retryQueue }
          })
        }
      }
    }

    // Part B: Tracker state refresh
    const runningState = yield* Ref.get(stateRef)
    const runningIds = Array.from(runningState.running.keys())
    if (runningIds.length === 0) return

    const refreshResult = yield* Effect.all(
      runningIds.map((id) =>
        tracker.getIssue(id).pipe(
          Effect.map((issue) => ({ id, issue, ok: true as const })),
          Effect.catchAll(() => Effect.succeed({ id, issue: null, ok: false as const })),
        ),
      ),
    )

    for (const { id, issue, ok } of refreshResult) {
      if (!ok) continue // Refresh failed — keep worker running, try next tick

      if (!issue) continue

      if (isTerminalState(issue.state, config)) {
        // Terminal: stop worker and clean workspace
        const task = runningState.running.get(id)
        if (task) {
          yield* Fiber.interrupt(task.fiber)
          const wsDir = join(config.workspaceRoot, sanitizeKey(id))
          yield* removeWorkspace(wsDir, hooks, config.hookTimeoutMs).pipe(
            Effect.catchAll(() => Effect.void),
          )
          yield* Ref.update(stateRef, (s) => {
            const running = new Map(s.running)
            running.delete(id)
            const claimed = new Set(s.claimed)
            claimed.delete(id)
            return { ...s, running, claimed }
          })
        }
      } else if (isActiveState(issue.state, config)) {
        // Still active: update the in-memory issue snapshot
        yield* Ref.update(stateRef, (s) => {
          const running = new Map(s.running)
          const existing = running.get(id)
          if (existing) {
            running.set(id, { ...existing, issue })
          }
          return { ...s, running }
        })
      } else {
        // Neither active nor terminal: stop without workspace cleanup
        const task = runningState.running.get(id)
        if (task) {
          yield* Fiber.interrupt(task.fiber)
          yield* Ref.update(stateRef, (s) => {
            const running = new Map(s.running)
            running.delete(id)
            const claimed = new Set(s.claimed)
            claimed.delete(id)
            return { ...s, running, claimed }
          })
        }
      }
    }
  })
}

// --- Poll and Dispatch (Section 8.1-8.2) ---

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
      Effect.catchAll((err) => {
        const errorMsg = String(err)
        return Effect.gen(function* () {
          yield* Effect.logError(`Poll failed: ${errorMsg}`)
          yield* PubSub.publish(pubsub, {
            _tag: "PollFailed",
            error: errorMsg,
          } satisfies SymphonyEvent)
          return [] as Issue[]
        })
      }),
    )

    const currentState = yield* Ref.get(stateRef)
    const candidates = filterCandidates(issuesResult, currentState, config)
    const slots = Math.max(config.maxConcurrent - currentState.running.size, 0)
    const toDispatch = candidates.slice(0, slots)

    yield* PubSub.publish(pubsub, {
      _tag: "PollCompleted",
      issuesFound: issuesResult.length,
      candidateCount: candidates.length,
      dispatchedCount: toDispatch.length,
    } satisfies SymphonyEvent)

    for (const issue of toDispatch) {
      yield* dispatchIssue(stateRef, pubsub, config, issue, null, workflow, hooks, agentLayer)
    }
  })
}

// --- Dispatch (Section 16.4) ---

function dispatchIssue(
  stateRef: Ref.Ref<OrchestratorState>,
  pubsub: PubSub.PubSub<SymphonyEvent>,
  config: SymphonyConfig,
  issue: Issue,
  attempt: number | null,
  workflow: Workflow | null,
  hooks: Record<string, string>,
  agentLayer: Layer.Layer<Config | EventBus | TrackerService>,
): Effect.Effect<void> {
  const id = identifier(issue)

  return Effect.gen(function* () {
    const agentEffect = runAgent(issue, workflow, hooks, attempt).pipe(
      // Normal exit: schedule continuation retry (1s)
      Effect.tap((result) =>
        Effect.gen(function* () {
          yield* PubSub.publish(pubsub, {
            _tag: "IssueCompleted",
            issueNumber: id,
            costUsd: result.costUsd,
            turns: result.numTurns,
          } satisfies SymphonyEvent)

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
              // Continuation retry: 1s delay, attempt=1
              retryQueue: [...s.retryQueue, {
                id,
                identifier: id,
                attempt: 1,
                retryAt: Date.now() + 1000,
                error: null,
                isContinuation: true,
              }],
            }
          })
        }),
      ),
      // Abnormal exit: exponential backoff retry
      Effect.tapError((err) =>
        Effect.gen(function* () {
          const nextAttempt = (attempt ?? 0) + 1
          const backoff = computeBackoff(nextAttempt, config.maxRetryBackoffMs)

          yield* PubSub.publish(pubsub, {
            _tag: "IssueFailed",
            issueNumber: id,
            error: String(err),
            retryAttempt: nextAttempt,
            retryInMs: backoff,
          } satisfies SymphonyEvent)

          yield* Ref.update(stateRef, (s) => {
            const running = new Map(s.running)
            running.delete(id)
            return {
              ...s,
              running,
              retryQueue: [...s.retryQueue, {
                id,
                identifier: id,
                attempt: nextAttempt,
                retryAt: Date.now() + backoff,
                error: String(err),
                isContinuation: false,
              }],
            }
          })
        }),
      ),
      Effect.catchAll(() => Effect.void),
      Effect.provide(agentLayer),
    )

    const fiber = yield* Effect.fork(agentEffect)
    const now = Date.now()

    yield* Ref.update(stateRef, (s) => {
      const running = new Map(s.running)
      running.set(id, { fiber, issue, startedAt: now, lastEventAt: now, attempt })
      const claimed = new Set(s.claimed)
      claimed.add(id)
      // Remove any existing retry entry for this issue
      const retryQueue = s.retryQueue.filter((r) => r.id !== id)
      return { ...s, running, claimed, retryQueue }
    })

    yield* PubSub.publish(pubsub, {
      _tag: "IssueDispatched",
      issueNumber: id,
      title: issue.title,
    } satisfies SymphonyEvent)
  })
}

// --- Retry handling (Section 16.6) ---

function processRetries(
  stateRef: Ref.Ref<OrchestratorState>,
  config: SymphonyConfig,
  pubsub: PubSub.PubSub<SymphonyEvent>,
  tracker: Tracker,
  workflow: Workflow | null,
  hooks: Record<string, string>,
  agentLayer: Layer.Layer<Config | EventBus | TrackerService>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const now = Date.now()
    const state = yield* Ref.get(stateRef)

    const ready = state.retryQueue.filter((r) => r.retryAt <= now)
    const pending = state.retryQueue.filter((r) => r.retryAt > now)

    if (ready.length === 0) return

    yield* Ref.update(stateRef, (s) => ({ ...s, retryQueue: pending }))

    // Fetch candidates to check eligibility
    const candidates = yield* tracker.listIssues().pipe(
      Effect.catchAll(() => Effect.succeed([] as Issue[])),
    )

    for (const entry of ready) {
      const issue = candidates.find((c) => identifier(c) === entry.id)

      if (!issue) {
        // Issue not found in active candidates — release claim
        yield* Ref.update(stateRef, (s) => {
          const claimed = new Set(s.claimed)
          claimed.delete(entry.id)
          return { ...s, claimed }
        })
        continue
      }

      // Check if issue is still active
      if (!isActiveState(issue.state, config)) {
        yield* Ref.update(stateRef, (s) => {
          const claimed = new Set(s.claimed)
          claimed.delete(entry.id)
          return { ...s, claimed }
        })
        continue
      }

      // Check concurrency slots — don't increment attempt for slot exhaustion
      const currentState = yield* Ref.get(stateRef)
      if (currentState.running.size >= config.maxConcurrent) {
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          retryQueue: [...s.retryQueue, {
            ...entry,
            retryAt: now + config.pollIntervalMs,
            error: "no available orchestrator slots",
          }],
        }))
        continue
      }

      // Re-dispatch
      yield* dispatchIssue(stateRef, pubsub, config, issue, entry.attempt, workflow, hooks, agentLayer)
    }
  })
}

// --- Backoff (Section 8.4) ---

/** Spec formula: min(10000 * 2^(attempt-1), max_retry_backoff_ms) */
function computeBackoff(attempt: number, maxBackoffMs: number): number {
  return Math.min(10_000 * Math.pow(2, attempt - 1), maxBackoffMs)
}
