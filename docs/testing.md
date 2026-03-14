# Testing

## Running Tests

```bash
bun test              # unit + integration tests (dry-run, no API calls)
bun run typecheck     # tsc --noEmit — type-check src/ and test/
E2E=1 bun test test/e2e.test.ts  # real GitHub + Claude (creates issues, costs money)
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
| `src/orchestrator.ts` | `test/orchestrator.test.ts` | Full event lifecycle, maxConcurrent limit, state tracking, skip claimed issues, filter non-active issues, event ordering, priority ordering (7 tests, uses in-memory tracker + dry-run) |
| End-to-end | `test/e2e.test.ts` | Real GitHub + real Claude e2e test. Creates issue, runs orchestrator, verifies events + comment posted + PR created. Gated by `E2E=1` env var. |

## Test Strategy

### Unit Tests (priority order)

1. `config.ts` — `configFromWorkflow` mapping, `$ENV_VAR` resolution, `validateEnv`
2. `workflow.ts` — YAML parsing, front matter splitting, edge cases
3. `github/issue.ts` — `fromGh` parsing, `parsePriority`, `parseBlockers`
4. `prompt-builder.ts` — Liquid rendering with all template variables

### Integration Tests (`test/orchestrator.test.ts`)

Uses an in-memory tracker and `dryRun: true` to test the full orchestration loop without external dependencies. Verifies event lifecycle, concurrency limits, state transitions, priority ordering, and candidate filtering.

### End-to-End Tests (`test/e2e.test.ts`)

Requires `gh` CLI (authenticated), `claude` CLI, and a real GitHub repo. Gated by `E2E=1` environment variable. Creates a unique label per test run for isolation. Verifies the full flow: issue creation → agent dispatch → Claude execution → git push → PR creation → comment posted → issue completed.

- **Config source:** Reads from `WORKFLOW-E2E-TEST.md` at repo root via `parseWorkflowFile` + `configFromWorkflow`, with test-specific overrides (unique label, temp workspace, no TUI)
- Timeouts: 300s event wait, 360s test timeout
- Cleanup: closes issue, deletes label, removes workspace

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

# 2. Run Symphony (with dry-run for quick orchestration testing)
bun run src/cli.ts ./WORKFLOW.md --no-tui --dry-run

# 3. Run for real
bun run src/cli.ts ./WORKFLOW.md

# 4. Verify
# - TUI shows the issue dispatched (uses alternate screen buffer, no history pollution)
# - Agent runs, creates a branch, pushes, and opens a PR
# - Agent posts a summary comment on the issue (status shows "Completed" if PR found)
# - If PR was created: issue moves to "completed", not re-dispatched
# - If no PR was created: issue gets a continuation retry (re-dispatched after 1s)
```
