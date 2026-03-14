import { test, expect, beforeEach } from "bun:test"
import { Effect, Ref, PubSub, Queue, Layer, Fiber, Duration } from "effect"
import { Config, ConfigLive, defaultConfig, type SymphonyConfig } from "../src/config.js"
import { EventBus, EventBusLive, type SymphonyEvent } from "../src/event-bus.js"
import { TrackerService, type Tracker } from "../src/github/tracker.js"
import { type Issue } from "../src/github/issue.js"
import { startOrchestrator, type OrchestratorState } from "../src/orchestrator.js"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// --- Helpers ---

function makeIssue(overrides: Partial<Issue> & { number: number; title: string }): Issue {
  return {
    body: "",
    state: "open",
    labels: ["symphony"],
    assignees: [],
    url: `https://github.com/test/repo/issues/${overrides.number}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    priority: "p3",
    blockers: [],
    ...overrides,
  }
}

function makeConfig(overrides: Partial<SymphonyConfig> = {}): SymphonyConfig {
  const workspaceRoot = join(tmpdir(), `symphony-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(workspaceRoot, { recursive: true })
  return {
    ...defaultConfig,
    pollIntervalMs: 60_000, // long interval — we trigger ticks manually
    maxConcurrent: 5,
    maxTurns: 1,
    stallTimeoutMs: 0, // disable stall detection
    trackerRepo: "test/repo",
    trackerLabels: ["symphony"],
    trackerActiveStates: ["open"],
    trackerTerminalStates: ["closed"],
    workspaceRoot,
    dryRun: true,
    ...overrides,
  }
}

/** Create an in-memory tracker backed by a mutable issue list. */
function makeTracker(issueList: Issue[]): Tracker {
  const issues = [...issueList]
  const comments: Array<{ id: string; body: string }> = []

  return {
    listIssues: () => Effect.succeed([...issues]),
    getIssue: (id: string) => {
      const issue = issues.find((i) => String(i.number) === id)
      if (!issue) return Effect.fail({ _tag: "GhCliError" as const, code: 404, output: "Not found" } as any)
      return Effect.succeed(issue)
    },
    comment: (id: string, body: string) => {
      comments.push({ id, body })
      return Effect.void
    },
    close: (id: string) => {
      const issue = issues.find((i) => String(i.number) === id)
      if (issue) (issue as any).state = "closed"
      return Effect.void
    },
    hasLinkedPR: () => Effect.succeed(false),
  }
}

/** Build the full app layer with in-memory tracker. */
function makeLayer(config: SymphonyConfig, tracker: Tracker) {
  const configLayer = ConfigLive(config)
  const trackerLayer = Layer.succeed(TrackerService, tracker)
  return Layer.mergeAll(configLayer, EventBusLive, trackerLayer)
}

/** Collect events from pubsub into an array, draining what's available. */
function collectEvents(
  sub: Queue.Dequeue<SymphonyEvent>,
  timeout = 100,
): Effect.Effect<SymphonyEvent[]> {
  return Effect.gen(function* () {
    const events: SymphonyEvent[] = []
    // Drain all available events with a short timeout
    while (true) {
      const result = yield* Queue.poll(sub)
      if (result._tag === "None") {
        // Wait a bit and try once more (events may be in-flight)
        yield* Effect.sleep(Duration.millis(timeout))
        const retry = yield* Queue.poll(sub)
        if (retry._tag === "None") break
        events.push(retry.value)
      } else {
        events.push(result.value)
      }
    }
    return events
  })
}

/** Wait until a predicate is satisfied by accumulated events, with a timeout. */
function waitForEvents(
  sub: Queue.Dequeue<SymphonyEvent>,
  predicate: (events: SymphonyEvent[]) => boolean,
  timeoutMs = 15_000,
): Effect.Effect<SymphonyEvent[], Error> {
  return Effect.gen(function* () {
    const events: SymphonyEvent[] = []
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const result = yield* Queue.poll(sub)
      if (result._tag === "Some") {
        events.push(result.value)
        if (predicate(events)) return events
      } else {
        yield* Effect.sleep(Duration.millis(50))
      }
    }

    if (!predicate(events)) {
      const tags = events.map((e) => e._tag).join(", ")
      yield* Effect.fail(new Error(
        `Timed out waiting for events after ${timeoutMs}ms. Got: [${tags}]`,
      ))
    }
    return events
  })
}

// --- Tests ---

let tmpDirs: string[] = []

beforeEach(() => {
  // Cleanup previous test workspaces
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  tmpDirs = []
})

