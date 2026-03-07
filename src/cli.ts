#!/usr/bin/env bun
import { Effect, Layer, Fiber } from "effect"
import { parseArgs } from "node:util"
import { Config, ConfigLive, configFromWorkflow, defaultConfig, validateEnv } from "./config.js"
import { EventBus, EventBusLive } from "./event-bus.js"
import { TrackerService, TrackerLive } from "./github/tracker.js"
import { parseWorkflowFile } from "./workflow.js"
import { startOrchestrator } from "./orchestrator.js"
import { startTui } from "./dashboard/tui.js"
import { startServer } from "./dashboard/server.js"
import { fileLoggerLayer, consoleJsonLoggerLayer } from "./log.js"

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string", short: "p" },
    "no-tui": { type: "boolean" },
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

const program = Effect.gen(function* () {
  yield* validateEnv()

  // Parse workflow
  const workflow = yield* parseWorkflowFile(workflowPath)

  // Build config from workflow + CLI overrides
  const config = configFromWorkflow(workflow.config, {
    ...(port !== undefined ? { httpPort: port } : {}),
    tui: !noTui,
  })

  if (!config.trackerRepo) {
    yield* Effect.die("Missing tracker.repo in workflow config")
  }

  yield* Effect.logInfo(`Symphony starting`)
  yield* Effect.logInfo(`Workflow: ${workflowPath}`)
  yield* Effect.logInfo(`Repo: ${config.trackerRepo}`)
  yield* Effect.logInfo(`Model: ${config.model}`)

  // Build layers
  const configLayer = ConfigLive(config)
  const trackerLayer = TrackerLive.pipe(Layer.provide(configLayer))
  const appLayer = Layer.mergeAll(configLayer, EventBusLive, trackerLayer)

  // Run the orchestrator + dashboards within the layer
  const app = Effect.gen(function* () {
    const orchestrator = yield* startOrchestrator(workflow, workflow.config["hooks"] as Record<string, string> ?? {})

    // Start HTTP dashboard
    yield* Effect.fork(startServer(config.httpPort, orchestrator.state, orchestrator.refresh))

    // Start TUI if enabled
    if (config.tui) {
      yield* Effect.fork(startTui(orchestrator.state))
    } else {
      yield* Effect.logInfo(`Dashboard: http://localhost:${config.httpPort}`)
      yield* Effect.logInfo("Press Ctrl+C to stop")
    }

    // Block forever — orchestrator runs in background fiber
    yield* Effect.never
  }).pipe(Effect.provide(appLayer))

  yield* app
})

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...")
  process.exit(0)
})
process.on("SIGTERM", () => {
  process.exit(0)
})

Effect.runFork(program.pipe(
  Effect.catchAllCause((cause) => {
    console.error("Fatal error:", cause)
    return Effect.sync(() => process.exit(1))
  }),
))
