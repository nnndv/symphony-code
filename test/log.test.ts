import { test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { clackLoggerLayer } from "../src/log.js"

test("clackLoggerLayer is a valid Effect Layer", async () => {
  // Verify the layer can be provided and an Effect runs to completion
  const program = Effect.logInfo("test message")
  const result = await Effect.runPromiseExit(
    program.pipe(Effect.provide(clackLoggerLayer))
  )
  expect(result._tag).toBe("Success")
})
