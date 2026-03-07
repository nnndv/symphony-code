# Clack UI Design

**Date:** 2026-03-06
**Status:** Approved

## Problem

The CLI currently outputs raw JSON logs and bare `console.error` calls. There is no startup framing, no visual feedback during loading, and fatal errors surface as unformatted Effect Cause objects.

## Approach

Approach A: standalone `src/ui.ts` module + `clackLoggerLayer` Effect Logger.

- `src/ui.ts` wraps `@clack/prompts` with no Effect dependency — usable anywhere including outside Effect pipelines.
- `clackLoggerLayer` in `log.ts` plugs into Effect's Logger system for no-tui runtime output.
- `cli.ts` uses both: the `ui` module directly for startup framing and errors, the logger layer for ongoing structured output.

## Components

### `src/ui.ts` (new)

Exports a single `ui` object:

```typescript
export const ui = {
  intro:   ()    => clack.intro("Symphony"),
  outro:   (msg) => clack.outro(msg),
  cancel:  (msg) => clack.cancel(msg),
  info:    (msg) => clack.log.info(msg),
  success: (msg) => clack.log.success(msg),
  warn:    (msg) => clack.log.warn(msg),
  error:   (msg) => clack.log.error(msg),
  spinner: ()    => clack.spinner(),
}
```

No Effect types in this file. Stays in the innermost layer so anything can import it without creating circular dependencies.

### `src/log.ts` (updated)

New export `clackLoggerLayer`: an Effect Logger layer that maps log levels to `clack.log.*` calls.

| Effect level | clack call |
|---|---|
| Info | `clack.log.info()` |
| Warning | `clack.log.warn()` |
| Error / Fatal | `clack.log.error()` |
| Debug | `clack.log.info()` with `[debug]` prefix |

### `src/cli.ts` (updated)

Startup sequence:

```
ui.intro()
spinner.start("Loading…")
  validateEnv()
  parseWorkflowFile()
  configFromWorkflow()
  startOrchestrator()
  startServer()
spinner.stop("Ready")
→ TUI mode: TUI takes over (clears screen)
→ no-tui: ui.info("Dashboard: http://..."), ui.info("Press Ctrl+C to stop")
```

Fatal error handler replaces `console.error("Fatal error:", cause)` with `ui.cancel(reason)`.

Logger selection:
- TUI mode: existing `fileLoggerLayer` (unchanged)
- No-tui mode: `clackLoggerLayer` (new)

## Files Changed

| File | Change |
|---|---|
| `package.json` | add `@clack/prompts` dependency |
| `src/ui.ts` | new — `ui` object and spinner |
| `src/log.ts` | add `clackLoggerLayer` |
| `src/cli.ts` | use `ui.intro`, spinner, `ui.cancel` for errors, select logger by mode |
