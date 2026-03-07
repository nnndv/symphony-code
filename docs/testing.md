# Testing

## Running Tests

```bash
bun test              # run all tests
bun test test/        # explicit path (same result)
bun run typecheck     # tsc --noEmit — type-check src/ and test/
```

## Test Location

All test files live in `test/` at the project root, mirroring `src/` structure:

```
test/
  config.test.ts    → tests for src/config.ts
```

Imports from test files use relative paths into `src/`:

```typescript
import { validateEnv, ConfigError } from "../src/config.js"
```

## Effect Testing Pattern

Use `Effect.runPromiseExit` to inspect typed failures without throwing:

```typescript
import { Effect, Exit, Cause, Option } from "effect"
import { expect, test } from "bun:test"

test("fails when X is missing", async () => {
  const exit = await Effect.runPromiseExit(myEffect())
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    const error = Cause.failureOption(exit.cause)
    expect(Option.isSome(error)).toBe(true)
    if (Option.isSome(error)) {
      expect(error.value).toBeInstanceOf(MyError)
    }
  }
})
```

## Coverage

| File | Test file | What's covered |
|---|---|---|
| `src/config.ts` | `test/config.test.ts` | `validateEnv` — API key, OAuth token env var, credentials file, and no-auth failure |
| `src/ui.ts`  | `test/ui.test.ts`  | `ui` export shape |
| `src/log.ts` | `test/log.test.ts` | `clackLoggerLayer` is a valid Layer |

## Test Strategy

### Unit Tests (priority order)

1. `config.ts` — `configFromWorkflow` mapping, `$ENV_VAR` resolution, `validateEnv`
2. `workflow.ts` — YAML parsing, front matter splitting, edge cases
3. `github/issue.ts` — `fromGh` parsing, `parsePriority`, `parseBlockers`
4. `prompt-builder.ts` — Liquid rendering with all template variables

### Integration Tests

These require `gh` and `claude` CLIs. Use shell script test doubles in `$PATH` returning canned output.

1. `github/client.ts` — argument construction, JSON parsing
2. `claude-session.ts` — stream parsing, abort handling
3. `agent-runner.ts` — full pipeline with mocked externals

### What NOT to Test

- `cli.ts` — integration-tested via manual runs
- `dashboard/server.ts` — visual verification
- `dashboard/tui.ts` — visual verification
- Effect internals (Layer composition, PubSub mechanics)

## Manual Smoke Test

```bash
# 1. Create a test repo with a labeled issue
gh repo create myorg/test-symphony --public
gh issue create --repo myorg/test-symphony --title "Test issue" --label symphony

# 2. Run Symphony
# API key auth:
ANTHROPIC_API_KEY=sk-... bun run src/cli.ts ./WORKFLOW.md

# Or with subscription auth (claude auth login already done):
bun run src/cli.ts ./WORKFLOW.md

# 3. Verify
# - TUI shows the issue dispatched
# - Agent runs and posts a comment
# - Issue appears in "completed" after agent finishes
```
