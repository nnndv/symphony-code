import { Effect, Logger, LogLevel, Layer } from "effect"
import { appendFileSync } from "node:fs"
import * as clack from "@clack/prompts"

/** JSON-line structured logger that writes to a file. */
export const fileLoggerLayer = (path: string): Layer.Layer<never> =>
  Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ logLevel, message, date }) => {
      const entry = JSON.stringify({
        timestamp: date.toISOString(),
        level: logLevel.label,
        message: typeof message === "string" ? message : String(message),
      })
      try {
        appendFileSync(path, entry + "\n", "utf-8")
      } catch {
        // Best-effort logging — don't crash if file write fails
      }
    }),
  )

/** Clack-backed logger for --no-tui mode. Maps Effect log levels to clack output. */
export const clackLoggerLayer: Layer.Layer<never> = Logger.replace(
  Logger.defaultLogger,
  Logger.make(({ logLevel, message }) => {
    const msg = typeof message === "string" ? message : String(message)
    switch (logLevel._tag) {
      case "Warning":
        clack.log.warn(msg)
        break
      case "Error":
      case "Fatal":
        clack.log.error(msg)
        break
      default:
        clack.log.info(msg)
    }
  }),
)

/** Console JSON logger for when no log file is configured. */
export const consoleJsonLoggerLayer: Layer.Layer<never> = Logger.replace(
  Logger.defaultLogger,
  Logger.make(({ logLevel, message, date }) => {
    const entry = JSON.stringify({
      timestamp: date.toISOString(),
      level: logLevel.label,
      message: typeof message === "string" ? message : String(message),
    })
    if (logLevel._tag === "Error" || logLevel._tag === "Fatal") {
      console.error(entry)
    } else {
      console.log(entry)
    }
  }),
)
