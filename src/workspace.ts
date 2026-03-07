import { Effect, Data, Scope } from "effect"
import { mkdirSync, rmSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { Config } from "./config.js"
import { type Issue, identifier } from "./github/issue.js"

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly reason: string
}> {}

interface HookConfig {
  readonly [name: string]: string | undefined
}

/** Create a workspace dir, returning a scoped resource that auto-cleans up. */
export function withWorkspace(
  issue: Issue,
  hooks: HookConfig = {},
): Effect.Effect<string, WorkspaceError, Config | Scope.Scope> {
  return Effect.flatMap(Config, (config) => {
    const id = identifier(issue)
    const dir = join(config.workspaceRoot, `issue-${id}`)

    return Effect.acquireRelease(
      // Acquire: create directory
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => mkdirSync(dir, { recursive: true }),
          catch: (err) => new WorkspaceError({ reason: `mkdir failed: ${err}` }),
        })
        yield* validatePath(dir, config.workspaceRoot)
        yield* runHook(hooks, "after_create", dir, issue)
        return dir
      }),
      // Release: cleanup directory
      (dir) =>
        runHook(hooks, "before_remove", dir, null).pipe(
          Effect.flatMap(() =>
            Effect.try({
              try: () => rmSync(dir, { recursive: true, force: true }),
              catch: () => void 0,
            }),
          ),
          Effect.catchAll(() => Effect.void),
        ),
    )
  })
}

/** Run before_run hook. */
export function beforeRun(
  dir: string,
  issue: Issue,
  hooks: HookConfig = {},
): Effect.Effect<void, WorkspaceError> {
  return runHook(hooks, "before_run", dir, issue)
}

/** Run after_run hook. */
export function afterRun(
  dir: string,
  issue: Issue,
  hooks: HookConfig = {},
): Effect.Effect<void, WorkspaceError> {
  return runHook(hooks, "after_run", dir, issue)
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
    Effect.timeout("60 seconds"),
    Effect.catchTag("TimeoutException", () =>
      Effect.fail(new WorkspaceError({ reason: `Hook ${name} timed out after 60s` })),
    ),
    Effect.asVoid,
  )
}
