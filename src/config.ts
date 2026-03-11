import { Context, Layer, Effect, Data } from "effect"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { spawnSync } from "child_process"

function hasValidAccessToken(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false
  const d = data as Record<string, unknown>
  const token =
    (d["claudeAiOauth"] as Record<string, unknown> | undefined)?.["accessToken"] ??
    d["accessToken"]
  return typeof token === "string" && token.length > 0
}

function hasSubscriptionAuth(): boolean {
  if (process.env["CLAUDE_CODE_OAUTH_TOKEN"]) return true

  // Check credentials file (Linux/Windows primary store; also present on macOS if not migrated to Keychain)
  const configDir = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude")
  const credentialsPath = join(configDir, ".credentials.json")
  if (existsSync(credentialsPath)) {
    try {
      return hasValidAccessToken(JSON.parse(readFileSync(credentialsPath, "utf8")))
    } catch {
      // fall through to Keychain check
    }
  }

  // macOS Keychain fallback — Claude Code stores credentials here after login on Mac.
  // CLAUDE_SECURITY_BIN can override the binary path (used in tests).
  if (process.platform === "darwin" || process.env["CLAUDE_SECURITY_BIN"]) {
    const securityBin = process.env["CLAUDE_SECURITY_BIN"] ?? "/usr/bin/security"
    try {
      const result = spawnSync(
        securityBin,
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8" },
      )
      if (result.status === 0 && result.stdout?.trim()) {
        return hasValidAccessToken(JSON.parse(result.stdout.trim()))
      }
    } catch {
      // no Keychain entry or security command unavailable
    }
  }

  return false
}

export interface SymphonyConfig {
  readonly pollIntervalMs: number
  readonly maxConcurrent: number
  readonly maxTurns: number
  readonly maxRetryBackoffMs: number
  readonly stallTimeoutMs: number
  readonly hookTimeoutMs: number
  readonly model: string
  readonly permissionMode: string
  readonly allowedTools: readonly string[]
  readonly workspaceRoot: string
  readonly trackerRepo: string
  readonly trackerLabels: readonly string[]
  readonly trackerActiveStates: readonly string[]
  readonly trackerTerminalStates: readonly string[]
  readonly httpPort: number
  readonly tui: boolean
  readonly verbose: boolean
  readonly logFile: string | null
}

export const defaultConfig: SymphonyConfig = {
  pollIntervalMs: 30_000,
  maxConcurrent: 5,
  maxTurns: 20,
  maxRetryBackoffMs: 300_000,
  stallTimeoutMs: 300_000,
  hookTimeoutMs: 60_000,
  model: "claude-sonnet-4-5-20250929",
  permissionMode: "acceptEdits",
  allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  workspaceRoot: `${process.env["HOME"] ?? "/tmp"}/.symphony/workspaces`,
  trackerRepo: "",
  trackerLabels: ["symphony"],
  trackerActiveStates: ["open"],
  trackerTerminalStates: ["closed"],
  httpPort: 4000,
  tui: true,
  verbose: false,
  logFile: null,
}

export class Config extends Context.Tag("Config")<Config, SymphonyConfig>() {}

/** Resolve $ENV_VAR references in a string value. */
function resolveEnv(value: string): string {
  if (value.startsWith("$")) {
    return process.env[value.slice(1)] ?? ""
  }
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, v: string) => process.env[v] ?? "")
}

function getPath(obj: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = obj
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Build a Config from workflow YAML config merged with defaults. */
export function configFromWorkflow(
  yamlConfig: Record<string, unknown>,
  overrides: Partial<SymphonyConfig> = {},
): SymphonyConfig {
  const mappings: Array<[readonly string[], keyof SymphonyConfig]> = [
    [["polling", "interval_ms"], "pollIntervalMs"],
    [["agent", "max_concurrent_agents"], "maxConcurrent"],
    [["agent", "max_turns"], "maxTurns"],
    [["agent", "max_retry_backoff_ms"], "maxRetryBackoffMs"],
    [["agent", "stall_timeout_ms"], "stallTimeoutMs"],
    [["claude", "model"], "model"],
    [["claude", "permission_mode"], "permissionMode"],
    [["claude", "allowed_tools"], "allowedTools"],
    [["claude", "max_turns"], "maxTurns"],
    [["hooks", "timeout_ms"], "hookTimeoutMs"],
    [["workspace", "root"], "workspaceRoot"],
    [["tracker", "repo"], "trackerRepo"],
    [["tracker", "labels"], "trackerLabels"],
    [["tracker", "active_states"], "trackerActiveStates"],
    [["tracker", "terminal_states"], "trackerTerminalStates"],
  ]

  const resolved: Record<string, unknown> = { ...defaultConfig }

  for (const [path, key] of mappings) {
    const val = getPath(yamlConfig, path)
    if (val !== undefined && val !== null) {
      resolved[key] = typeof val === "string" ? resolveEnv(val) : val
    }
  }

  return { ...resolved, ...overrides } as SymphonyConfig
}

export const ConfigLive = (config: SymphonyConfig): Layer.Layer<Config> =>
  Layer.succeed(Config, config)

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly reason: string
}> {}

/** Validate that at least one Claude authentication method is configured. */
export function validateEnv(): Effect.Effect<void, ConfigError> {
  return Effect.gen(function* () {
    if (!process.env["ANTHROPIC_API_KEY"] && !hasSubscriptionAuth()) {
      yield* Effect.fail(
        new ConfigError({
          reason:
            "No Claude authentication found. Set ANTHROPIC_API_KEY for API access, or run `claude auth login` for subscription access (Claude Pro/Max).",
        }),
      )
    }
  })
}
