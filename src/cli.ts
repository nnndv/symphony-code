#!/usr/bin/env bun
import { Effect, Layer, Cause } from "effect"
import { parseArgs } from "node:util"
import { ConfigLive, configFromWorkflow, validateEnv } from "./config.js"
import { EventBusLive } from "./event-bus.js"
import { TrackerLive } from "./github/tracker.js"
import { parseWorkflowFile } from "./workflow.js"
import { startOrchestrator } from "./orchestrator.js"
import { startTui } from "./dashboard/tui.js"
import { startTerminalLog } from "./dashboard/terminal-log.js"
import { startServer } from "./dashboard/server.js"
import { ui } from "./ui.js"
import { clackLoggerLayer } from "./log.js"

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string", short: "p" },
    "no-tui": { type: "boolean", short: "n" },
    verbose: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
  strict: false,
})

if (values["help"] || positionals.length === 0) {
  console.log(`
Usage: symphony-code <workflow.md> [options]

Options:
  --port, -p PORT   HTTP port for web dashboard (default: 4000)
  --no-tui          Disable the terminal dashboard
  --verbose, -v     Show Claude agent output stream
  --help, -h        Show this help message

Environment:
  ANTHROPIC_API_KEY  Required. Your Anthropic API key.

Example:
  symphony-code ./WORKFLOW.md
  symphony-code ./WORKFLOW.md --port 8080 --no-tui
`)
  process.exit(0)
}

const workflowPath = positionals[0]!
const port = values["port"] ? Number(values["port"]) : undefined
const noTui = values["no-tui"] === true
const verbose = values["verbose"] === true

ui.intro()

const program = Effect.gen(function* () {
  const spin = ui.spinner()
  spin.start("Loading…")

  // Validate environment
  yield* validateEnv().pipe(
    Effect.tapError(() => Effect.sync(() => spin.stop("Failed")))
  )

  // Parse workflow
  const workflow = yield* parseWorkflowFile(workflowPath).pipe(
    Effect.tapError(() => Effect.sync(() => spin.stop("Failed")))
  )

  // Build config from workflow + CLI overrides
  const config = configFromWorkflow(workflow.config, {
    ...(port !== undefined ? { httpPort: port } : {}),
    tui: !noTui,
    verbose,
  })

  if (!config.trackerRepo) {
    spin.stop("Failed")
    yield* Effect.die("Missing tracker.repo in workflow config")
  }

  // Build layers
  const configLayer = ConfigLive(config)
  const trackerLayer = TrackerLive.pipe(Layer.provide(configLayer))
  const appLayer = Layer.mergeAll(configLayer, EventBusLive, trackerLayer)

  // Run orchestrator + dashboards within the layer
  const app = Effect.gen(function* () {
    const orchestrator = yield* startOrchestrator(
      workflow,
      workflow.config["hooks"] as Record<string, string> ?? {},
    )

    // Start HTTP dashboard
    yield* Effect.fork(startServer(config.httpPort, config.trackerRepo, orchestrator.state, orchestrator.refresh))

    spin.stop("Ready")

    // Start TUI if enabled
    if (config.tui) {
      yield* Effect.fork(startTui(orchestrator.state))
    } else {
      ui.info(`🚀 Dashboard ready at: http://localhost:${config.httpPort}`)
      ui.info("Press Ctrl+C to stop")
      yield* Effect.fork(startTerminalLog())
    }

    // Block forever — orchestrator runs in background fiber
    yield* Effect.never
  }).pipe(Effect.provide(appLayer))

  yield* app
})

// Handle graceful shutdown
process.on("SIGINT", () => {
  ui.outro("Shutting down")
  process.exit(0)
})
process.on("SIGTERM", () => {
  process.exit(0)
})

Effect.runFork(program.pipe(
  Effect.provide(noTui ? clackLoggerLayer : Layer.empty),
  Effect.catchAllCause((cause) => {
    const err = Cause.squash(cause)
    const message = err instanceof Error
      ? ((err as unknown as Record<string, unknown>)["reason"] as string | undefined ?? err.message)
      : String(err)
    ui.cancel(message)
    return Effect.sync(() => process.exit(1))
  }),
))
