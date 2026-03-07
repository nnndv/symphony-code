import { Effect, Data } from "effect"
import { Liquid } from "liquidjs"
import { Config } from "./config.js"
import { type Issue, identifier } from "./github/issue.js"

export class TemplateError extends Data.TaggedError("TemplateError")<{
  readonly reason: string
}> {}

const engine = new Liquid()

/** Render a Liquid template with issue context. */
export function render(
  template: string,
  issue: Issue,
): Effect.Effect<string, TemplateError, Config> {
  return Effect.flatMap(Config, (config) => {
    const context = {
      identifier: identifier(issue),
      number: issue.number,
      title: issue.title,
      description: issue.body,
      body: issue.body,
      state: issue.state,
      labels: issue.labels,
      assignees: issue.assignees,
      url: issue.url,
      priority: issue.priority,
      blockers: issue.blockers.map(String),
      repo: config.trackerRepo,
    }

    return Effect.tryPromise({
      try: () => engine.parseAndRender(template, context),
      catch: (err) =>
        new TemplateError({
          reason: err instanceof Error ? err.message : String(err),
        }),
    })
  })
}