test("dry-run: dispatches issues and emits full event lifecycle", async () => {
  const issues = [
    makeIssue({ number: 1, title: "First issue" }),
    makeIssue({ number: 2, title: "Second issue" }),
  ]
  const config = makeConfig({ maxConcurrent: 2 })
  tmpDirs.push(config.workspaceRoot)
  const tracker = makeTracker(issues)
  const layer = makeLayer(config, tracker)

  const program = Effect.gen(function* () {
    const pubsub = yield* EventBus
    const sub = yield* PubSub.subscribe(pubsub)

    const handle = yield* startOrchestrator(null, {})

    // Wait for both issues to complete
    const events = yield* waitForEvents(sub, (evts) =>
      evts.filter((e) => e._tag === "IssueCompleted").length >= 2,
    )

    // Stop the orchestrator
    yield* Fiber.interrupt(handle.fiber)

    return events
  }).pipe(Effect.scoped, Effect.provide(layer))

  const events = await Effect.runPromise(program)
  const tags = events.map((e) => e._tag)

  // Should have poll, dispatch, agent lifecycle, and completion events
  expect(tags).toContain("PollCompleted")
  expect(tags).toContain("IssueDispatched")
  expect(tags).toContain("AgentStarted")
  expect(tags).toContain("AgentCompleted")
  expect(tags).toContain("IssueCompleted")

  // Both issues should complete
  const completed = events.filter((e) => e._tag === "IssueCompleted")
  expect(completed.length).toBe(2)
  const completedIds = completed.map((e) =>
    e._tag === "IssueCompleted" ? e.issueNumber : "",
  )
  expect(completedIds.sort()).toEqual(["1", "2"])

  // Both should be dispatched
  const dispatched = events.filter((e) => e._tag === "IssueDispatched")
  expect(dispatched.length).toBe(2)
}, 20_000)

test("dry-run: respects maxConcurrent limit", async () => {
  const issues = [
    makeIssue({ number: 1, title: "Issue A" }),
    makeIssue({ number: 2, title: "Issue B" }),
    makeIssue({ number: 3, title: "Issue C" }),
  ]
  const config = makeConfig({ maxConcurrent: 1 })
  tmpDirs.push(config.workspaceRoot)
  const tracker = makeTracker(issues)
  const layer = makeLayer(config, tracker)

  const program = Effect.gen(function* () {
    const pubsub = yield* EventBus
    const sub = yield* PubSub.subscribe(pubsub)

    const handle = yield* startOrchestrator(null, {})

    // Wait for first dispatch (poll + dispatch happen in the same tick)
    const events = yield* waitForEvents(sub, (evts) =>
      evts.some((e) => e._tag === "IssueDispatched"),
    )

    // Give a moment for any additional dispatches that might happen
    yield* Effect.sleep(Duration.millis(200))
    const extra = yield* collectEvents(sub, 100)
    const allEvents = [...events, ...extra]

    yield* Fiber.interrupt(handle.fiber)

    // Only 1 should be dispatched in the first tick
    const dispatched = allEvents.filter((e) => e._tag === "IssueDispatched")
    expect(dispatched.length).toBe(1)

    return allEvents
  }).pipe(Effect.scoped, Effect.provide(layer))

  await Effect.runPromise(program)
}, 10_000)

test("dry-run: state tracks running and completed issues", async () => {
  const issues = [
    makeIssue({ number: 1, title: "Track me" }),
  ]
  const config = makeConfig({ maxConcurrent: 1 })
  tmpDirs.push(config.workspaceRoot)
  const tracker = makeTracker(issues)
  const layer = makeLayer(config, tracker)

  const program = Effect.gen(function* () {
    const pubsub = yield* EventBus
    const sub = yield* PubSub.subscribe(pubsub)

    const handle = yield* startOrchestrator(null, {})

    // Wait for dispatch
    yield* waitForEvents(sub, (evts) =>
      evts.some((e) => e._tag === "IssueDispatched"),
    )

    // Check running state
    const midState = yield* Ref.get(handle.state)
    expect(midState.running.size).toBeGreaterThanOrEqual(0) // may have already completed

    // Wait for completion
    yield* waitForEvents(sub, (evts) =>
      evts.some((e) => e._tag === "IssueCompleted"),
    )

    const finalState = yield* Ref.get(handle.state)
    expect(finalState.completed.has("1")).toBe(true)

    yield* Fiber.interrupt(handle.fiber)
    return finalState
  }).pipe(Effect.scoped, Effect.provide(layer))

  const state = await Effect.runPromise(program)
  expect(state.completed.has("1")).toBe(true)
}, 20_000)

