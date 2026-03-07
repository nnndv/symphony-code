# Services & Modules

## Core Services (Effect Context.Tag)

### Config (`src/config.ts`)
- **Tag:** `Config`
- **Type:** `SymphonyConfig` (readonly interface)
- **Layer:** `ConfigLive(config)` — constructed from parsed WORKFLOW.md + CLI overrides
- **Key function:** `configFromWorkflow(yamlConfig, overrides)` maps YAML paths to config keys, resolves `$ENV_VAR` references

### EventBus (`src/event-bus.ts`)
- **Tag:** `EventBus`
- **Type:** `PubSub<SymphonyEvent>`
- **Layer:** `EventBusLive` — unbounded PubSub
- **Event types:** `IssueDispatched`, `IssueCompleted`, `IssueFailed`, `AgentStarted`, `AgentCompleted`, `AgentFailed`, `ClaudeMessage`, `ClaudeStatus`

### TrackerService (`src/github/tracker.ts`)
- **Tag:** `TrackerService`
- **Type:** `Tracker` interface — `listIssues()`, `getIssue(id)`, `comment(id, body)`, `close(id)`
- **Layer:** `TrackerLive` (requires Config)
- **Error:** `GhCliError`

## Modules

### Orchestrator (`src/orchestrator.ts`)
- **Purpose:** Poll-dispatch-retry loop. The central coordinator.
- **State:** `Ref<OrchestratorState>` — running, completed, claimed, retryQueue, tokenTotals
- **Exports:** `startOrchestrator(workflow, hooks)` → `OrchestratorHandle`
- **Requires:** Config, EventBus, TrackerService
- **Internal functions:** `pollAndDispatch`, `checkStalls`, `processRetries`, `filterCandidates`

### Agent Runner (`src/agent-runner.ts`)
- **Purpose:** Full agent pipeline for a single issue.
- **Pipeline:** workspace → hooks → prompt → claude → comment → cleanup
- **Exports:** `runAgent(issue, workflow, hooks)` → `AgentResult`
- **Errors:** `WorkspaceError | TemplateError | GhCliError | Error`

### Claude Session (`src/claude-session.ts`)
- **Purpose:** Spawn and manage `claude` CLI subprocess.
- **Exports:** `runTurn(config, params)` → `TurnResult { result, costUsd, numTurns }`
- **Fiber-interruptible:** Interrupting the fiber sends kill signal to the subprocess via AbortSignal.
- **Stream parsing:** Reads stdout line-by-line, parses JSON stream messages, publishes to EventBus.

### GitHub Client (`src/github/client.ts`)
- **Purpose:** Raw `gh` CLI wrapper.
- **Exports:** `listIssues(repo, labels, state)`, `getIssue(repo, number)`, `comment(repo, number, body)`, `close(repo, number)`
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
- **Exports:** `fileLoggerLayer(path)`, `consoleJsonLoggerLayer`
- **Format:** `{ timestamp, level, message }` per line

### TUI Dashboard (`src/dashboard/tui.ts`)
- **Purpose:** ANSI terminal dashboard. Subscribes to EventBus, renders every 1s.
- **Shows:** Running agents (number, title, duration), retry queue, recent completions, cost/turn totals.

### HTTP Dashboard (`src/dashboard/server.ts`)
- **Purpose:** Web dashboard + API.
- **Routes:**
  - `GET /` — Static HTML dashboard
  - `GET /api/v1/state` — JSON state snapshot
  - `POST /api/v1/refresh` — Trigger immediate poll
  - `GET /api/v1/events` — SSE event stream
