# Conventions

## Language & Runtime

- **TypeScript** with `strict: true` and `noUncheckedIndexedAccess: true`.
- **Bun** runtime (>=1.0). Use `Bun.spawn` for subprocesses, `Bun.serve` for HTTP.
- **ESM only.** All imports use `.js` extensions (TypeScript + bundler resolution).
- **No Node.js-specific APIs** except `node:fs`, `node:path`, `node:util` (Bun-compatible).

## Effect Patterns

### Services
- Define services as `class Foo extends Context.Tag("Foo")<Foo, FooInterface>() {}`.
- Provide via `Layer.effect(Tag, implementation)` or `Layer.succeed(Tag, value)`.
- Compose layers in `cli.ts` only. Services never self-provide.

### Error Handling
- All domain errors extend `Data.TaggedError("ErrorName")`.
- Use `Effect.try` / `Effect.tryPromise` at system boundaries (fs, subprocess, JSON parse).
- Side-effect failures (logging, comments) use `Effect.catchAll(() => Effect.void)` — never block the main pipeline.
- Fatal errors use `Effect.die` — reserved for unrecoverable programmer errors.

### Async Operations
- Wrap `Bun.spawn` in `Effect.async` (for streams) or `Effect.tryPromise` (for one-shot results).
- Always handle the `AbortSignal` for fiber interruptibility.
- Never use raw `await` outside an `Effect.tryPromise` or `Effect.async` callback.

### State
- Use `Ref<T>` for mutable state. Never use `let` variables for shared state.
- Update with `Ref.update` (pure function). Read with `Ref.get`.

### Concurrency
- `Effect.fork` for background tasks. Returns a `Fiber` for later join/interrupt.
- `Effect.scoped` + `Effect.acquireRelease` for resource lifecycle.
- `Effect.repeat` + `Schedule` for loops. Never `while(true)` with `Effect.sleep`.

## Subprocess Safety

- **Always use argument arrays:** `Bun.spawn(["gh", "issue", "list", "--repo", repo])`.
- **Never interpolate into shell strings.** No `` `sh -c "gh issue list --repo ${repo}"` ``.
- **Exception:** Workspace hooks use `sh -c` with user-defined commands — these are operator-controlled, not user-input.

## Naming

- **Files:** kebab-case (`agent-runner.ts`, `event-bus.ts`).
- **Types/Classes:** PascalCase (`SymphonyConfig`, `WorkspaceError`).
- **Functions:** camelCase (`runAgent`, `parseWorkflow`).
- **Effect services:** PascalCase class + `Live` suffix for layer (`Config` / `ConfigLive`).
- **Error classes:** PascalCase with descriptive tag (`GhCliError`, `TemplateError`).

## Project Structure

```
src/
├── cli.ts               # Entry point (Layer 5)
├── config.ts            # Config service (Layer 1)
├── orchestrator.ts      # Poll-dispatch-retry loop (Layer 3)
├── agent-runner.ts      # Per-issue pipeline (Layer 3)
├── claude-session.ts    # Claude CLI wrapper (Layer 2)
├── event-bus.ts         # PubSub types + service (Layer 0-1)
├── workflow.ts          # WORKFLOW.md parser (Layer 2)
├── workspace.ts         # Workspace lifecycle (Layer 2)
├── prompt-builder.ts    # Liquid template renderer (Layer 2)
├── log.ts               # JSON logger layers (Layer 2)
├── github/
│   ├── issue.ts         # Issue type + parsing (Layer 0)
│   ├── client.ts        # gh CLI wrapper (Layer 2)
│   └── tracker.ts       # Tracker service (Layer 2)
└── dashboard/
    ├── tui.ts           # ANSI terminal dashboard (Layer 4)
    └── server.ts        # HTTP + SSE server (Layer 4)
```

## Adding New Code

1. **Determine the layer.** Check `docs/architecture.md` for layer rules.
2. **Define errors.** Create a `TaggedError` subclass if the module can fail.
3. **Use services.** Access Config/EventBus/Tracker via `yield* Tag`, never via import side effects.
4. **Update docs.** Add new modules to `docs/services.md`. Add new config keys to `docs/workflow-format.md`.
