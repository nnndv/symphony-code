import { Effect, Data } from "effect"
import { mkdirSync, existsSync, rmSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import { Config } from "./config.js"
import { type Issue, identifier } from "./github/issue.js"

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly reason: string
}> {}

interface HookConfig {
  readonly [name: string]: string | undefined
}

export interface WorkspaceResult {
  readonly path: string
  readonly createdNow: boolean
}

/**
 * Ensure a workspace directory exists for the given issue.
 * Workspaces persist across runs — they are NOT auto-deleted on success.
 * Use `removeWorkspace` for explicit terminal-state cleanup.
 */
export function ensureWorkspace(
  issue: Issue,
  hooks: HookConfig = {},
  hookTimeoutMs = 60_000,
): Effect.Effect<WorkspaceResult, WorkspaceError, Config> {
  return Effect.flatMap(Config, (config) => {
    const wsKey = sanitizeKey(identifier(issue))
    const dir = join(config.workspaceRoot, wsKey)

    return Effect.gen(function* () {
      // Ensure workspace root exists
      yield* Effect.try({
        try: () => mkdirSync(config.workspaceRoot, { recursive: true }),
        catch: (err) => new WorkspaceError({ reason: `mkdir root failed: ${err}` }),
      })

      const createdNow = !existsSync(dir) || !statSync(dir).isDirectory()

      if (createdNow && config.trackerRepo && !config.dryRun) {
        // Clone the tracker repo into the workspace directory
        yield* cloneRepo(config.trackerRepo, dir, hookTimeoutMs)
      } else if (createdNow) {
        yield* Effect.try({
          try: () => mkdirSync(dir, { recursive: true }),
          catch: (err) => new WorkspaceError({ reason: `mkdir failed: ${err}` }),
        })
      }

      yield* validatePath(dir, config.workspaceRoot)

      // after_create runs ONLY when the directory was just created
      if (createdNow) {
        yield* runHook(hooks, "after_create", dir, issue, hookTimeoutMs)
      }

      return { path: dir, createdNow } satisfies WorkspaceResult
    })
  })
}

/** Run before_run hook. */
export function beforeRun(
  dir: string,
  issue: Issue,
  hooks: HookConfig = {},
  hookTimeoutMs = 60_000,
): Effect.Effect<void, WorkspaceError> {
  return runHook(hooks, "before_run", dir, issue, hookTimeoutMs)
}

/** Run after_run hook (best-effort: failures are logged and ignored). */
export function afterRun(
  dir: string,
  issue: Issue,
  hooks: HookConfig = {},
  hookTimeoutMs = 60_000,
): Effect.Effect<void> {
  return runHook(hooks, "after_run", dir, issue, hookTimeoutMs).pipe(
    Effect.catchAll((err) =>
      Effect.logWarning(`after_run hook failed (ignored): ${err}`),
    ),
  )
}

/** Remove a workspace directory (for terminal-state cleanup). */
export function removeWorkspace(
  dir: string,
  hooks: HookConfig = {},
  hookTimeoutMs = 60_000,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (!existsSync(dir)) return

    // before_remove failures are logged and ignored
    yield* runHook(hooks, "before_remove", dir, null, hookTimeoutMs).pipe(
      Effect.catchAll((err) =>
        Effect.logWarning(`before_remove hook failed (ignored): ${err}`),
      ),
    )

    yield* Effect.try({
      try: () => rmSync(dir, { recursive: true, force: true }),
      catch: () => void 0,
    }).pipe(Effect.catchAll(() => Effect.void))
  })
}

/** Sanitize identifier: only [A-Za-z0-9._-] allowed, rest replaced with _ */
export function sanitizeKey(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_")
}

/** Prevent symlink escape: resolved path must be under root. */
function validatePath(dir: string, root: string): Effect.Effect<void, WorkspaceError> {
  return Effect.try({
    try: () => {
      const realDir = realpathSync(dir)
      const realRoot = realpathSync(root)
      if (!realDir.startsWith(realRoot)) {
        throw new Error(`Symlink escape detected: ${dir} resolves outside ${root}`)
      }
    },
    catch: (err) => new WorkspaceError({ reason: String(err) }),
  })
}

/** Clone a GitHub repo into the target directory via `gh repo clone`. */
function cloneRepo(
  repo: string,
  dir: string,
  timeoutMs: number,
): Effect.Effect<void, WorkspaceError> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["gh", "repo", "clone", repo, dir], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        throw new Error(`git clone failed (exit ${exitCode}): ${stderr || stdout}`)
      }
    },
    catch: (err) => new WorkspaceError({ reason: String(err) }),
  }).pipe(
    Effect.timeout(`${timeoutMs} millis`),
    Effect.catchTag("TimeoutException", () =>
      Effect.fail(new WorkspaceError({ reason: `Clone of ${repo} timed out after ${timeoutMs}ms` })),
    ),
    Effect.asVoid,
  )
}

function renderHookCmd(template: string, issue: Issue | null): string {
  if (!issue) return template
  return template
    .replace(/\{\{identifier\}\}/g, identifier(issue))
    .replace(/\{\{title\}\}/g, issue.title)
    .replace(/\{\{number\}\}/g, String(issue.number))
}

function runHook(
  hooks: HookConfig,
  name: string,
  dir: string,
  issue: Issue | null,
  timeoutMs: number,
): Effect.Effect<void, WorkspaceError> {
  const cmdTemplate = hooks[name]
  if (!cmdTemplate) return Effect.void

  const cmd = renderHookCmd(cmdTemplate, issue)

  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["sh", "-c", cmd], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        throw new Error(`Hook ${name} failed (exit ${exitCode}): ${stderr || stdout}`)
      }
    },
    catch: (err) => new WorkspaceError({ reason: String(err) }),
  }).pipe(
    Effect.timeout(`${timeoutMs} millis`),
    Effect.catchTag("TimeoutException", () =>
      Effect.fail(new WorkspaceError({ reason: `Hook ${name} timed out after ${timeoutMs}ms` })),
    ),
    Effect.asVoid,
  )
}
