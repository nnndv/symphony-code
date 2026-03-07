# Symphony

Claude-powered issue orchestrator. Polls GitHub Issues, creates isolated workspaces, and runs AI coding agents to autonomously resolve issues.

## Architecture

- **Bun + Effect** — Runtime, orchestrator, concurrency (Fiber, PubSub, Ref, Schedule)
- **Claude CLI** — Agent execution via `claude --print --output-format stream-json`
- **GitHub CLI** — Issue tracking via `gh`
- **SSE + Static HTML** — Web dashboard (no framework, no build step)

See [AGENTS.md](AGENTS.md) for the full agent-oriented project guide, or browse [docs/](docs/) for deep dives.

## Prerequisites

- Bun 1.0+
- `gh` CLI (authenticated)
- `claude` CLI, authenticated via one of:
  - `ANTHROPIC_API_KEY` environment variable (API key billing)
  - `claude auth login` (Claude Pro/Max subscription)

## Setup

```bash
bun install
```

## Usage

Create a `WORKFLOW.md` (see the included example), then:

```bash
bun run src/cli.ts ./WORKFLOW.md
```

This will:
1. Parse the workflow config and Liquid prompt template
2. Poll GitHub for issues with the configured labels
3. Dispatch Claude agents for each issue (up to `max_concurrent_agents`)
4. Post results as comments on the issues
5. Serve a web dashboard at `http://localhost:4000`
6. Display an ANSI terminal dashboard

### Options

```
symphony-code <workflow.md> [options]

--port, -p PORT   HTTP port for web dashboard (default: 4000)
--no-tui          Disable the terminal dashboard
--help, -h        Show help message
```

## API

```
GET  /api/v1/state    — Current orchestrator state (JSON)
POST /api/v1/refresh  — Trigger immediate poll
GET  /api/v1/events   — SSE event stream
```

## Verification

```bash
bun run typecheck     # tsc --noEmit
```

## WORKFLOW.md Format

YAML front matter between `---` markers + Liquid template body. Full spec in [docs/workflow-format.md](docs/workflow-format.md).

```yaml
---
tracker:
  repo: owner/repo
  labels: ["symphony"]

agent:
  max_concurrent_agents: 5
  max_turns: 20

claude:
  model: claude-sonnet-4-5-20250929
  permission_mode: acceptEdits
  allowed_tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
---

You are working on issue #{{identifier}}: {{title}}
{{description}}
```

## Project Structure

```
src/
├── cli.ts               # Entry point — arg parsing, layer composition
├── config.ts            # Config service (Effect Layer)
├── orchestrator.ts      # Poll-dispatch-retry loop
├── agent-runner.ts      # Per-issue agent pipeline
├── claude-session.ts    # Claude CLI subprocess wrapper
├── event-bus.ts         # PubSub event types + service
├── workflow.ts          # WORKFLOW.md parser
├── workspace.ts         # Workspace lifecycle + hooks
├── prompt-builder.ts    # Liquid template renderer
├── log.ts               # JSON structured logger
├── github/
│   ├── issue.ts         # Issue type + gh JSON parsing
│   ├── client.ts        # gh CLI wrapper
│   └── tracker.ts       # Tracker service
└── dashboard/
    ├── tui.ts           # ANSI terminal dashboard
    └── server.ts        # HTTP + SSE web dashboard
```
