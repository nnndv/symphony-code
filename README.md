# Symphony

Claude-powered issue orchestrator. Polls GitHub Issues, creates isolated workspaces, and runs AI coding agents to autonomously resolve issues.

## Architecture

- **Elixir/OTP** — Orchestrator, supervisors, PubSub, Phoenix web dashboard
- **Node.js worker** (Bun) — Bridges Elixir to Claude CLI via JSON-RPC over stdio
- **GitHub Issues** — Issue tracker via `gh` CLI

## Prerequisites

- Elixir 1.15+ / OTP 26+
- Bun 1.0+
- `gh` CLI (authenticated)
- `ANTHROPIC_API_KEY` environment variable

## Setup

```bash
# Elixir deps
cd elixir && mix deps.get

# Node worker deps
cd ../node-worker && bun install
```

## Usage

Create a `WORKFLOW.md` (see `elixir/WORKFLOW.md` for example), then:

```bash
cd elixir
mix symphony.run --workflow ../WORKFLOW.md --port 4000
```

This will:
1. Parse the workflow config
2. Start the Node worker bridge
3. Poll GitHub for issues with the configured labels
4. Dispatch Claude agents for each issue
5. Post results as comments on the issues
6. Serve a web dashboard at `http://localhost:4000`

### Options

```
--workflow PATH   Path to WORKFLOW.md (required)
--port PORT       HTTP port (default: 4000)
--no-tui          Disable terminal dashboard
```

## API

```
GET  /api/v1/state    — Current orchestrator state
POST /api/v1/refresh  — Trigger immediate poll
```

## Tests

```bash
cd elixir && mix test
cd ../node-worker && bun run typecheck
```

## WORKFLOW.md Format

YAML front matter between `---` markers + Liquid template body:

```yaml
---
tracker:
  repo: owner/repo
  labels: ["symphony"]

claude:
  model: claude-sonnet-4-5-20250929
  permission_mode: acceptEdits
  allowed_tools: ["Read", "Write", "Edit", "Bash"]
---

You are working on issue #{{identifier}}: {{title}}
{{description}}
```
