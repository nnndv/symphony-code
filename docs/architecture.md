# Architecture

## System Overview

Symphony is a poll-dispatch-retry loop. Every `poll_interval_ms`, the orchestrator fetches open GitHub issues with matching labels, filters candidates, and dispatches Claude agents to resolve them concurrently.

```
┌──────────┐     poll      ┌────────────┐    spawn    ┌──────────────┐
│  GitHub   │ ◄──────────  │Orchestrator│ ──────────► │ Agent Runner │
│  Issues   │ ──────────►  │  (Ref+Loop)│             │ (per issue)  │
└──────────┘   gh CLI      └────────────┘             └──────┬───────┘
                                 │                           │
                           ┌─────┴─────┐              ┌─────┴──────┐
                           │ Event Bus │              │  Claude    │
                           │ (PubSub)  │              │  Session   │
                           └─────┬─────┘              └────────────┘
                           ┌─────┴─────────────┐
                           │                   │
                      ┌────┴────┐        ┌─────┴─────┐
                      │  TUI    │        │HTTP + SSE │
                      │Dashboard│        │ Dashboard │
                      └─────────┘        └───────────┘
```

## Dependency Layers

Dependencies flow strictly from top to bottom. Never import upward.

```
Layer 0: Types        github/issue.ts, event-bus.ts (type definitions only)
Layer 1: Config       config.ts
Layer 2: Services     github/client.ts, github/tracker.ts, workspace.ts,
                      prompt-builder.ts, claude-session.ts, log.ts
Layer 3: Orchestrator orchestrator.ts, agent-runner.ts
Layer 4: UI           dashboard/tui.ts, dashboard/server.ts
Layer 5: Entry        cli.ts
```

**Rule:** A file may only import from its own layer or lower-numbered layers. `cli.ts` (Layer 5) may import anything. `config.ts` (Layer 1) may only import types from Layer 0. `agent-runner.ts` (Layer 3) may import services and types, but never UI or CLI.

## Effect Architecture

### Service Graph

All services are provided via Effect `Layer` composition in `cli.ts`:

```
ConfigLive(config)
  └─► TrackerLive (needs Config)
EventBusLive (standalone)
```

These are merged into a single `appLayer` and provided to the orchestrator.

### Concurrency Model

| Concern | Effect primitive | Notes |
|---|---|---|
| Orchestrator loop | `Effect.repeat` + `Schedule.spaced` | Runs tick every `pollIntervalMs` |
| Agent execution | `Effect.fork` → `Fiber` | One fiber per dispatched issue |
| Stall detection | `Fiber.interrupt` | Kills fibers exceeding `stallTimeoutMs` |
| State management | `Ref<OrchestratorState>` | Atomic, lock-free state updates |
| Event broadcast | `PubSub<SymphonyEvent>` | Unbounded; TUI and SSE subscribe |
| Workspace lifecycle | `Effect.acquireRelease` | Auto-cleanup on completion or failure |
| Subprocess cancel | `AbortSignal` on `Bun.spawn` | Fiber interrupt → process kill |

### Error Strategy

- **Typed errors:** Every failure path uses a `Data.TaggedError` subclass.
- **Retry with backoff:** Agent failures enter `retryQueue` with exponential backoff capped at `maxRetryBackoffMs`.
- **Best-effort side effects:** GitHub comments on failure are wrapped in `catchAll(() => Effect.void)` — they must not prevent cleanup.
- **Fatal errors:** Only `cli.ts` has `catchAllCause` — everything else propagates typed errors upward.

## Data Flow: Issue Lifecycle

```
1. Orchestrator.tick()
   └─ tracker.listIssues()              # gh issue list → JSON → Issue[]
   └─ filterCandidates(issues, state)   # exclude running/completed/claimed/blocked
   └─ sort by priority (p1 > p2 > p3)
   └─ take up to (maxConcurrent - running) slots

2. For each dispatched issue:
   └─ Ref.update: add to running + claimed
   └─ PubSub.publish(IssueDispatched)
   └─ Effect.fork(agentRunner)

3. AgentRunner pipeline:
   └─ withWorkspace(issue)              # mkdir, symlink guard, after_create hook
   └─ beforeRun hook
   └─ render(template, issue)           # Liquid template → prompt string
   └─ runTurn(config, params)           # spawn claude CLI, stream JSON, collect result
   └─ tracker.comment(id, result)       # post summary comment
   └─ afterRun hook
   └─ (acquireRelease cleans up workspace)

4. On completion:
   └─ Ref.update: remove from running, add to completed, accumulate costs
   └─ PubSub.publish(IssueCompleted)

5. On failure:
   └─ Ref.update: remove from running, add to retryQueue with backoff
   └─ PubSub.publish(IssueFailed)
   └─ Best-effort error comment on issue
```

## External Dependencies

| Tool | Purpose | Required |
|---|---|---|
| `bun` | Runtime (>=1.0) | Yes |
| `gh` | GitHub CLI for issue CRUD | Yes |
| `claude` | Anthropic CLI for agent execution | Yes |
| `ANTHROPIC_API_KEY` | Env var inherited by claude subprocess | Yes |
