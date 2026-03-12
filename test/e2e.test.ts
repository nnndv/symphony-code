/**
 * End-to-end test: real GitHub CLI + real Claude CLI.
 *
 * Prerequisites:
 *   - `gh` authenticated with access to the test repo
 *   - Claude auth configured (ANTHROPIC_API_KEY or `claude auth login`)
 *
 * Run manually:
 *   E2E=1 bun test test/e2e.test.ts
 *
 * Skipped by default in `bun test` to avoid API costs and slow runs.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test"
import { Effect, PubSub, Queue, Layer, Fiber, Duration } from "effect"
import { ConfigLive, type SymphonyConfig, defaultConfig } from "../src/config.js"
import { EventBus, EventBusLive } from "../src/event-bus.js"
import type { SymphonyEvent } from "../src/event-bus.js"
import { TrackerLive } from "../src/github/tracker.js"
import { startOrchestrator } from "../src/orchestrator.js"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const TEST_REPO = "nnndv/symphony-code-test"
const SKIP = !process.env["E2E"]

// --- Helpers ---

let createdIssueNumber: number | null = null
let workspaceRoot: string | null = null
const E2E_LABEL = `e2e-${Date.now()}`

async function ghJson<T>(args: string[]): Promise<T> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`gh failed (${code}): ${stderr}`)
  return JSON.parse(stdout.trim()) as T
}

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`gh failed (${code}): ${stderr}`)
  return stdout.trim()
}

function waitForEvents(
  sub: Queue.Dequeue<SymphonyEvent>,
  predicate: (events: SymphonyEvent[]) => boolean,
  timeoutMs = 120_000,
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
        yield* Effect.sleep(Duration.millis(200))
      }
    }

    if (!predicate(events)) {
      const tags = events.map((e) => e._tag).join(", ")
      yield* Effect.fail(new Error(
        `Timed out after ${timeoutMs}ms. Events: [${tags}]`,
      ))
    }
    return events
  })
}

describe("e2e: real GitHub + real Claude", () => {
  beforeAll(async () => {
    if (SKIP) return

    // Create a unique label for this test run so we only pick up our issue
    await gh([
      "label", "create", E2E_LABEL,
      "--repo", TEST_REPO,
      "--description", "Temporary e2e test label",
      "--force",
    ])

    // Create a test issue with a trivial task
    const url = await gh([
      "issue", "create",
      "--repo", TEST_REPO,
      "--title", `[e2e-test] Create a hello.txt file (${Date.now()})`,
      "--body", "Create a file called `hello.txt` in the repo root with the content `Hello from Symphony e2e test`. That's it — nothing else.",
      "--label", E2E_LABEL,
    ])
    // gh issue create prints the URL, e.g. https://github.com/owner/repo/issues/42
    const match = url.match(/\/issues\/(\d+)/)
    if (!match) throw new Error(`Could not parse issue number from: ${url}`)
    createdIssueNumber = Number(match[1])
    console.log(`Created test issue #${createdIssueNumber}`)
  })

  afterAll(async () => {
    if (SKIP) return

    // Close and clean up the test issue
    if (createdIssueNumber) {
      await gh([
        "issue", "close",
        "--repo", TEST_REPO,
        String(createdIssueNumber),
        "--comment", "Closed by e2e test cleanup.",
      ]).catch(() => {})
      console.log(`Closed test issue #${createdIssueNumber}`)
    }

    // Delete the temporary label
    await gh([
      "label", "delete", E2E_LABEL,
      "--repo", TEST_REPO,
      "--yes",
    ]).catch(() => {})

    // Clean up workspace
    if (workspaceRoot) {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  test.skipIf(SKIP)("full orchestration lifecycle", async () => {
    expect(createdIssueNumber).not.toBeNull()

    workspaceRoot = join(tmpdir(), `symphony-e2e-${Date.now()}`)
    mkdirSync(workspaceRoot, { recursive: true })

    const config: SymphonyConfig = {
      ...defaultConfig,
      pollIntervalMs: 60_000, // manual tick
      maxConcurrent: 1,
      maxTurns: 3,
      stallTimeoutMs: 0,
      trackerRepo: TEST_REPO,
      trackerLabels: [E2E_LABEL],
      trackerActiveStates: ["open"],
      trackerTerminalStates: ["closed"],
      workspaceRoot,
      model: "claude-sonnet-4-5-20250929",
      permissionMode: "bypassPermissions",
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      dryRun: false,
      httpPort: 0, // unused in test
      tui: false,
      verbose: false,
      logFile: null,
    }

    const configLayer = ConfigLive(config)
    const trackerLayer = TrackerLive.pipe(Layer.provide(configLayer))
    const appLayer = Layer.mergeAll(configLayer, EventBusLive, trackerLayer)

    const program = Effect.gen(function* () {
      const pubsub = yield* EventBus
      const sub = yield* PubSub.subscribe(pubsub)

      const handle = yield* startOrchestrator(null, {})

      // Wait for the test issue to complete (agent finishes)
      const events = yield* waitForEvents(sub, (evts) =>
        evts.some(
          (e) =>
            e._tag === "IssueCompleted" &&
            e.issueNumber === String(createdIssueNumber),
        ),
        300_000, // 5 min — real Claude runs with git operations take time
      )

      yield* Fiber.interrupt(handle.fiber)

      return events
    }).pipe(Effect.scoped, Effect.provide(appLayer))

    const events = await Effect.runPromise(program)
    const tags = events.map((e) => e._tag)
    const issueEvents = events.filter(
      (e) => "issueNumber" in e && e.issueNumber === String(createdIssueNumber),
    )
    const issueTags = issueEvents.map((e) => e._tag)

    console.log("Event sequence:", issueTags.join(" → "))

    // Core lifecycle events must be present
    expect(tags).toContain("PollCompleted")
    expect(issueTags).toContain("IssueDispatched")
    expect(issueTags).toContain("AgentStarted")
    expect(issueTags).toContain("AgentCompleted")
    expect(issueTags).toContain("IssueCompleted")

    // Verify ordering
    const expectedOrder: SymphonyEvent["_tag"][] = [
      "IssueDispatched",
      "AgentStarted",
      "AgentCompleted",
      "IssueCompleted",
    ]
    let lastIdx = -1
    for (const tag of expectedOrder) {
      const idx = issueTags.indexOf(tag)
      expect(idx).toBeGreaterThan(lastIdx)
      lastIdx = idx
    }

    // Verify state
    const completed = events.find(
      (e) => e._tag === "IssueCompleted" && e.issueNumber === String(createdIssueNumber),
    )
    expect(completed).toBeDefined()

    // Check that a comment was posted on the issue
    const issueData = await ghJson<{ comments: Array<{ body: string }> }>([
      "issue", "view",
      "--repo", TEST_REPO,
      String(createdIssueNumber),
      "--json", "comments",
    ])
    const agentComment = issueData.comments.find((c) => c.body.includes("Symphony Agent Result"))
    expect(agentComment).toBeDefined()
  }, 360_000) // 6 minute timeout for real Claude run with git operations
})
