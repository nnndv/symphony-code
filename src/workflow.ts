import { Effect, Data } from "effect"
import { parse as parseYaml } from "yaml"
import { readFileSync } from "node:fs"

export interface Workflow {
  readonly config: Record<string, unknown>
  readonly template: string
  readonly sourcePath: string | null
}

export class WorkflowParseError extends Data.TaggedError("WorkflowParseError")<{
  readonly reason: string
}> {}

/** Parse a WORKFLOW.md content string into config + template. */
export function parseWorkflow(
  content: string,
  sourcePath: string | null = null,
): Effect.Effect<Workflow, WorkflowParseError> {
  return Effect.try({
    try: () => {
      const parts = content.split(/^---\s*$/m)
      if (parts.length < 3) {
        throw new Error("No YAML front matter found (expected --- delimiters)")
      }
      const yamlStr = parts[1]!
      const template = parts.slice(2).join("---").trim()
      const config = parseYaml(yamlStr) as Record<string, unknown>
      return { config, template, sourcePath }
    },
    catch: (err) =>
      new WorkflowParseError({
        reason: err instanceof Error ? err.message : String(err),
      }),
  })
}

/** Parse a WORKFLOW.md file from disk. */
export function parseWorkflowFile(
  path: string,
): Effect.Effect<Workflow, WorkflowParseError> {
  return Effect.flatMap(
    Effect.try({
      try: () => readFileSync(path, "utf-8"),
      catch: (err) =>
        new WorkflowParseError({
          reason: `Failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
        }),
    }),
    (content) => parseWorkflow(content, path),
  )
}
