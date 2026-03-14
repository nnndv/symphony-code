# Services & Modules

## Core Services (Effect Context.Tag)

### Config (`src/config.ts`)
- **Tag:** `Config`
- **Type:** `SymphonyConfig` (readonly interface)
- **Layer:** `ConfigLive(config)` — constructed from parsed WORKFLOW.md + CLI overrides
- **Key function:** `configFromWorkflow(yamlConfig, overrides)` maps YAML paths to config keys, resolves `$ENV_VAR` references
- **Fields include:** `dryRun: boolean` (simulate agent work without calling Claude)

### EventBus (`src/event-bus.ts`)
- **Tag:** `EventBus`
- **Type:** `PubSub<SymphonyEvent>`
- **Layer:** `EventBusLive` — unbounded PubSub (standalone), or `Layer.succeed(EventBus, pubsub)` to share a parent PubSub instance
- **Event types:** `PollCompleted`, `PollFailed`, `IssueDispatched`, `IssueCompleted`, `IssueFailed`, `IssueStalled`, `AgentStarted`, `AgentCompleted`, `AgentFailed`, `AgentCompletedWithoutPR`, `ClaudeMessage`, `ClaudeStatus`

### TrackerService (`src/github/tracker.ts`)
- **Tag:** `TrackerService`
- **Type:** `Tracker` interface — `listIssues()`, `getIssue(id)`, `comment(id, body)`, `close(id)`, `hasLinkedPR(id)`
- **Layer:** `TrackerLive` (requires Config)
- **Error:** `GhCliError`

## Modules

### Orchestrator (`src/orchestrator.ts`)
- **Purpose:** Poll-dispatch-retry loop. The central coordinator.
- **State:** `Ref<OrchestratorState>` — running, completed, claimed, retryQueue, tokenTotals
- **Dispatch gating:** `filterCandidates` skips issues that are running, claimed, completed, non-active, or blocked. The `completed` set prevents re-dispatch of issues that already have a linked PR.
- **Completion logic:** When an agent finishes with `hasLinkedPR: true`, the issue is added to `completed` (no retry). When `hasLinkedPR: false`, a continuation retry is scheduled instead.
- **Exports:** `startOrchestrator(workflow, hooks)` → `OrchestratorHandle`
- **Requires:** Config, EventBus, TrackerService
- **Internal functions:** `pollAndDispatch`, `reconcileRunningIssues`, `processRetries`, `filterCandidates`
- **Events published:** `PollCompleted` / `PollFailed` after each poll, `IssueDispatched` per dispatch, `IssueStalled` on stall detection

### Agent Runner (`src/agent-runner.ts`)
- **Purpose:** Full agent pipeline for a single issue.
- **Pipeline:** workspace (auto-clone) → hooks → prompt → claude → hooks → PR verification → comment → cleanup
- **Dry-run mode:** When `config.dryRun` is true, simulates work with a 2–5s delay instead of calling Claude.
- **PR verification:** After the agent finishes, checks `tracker.hasLinkedPR(id)`. The `hasLinkedPR` boolean is returned in `AgentResult` so the orchestrator can decide whether to mark the issue completed or schedule a continuation retry.
- **maxTurns:** `config.maxTurns` controls how many times the outer loop re-invokes Claude. Each Claude CLI invocation runs with unlimited turns (`maxTurns: 0`).
- **Exports:** `runAgent(issue, workflow, hooks)` → `AgentResult { result, costUsd, numTurns, hasLinkedPR, exitReason }`
- **Errors:** `WorkspaceError | TemplateError | GhCliError | Error`

### Claude Session (`src/claude-session.ts`)
- **Purpose:** Spawn and manage `claude` CLI subprocess.
- **Exports:** `runTurn(config, params)` → `TurnResult { result, costUsd, numTurns }`
- **CLI flags:** `--print --verbose --output-format stream-json` (verbose is required for stream-json with --print).
- **Prompt delivery:** Piped via stdin (not positional arg) to avoid `--allowedTools` consuming it.
- **Environment:** Strips `CLAUDECODE` env var to prevent nested session detection errors.
- **Fiber-interruptible:** Interrupting the fiber sends kill signal to the subprocess via AbortSignal.
- **Stream parsing:** Reads stdout line-by-line, parses JSON stream messages, publishes to EventBus.
- **Error handling:** Captures stderr on non-zero exit code.

