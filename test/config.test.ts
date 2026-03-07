import { test, expect } from "bun:test"
import { Effect, Exit, Cause, Option } from "effect"
import { validateEnv, ConfigError } from "../src/config.js"

test("fails with clear error when ANTHROPIC_API_KEY is missing", async () => {
  const saved = process.env["ANTHROPIC_API_KEY"]
  delete process.env["ANTHROPIC_API_KEY"]

  try {
    const exit = await Effect.runPromiseExit(validateEnv())
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.failureOption(exit.cause)
      expect(Option.isSome(error)).toBe(true)
      if (Option.isSome(error)) {
        expect(error.value).toBeInstanceOf(ConfigError)
        expect(error.value.reason).toContain("ANTHROPIC_API_KEY")
      }
    }
  } finally {
    if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved
  }
})

test("succeeds when ANTHROPIC_API_KEY is present", async () => {
  const saved = process.env["ANTHROPIC_API_KEY"]
  process.env["ANTHROPIC_API_KEY"] = "sk-test-key"

  try {
    const exit = await Effect.runPromiseExit(validateEnv())
    expect(Exit.isSuccess(exit)).toBe(true)
  } finally {
    if (saved !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = saved
    } else {
      delete process.env["ANTHROPIC_API_KEY"]
    }
  }
})
