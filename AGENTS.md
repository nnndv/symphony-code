# Symphony — Agent Guide

Symphony is a Claude-powered GitHub issue orchestrator. It polls GitHub Issues, dispatches AI coding agents to resolve them, and reports results back as PR comments.

## Quick Orientation

- **Runtime:** Bun + Effect (TypeScript). No Node.js, no Elixir.
- **Entry point:** `src/cli.ts` — parses args, composes layers, runs the orchestrator.
- **Config:** YAML front matter in a `WORKFLOW.md` file. See `docs/workflow-format.md`.
- **External deps:** `gh` CLI (GitHub), `claude` CLI (Anthropic). Both must be on `$PATH`.

## Architecture Map

```
src/cli.ts → src/orchestrator.ts → src/agent-runner.ts → src/claude-session.ts
                    ↓                       ↓
            src/github/tracker.ts    src/workspace.ts
            src/github/client.ts     src/prompt-builder.ts
            src/github/issue.ts
                    ↓
            src/event-bus.ts → src/dashboard/tui.ts
                             → src/dashboard/server.ts
```

Dependency layers flow **inward only:** Types → Config → Services → Orchestrator → CLI.
Do not import from outer layers into inner layers. See `docs/architecture.md`.

## Key Constraints

1. **Effect everywhere.** All async/fallible operations return `Effect`. No raw Promises outside `Effect.tryPromise` or `Effect.async` boundaries.
2. **Services via Context.Tag.** Config, EventBus, and TrackerService are Effect services injected via Layers — never imported as singletons.
3. **Errors are typed.** Use `Data.TaggedError` subclasses (e.g., `GhCliError`, `WorkspaceError`). Never throw untyped errors.
4. **Subprocess isolation.** `gh` and `claude` are spawned via `Bun.spawn`. Never shell out with string interpolation — always use argument arrays.
5. **Workspace safety.** Symlink guard in `workspace.ts` prevents path traversal. Never bypass `validatePath`.

## Documentation Index

| Document | What it covers |
|---|---|
| `docs/architecture.md` | System layers, data flow, dependency rules, Effect patterns |
| `docs/services.md` | Every service and module — purpose, API, error types |
| `docs/conventions.md` | Code style, Effect idioms, error handling, naming |
| `docs/workflow-format.md` | WORKFLOW.md spec — YAML config keys, Liquid template vars |
| `docs/testing.md` | Test strategy, how to run, what to verify |

## Common Tasks

- **Add a new config key:** `src/config.ts` (interface + default + mapping) → `docs/workflow-format.md`
- **Add a new event type:** `src/event-bus.ts` (union member) → consumers in `tui.ts`, `server.ts`
- **Change agent behavior:** `src/agent-runner.ts` (pipeline) → `src/claude-session.ts` (CLI args)
- **Add an API endpoint:** `src/dashboard/server.ts` (route handler in `fetch`)

## Running

```bash
bun run src/cli.ts ./WORKFLOW.md              # default port 4000
bun run src/cli.ts ./WORKFLOW.md --port 8080  # custom port
bun run src/cli.ts ./WORKFLOW.md --no-tui     # headless mode
```

## Verification

```bash
bun run typecheck     # tsc --noEmit
```