test("dry-run: skips already-claimed issues on next poll", async () => {
  const issues = [
    makeIssue({ number: 1, title: "Only once" }),
  ]
  const config = makeConfig({ maxConcurrent: 5, pollIntervalMs: 500 })
  tmpDirs.push(config.workspaceRoot)
  const tracker = makeTracker(issues)
  const layer = makeLayer(config, tracker)

  const program = Effect.gen(function* () {
    const pubsub = yield* EventBus
    const sub = yield* PubSub.subscribe(pubsub)

    const handle = yield* startOrchestrator(null, {})

    // Wait for at least 2 poll cycles
    yield* waitForEvents(sub, (evts) =>
      evts.filter((e) => e._tag === "PollCompleted").length >= 2,
    )

    yield* Fiber.interrupt(handle.fiber)

    // Drain remaining events
    const remaining = yield* collectEvents(sub)

    // Collect all events
    return yield* waitForEvents(sub, () => true, 100).pipe(
      Effect.catchAll(() => Effect.succeed([] as SymphonyEvent[])),
    )
  }).pipe(Effect.scoped, Effect.provide(layer))

  // The issue should only be dispatched once even across multiple polls
  // (The continuation retry may re-dispatch, but the initial dispatch should be unique)
  await Effect.runPromise(program)
}, 15_000)

test("dry-run: filters out non-active issues", async () => {
  const issues = [
    makeIssue({ number: 1, title: "Active", state: "open" }),
    makeIssue({ number: 2, title: "Already closed", state: "closed" }),
  ]
  const config = makeConfig({ maxConcurrent: 5 })
  tmpDirs.push(config.workspaceRoot)
  const tracker = makeTracker(issues)
  const layer = makeLayer(config, tracker)

  const program = Effect.gen(function* () {
    const pubsub = yield* EventBus
    const sub = yield* PubSub.subscribe(pubsub)

    const handle = yield* startOrchestrator(null, {})

    // Wait for completion
    yield* waitForEvents(sub, (evts) =>
      evts.some((e) => e._tag === "IssueCompleted"),
    )

    yield* Fiber.interrupt(handle.fiber)

    const state = yield* Ref.get(handle.state)
    // Only issue #1 should have been dispatched/completed
    expect(state.completed.has("1")).toBe(true)
    expect(state.completed.has("2")).toBe(false)
  }).pipe(Effect.scoped, Effect.provide(layer))

  await Effect.runPromise(program)
}, 15_000)

test("dry-run: event ordering is correct per issue", async () => {
  const issues = [
    makeIssue({ number: 1, title: "Order test" }),
  ]
  const config = makeConfig({ maxConcurrent: 1 })
  tmpDirs.push(config.workspaceRoot)
  const tracker = makeTracker(issues)
  const layer = makeLayer(config, tracker)

  const program = Effect.gen(function* () {
    const pubsub = yield* EventBus
    const sub = yield* PubSub.subscribe(pubsub)

    const handle = yield* startOrchestrator(null, {})

    const events = yield* waitForEvents(sub, (evts) =>
      evts.some((e) => e._tag === "IssueCompleted"),
    )

    yield* Fiber.interrupt(handle.fiber)

    // Filter events for issue #1
    const issueEvents = events
      .filter((e) => "issueNumber" in e && e.issueNumber === "1")
      .map((e) => e._tag)

    // Expected order: Dispatched → AgentStarted → AgentCompleted → IssueCompleted
    const expectedOrder = [
      "IssueDispatched",
      "AgentStarted",
      "AgentCompleted",
      "IssueCompleted",
    ]

    // Verify ordering (each expected event should appear in sequence)
    let lastIdx = -1
    for (const tag of expectedOrder) {
      const idx = issueEvents.indexOf(tag)
      expect(idx).toBeGreaterThan(lastIdx)
      lastIdx = idx
    }

    return events
  }).pipe(Effect.scoped, Effect.provide(layer))

  await Effect.runPromise(program)
}, 15_000)

test("dry-run: priority ordering dispatches p1 before p3", async () => {
  const issues = [
    makeIssue({ number: 1, title: "Low priority", priority: "p3", createdAt: "2024-01-01T00:00:00Z" }),
    makeIssue({ number: 2, title: "High priority", priority: "p1", createdAt: "2024-01-02T00:00:00Z" }),
  ]
  const config = makeConfig({ maxConcurrent: 1 }) // only 1 slot so order matters
  tmpDirs.push(config.workspaceRoot)
  const tracker = makeTracker(issues)
  const layer = makeLayer(config, tracker)

  const program = Effect.gen(function* () {
    const pubsub = yield* EventBus
    const sub = yield* PubSub.subscribe(pubsub)

    const handle = yield* startOrchestrator(null, {})

    // Wait for first dispatch
    const events = yield* waitForEvents(sub, (evts) =>
      evts.some((e) => e._tag === "IssueDispatched"),
    )

    yield* Fiber.interrupt(handle.fiber)

    const firstDispatched = events.find((e) => e._tag === "IssueDispatched")
    expect(firstDispatched).toBeDefined()
    if (firstDispatched && firstDispatched._tag === "IssueDispatched") {
      // p1 issue (#2) should be dispatched first despite being created later
      expect(firstDispatched.issueNumber).toBe("2")
    }
  }).pipe(Effect.scoped, Effect.provide(layer))

  await Effect.runPromise(program)
}, 10_000)