### GitHub Client (`src/github/client.ts`)
- **Purpose:** Raw `gh` CLI wrapper.
- **Exports:** `listIssues(repo, labels, state)`, `getIssue(repo, number)`, `comment(repo, number, body)`, `close(repo, number)`, `listLinkedPRs(repo, issueNumber)` → `LinkedPR[]`
- **Error:** `GhCliError { code, output }`
- **Safety:** Uses argument arrays, never string interpolation.

### Issue (`src/github/issue.ts`)
- **Purpose:** Issue type definition and parsing.
- **Exports:** `Issue` interface, `fromGh(raw)`, `identifier(issue)`, `Priority` schema
- **Parsing:** `parsePriority(labels)` — P1/priority:critical → p1, etc. Default p3.
- **Parsing:** `parseBlockers(body)` — regex `blocked by #N` extraction.

### Workflow (`src/workflow.ts`)
- **Purpose:** Parse WORKFLOW.md files (YAML front matter + Liquid body).
- **Exports:** `parseWorkflow(content)`, `parseWorkflowFile(path)` → `Workflow { config, template, sourcePath }`
- **Error:** `WorkflowParseError`

### Workspace (`src/workspace.ts`)
- **Purpose:** Isolated workspace directories for each agent run.
- **Auto-clone:** When a workspace is created and `config.dryRun` is false, automatically clones the tracker repo via `gh repo clone`. Skipped in dry-run mode (creates empty directory instead).
- **Exports:** `withWorkspace(issue, hooks)` (scoped), `beforeRun(dir, issue, hooks)`, `afterRun(dir, issue, hooks)`
- **Safety:** `validatePath` — symlink guard ensures resolved path stays under workspace root.
- **Hooks:** Shell commands via `sh -c`, with `{{identifier}}`, `{{title}}`, `{{number}}` interpolation. 60s timeout.
- **Error:** `WorkspaceError`

### Prompt Builder (`src/prompt-builder.ts`)
- **Purpose:** Render Liquid templates with issue context.
- **Exports:** `render(template, issue)` → string
- **Template vars:** identifier, number, title, description, body, state, labels, assignees, url, priority, blockers, repo
- **Error:** `TemplateError`

### Log (`src/log.ts`)
- **Purpose:** JSON-line structured logging.
- **Exports:** `fileLoggerLayer(path)`, `consoleJsonLoggerLayer`, `clackLoggerLayer`
- **Format:** `{ timestamp, level, message }` per line

### `src/ui.ts`

Thin wrapper over `@clack/prompts`. Exports a single `ui` object with `intro`, `outro`, `cancel`, `info`, `success`, `warn`, `error`, and `spinner`. No Effect dependency — safe to call anywhere including outside Effect pipelines.

### TUI Dashboard (`src/dashboard/tui.ts`)
- **Purpose:** ANSI terminal dashboard. Subscribes to EventBus, renders every 1s.
- **Alternate screen buffer:** Enters `\x1b[?1049h` on start, restores `\x1b[?1049l` on exit (via Effect finalizer) to avoid polluting terminal scrollback history.
- **Shows:** Running agents (number, title, duration), retry queue, recent completions, cost/turn totals.

### Terminal Log (`src/dashboard/terminal-log.ts`)
- **Purpose:** Event log for `--no-tui` mode. Subscribes to EventBus, outputs via `ui` (clack).
- **Exports:** `startTerminalLog()` → `Effect<void, never, EventBus | Config>`
- **Logs:** GitHub connection status (first poll success/failure), dispatches, completions, failures, stalls.
- **Verbose mode (`--verbose`):** When enabled, also logs `ClaudeMessage` events (extracted text + tool names, truncated to 200 chars) and `ClaudeStatus` events, prefixed with the session ID.
- **Skips (default):** ClaudeMessage, ClaudeStatus, AgentStarted, AgentCompleted.

### HTTP Dashboard (`src/dashboard/server.ts`)
- **Purpose:** Web dashboard + API. Shows repo name under heading.
- **Config:** `idleTimeout: 0` on `Bun.serve` to prevent SSE connection timeouts.
- **Signature:** `startServer(port, repo, orchestratorState, refreshFn)`
- **Routes:**
  - `GET /` — Static HTML dashboard (shows repo name)
  - `GET /api/v1/state` — JSON state snapshot (includes `repo` field)
  - `POST /api/v1/refresh` — Trigger immediate poll
  - `GET /api/v1/events` — SSE event stream
