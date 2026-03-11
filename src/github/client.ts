import { Effect, Data } from "effect"

export class GhCliError extends Data.TaggedError("GhCliError")<{
  readonly code: number
  readonly output: string
}> {}

/** Run a `gh` CLI command and return stdout. */
function gh(args: readonly string[]): Effect.Effect<string, GhCliError> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["gh", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        throw { code: exitCode, output: stderr || stdout }
      }
      return stdout.trim()
    },
    catch: (err) => {
      if (err && typeof err === "object" && "code" in err) {
        return new GhCliError(err as { code: number; output: string })
      }
      return new GhCliError({ code: 1, output: String(err) })
    },
  })
}

const issueFields = "number,title,body,state,labels,assignees,url,createdAt,updatedAt"

export function listIssues(
  repo: string,
  labels: readonly string[] = [],
  state = "open",
): Effect.Effect<unknown[], GhCliError> {
  const labelArgs = labels.flatMap((l) => ["--label", l])
  return gh([
    "issue", "list",
    "--repo", repo,
    "--state", state,
    "--json", issueFields,
    "--limit", "100",
    ...labelArgs,
  ]).pipe(
    Effect.flatMap((json) =>
      Effect.try({
        try: () => JSON.parse(json) as unknown[],
        catch: () => new GhCliError({ code: 0, output: "Failed to parse gh JSON output" }),
      }),
    ),
  )
}

export function getIssue(
  repo: string,
  number: number,
): Effect.Effect<unknown, GhCliError> {
  return gh([
    "issue", "view",
    "--repo", repo,
    String(number),
    "--json", issueFields,
  ]).pipe(
    Effect.flatMap((json) =>
      Effect.try({
        try: () => JSON.parse(json) as unknown,
        catch: () => new GhCliError({ code: 0, output: "Failed to parse gh JSON output" }),
      }),
    ),
  )
}

export function comment(
  repo: string,
  number: number,
  body: string,
): Effect.Effect<void, GhCliError> {
  return gh([
    "issue", "comment",
    "--repo", repo,
    String(number),
    "--body", body,
  ]).pipe(Effect.asVoid)
}

export function close(
  repo: string,
  number: number,
): Effect.Effect<void, GhCliError> {
  return gh(["issue", "close", "--repo", repo, String(number)]).pipe(Effect.asVoid)
}

export interface LinkedPR {
  readonly number: number
  readonly state: string
  readonly url: string
}

/** List pull requests that close/reference the given issue. */
export function listLinkedPRs(
  repo: string,
  issueNumber: number,
): Effect.Effect<LinkedPR[], GhCliError> {
  // Use the GitHub API to find PRs that reference this issue via timeline events
  return gh([
    "api",
    `repos/${repo}/issues/${issueNumber}/timeline`,
    "--jq",
    `[.[] | select(.source.issue.pull_request != null) | {number: .source.issue.number, state: .source.issue.state, url: .source.issue.html_url}]`,
  ]).pipe(
    Effect.flatMap((json) =>
      Effect.try({
        try: () => {
          const parsed = JSON.parse(json || "[]") as LinkedPR[]
          return parsed
        },
        catch: () => new GhCliError({ code: 0, output: "Failed to parse linked PRs" }),
      }),
    ),
    // Fallback: if timeline API fails, try searching for PRs mentioning the issue
    Effect.catchAll(() =>
      gh([
        "pr", "list",
        "--repo", repo,
        "--search", `issue:${issueNumber}`,
        "--json", "number,state,url",
        "--limit", "10",
      ]).pipe(
        Effect.flatMap((json) =>
          Effect.try({
            try: () => JSON.parse(json || "[]") as LinkedPR[],
            catch: () => new GhCliError({ code: 0, output: "Failed to parse PR search" }),
          }),
        ),
      ),
    ),
  )
}
