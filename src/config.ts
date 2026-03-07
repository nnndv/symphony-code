import { Context, Layer, Effect, Data } from "effect"

export interface SymphonyConfig {
  readonly pollIntervalMs: number
  readonly maxConcurrent: number
  readonly maxTurns: number
  readonly maxRetryBackoffMs: number
  readonly stallTimeoutMs: number
  readonly model: string
  readonly permissionMode: string
  readonly allowedTools: readonly string[]
  readonly workspaceRoot: string
  readonly trackerRepo: string
  readonly trackerLabels: readonly string[]
  readonly httpPort: number
  readonly tui: boolean
  readonly logFile: string | null
}

export const defaultConfig: SymphonyConfig = {
  pollIntervalMs: 30_000,
  maxConcurrent: 5,
  maxTurns: 20,
  maxRetryBackoffMs: 300_000,
  stallTimeoutMs: 300_000,
  model: "claude-sonnet-4-5-20250929",
  permissionMode: "acceptEdits",
  allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  workspaceRoot: `${process.env["HOME"] ?? "/tmp"}/.symphony/workspaces`,
  trackerRepo: "",
  trackerLabels: ["symphony"],
  httpPort: 4000,
  tui: true,
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
    [["workspace", "root"], "workspaceRoot"],
    [["tracker", "repo"], "trackerRepo"],
    [["tracker", "labels"], "trackerLabels"],
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

/** Validate required environment variables are present. */
export function validateEnv(): Effect.Effect<void, ConfigError> {
  return Effect.gen(function* () {
    if (!process.env["ANTHROPIC_API_KEY"]) {
      yield* Effect.fail(
        new ConfigError({ reason: "ANTHROPIC_API_KEY is required but not set." }),
      )
    }
  })
}
