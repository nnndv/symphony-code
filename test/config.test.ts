import { test, expect } from "bun:test"
import { Effect, Exit, Cause, Option } from "effect"
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { validateEnv, ConfigError } from "../src/config.js"

// Creates a fake `security` binary in tmpDir that either outputs JSON or exits 1
function makeFakeSecurity(tmpDir: string, output: string | null): void {
  const bin = join(tmpDir, "security")
  const script =
    output === null
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\ncat << 'CREDS'\n${output}\nCREDS\n`
  writeFileSync(bin, script, "utf8")
  chmodSync(bin, 0o755)
}

// Helpers to save/restore env vars and isolate credential file lookups
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

test("fails with clear error when no auth method is configured", async () => {
  const tmpDir = join(tmpdir(), `symphony-test-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  makeFakeSecurity(tmpDir, null) // fake security binary that exits 1
  try {
    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDE_CONFIG_DIR: tmpDir,
        CLAUDE_SECURITY_BIN: join(tmpDir, "security"),
      },
      async () => {
        const exit = await Effect.runPromiseExit(validateEnv())
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.failureOption(exit.cause)
          expect(Option.isSome(error)).toBe(true)
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(ConfigError)
            expect(error.value.reason).toContain("ANTHROPIC_API_KEY")
            expect(error.value.reason).toContain("claude auth login")
          }
        }
      },
    )
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("succeeds when macOS Keychain has Claude credentials", async () => {
  const tmpDir = join(tmpdir(), `symphony-test-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  makeFakeSecurity(
    tmpDir,
    JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } }),
  )
  try {
    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDE_CONFIG_DIR: tmpDir, // no .credentials.json here
        CLAUDE_SECURITY_BIN: join(tmpDir, "security"),
      },
      async () => {
        const exit = await Effect.runPromiseExit(validateEnv())
        expect(Exit.isSuccess(exit)).toBe(true)
      },
    )
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("succeeds when ANTHROPIC_API_KEY is present", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "sk-test-key" }, async () => {
    const exit = await Effect.runPromiseExit(validateEnv())
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

test("succeeds when CLAUDE_CODE_OAUTH_TOKEN env var is set", async () => {
  await withEnv(
    {
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
    },
    async () => {
      const exit = await Effect.runPromiseExit(validateEnv())
      expect(Exit.isSuccess(exit)).toBe(true)
    },
  )
})

test("succeeds when Claude subscription credentials file exists", async () => {
  const tmpDir = join(tmpdir(), `symphony-test-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  const credentialsPath = join(tmpDir, ".credentials.json")
  writeFileSync(
    credentialsPath,
    JSON.stringify({ claudeAiOauth: { accessToken: "test-access-token" } }),
    "utf8",
  )
  try {
    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDE_CONFIG_DIR: tmpDir,
      },
      async () => {
        const exit = await Effect.runPromiseExit(validateEnv())
        expect(Exit.isSuccess(exit)).toBe(true)
      },
    )
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("fails when credentials file exists but has no accessToken", async () => {
  const tmpDir = join(tmpdir(), `symphony-test-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  const credentialsPath = join(tmpDir, ".credentials.json")
  writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: {} }), "utf8")
  try {
    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDE_CONFIG_DIR: tmpDir,
      },
      async () => {
        const exit = await Effect.runPromiseExit(validateEnv())
        expect(Exit.isFailure(exit)).toBe(true)
      },
    )
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
