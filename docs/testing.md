# Testing

## Current State

Symphony is in active development. The test infrastructure is not yet in place.

## Verification

The only available check today:

```bash
bun run typecheck     # tsc --noEmit — verifies all types compile
```

## Test Strategy (Planned)

### Unit Tests

Use `bun:test` (built-in Bun test runner).

**Priority targets:**
1. `workflow.ts` — YAML parsing, front matter splitting, edge cases (no delimiters, empty body)
2. `github/issue.ts` — `fromGh` parsing, `parsePriority`, `parseBlockers`
3. `config.ts` — `configFromWorkflow` mapping, `$ENV_VAR` resolution, defaults
4. `prompt-builder.ts` — Liquid rendering with all template variables

**Effect testing pattern:**
```typescript
import { Effect } from "effect"
import { expect, test } from "bun:test"

test("parseWorkflow splits front matter", async () => {
  const result = await Effect.runPromise(parseWorkflow("---\nfoo: bar\n---\nhello"))
  expect(result.config).toEqual({ foo: "bar" })
  expect(result.template).toBe("hello")
})
```

### Integration Tests

These require `gh` and `claude` CLIs. Use test doubles:
- Mock `gh` via a shell script in `$PATH` that returns canned JSON
- Mock `claude` similarly, returning stream-json output

**Priority targets:**
1. `github/client.ts` — verify argument construction, JSON parsing
2. `claude-session.ts` — verify stream parsing, abort handling
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
ANTHROPIC_API_KEY=sk-... bun run src/cli.ts ./WORKFLOW.md

# 3. Verify
# - TUI shows the issue dispatched
# - Agent runs and posts a comment
# - Issue appears in "completed" after agent finishes
```
