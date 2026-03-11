import { Effect, Context, Layer } from "effect"
import { Config, type SymphonyConfig } from "../config.js"
import * as GhClient from "./client.js"
import { type Issue, fromGh, identifier } from "./issue.js"

export interface Tracker {
  readonly listIssues: () => Effect.Effect<Issue[], GhClient.GhCliError>
  readonly getIssue: (id: string) => Effect.Effect<Issue, GhClient.GhCliError>
  readonly comment: (id: string, body: string) => Effect.Effect<void, GhClient.GhCliError>
  readonly close: (id: string) => Effect.Effect<void, GhClient.GhCliError>
  readonly hasLinkedPR: (id: string) => Effect.Effect<boolean, GhClient.GhCliError>
}

export class TrackerService extends Context.Tag("Tracker")<TrackerService, Tracker>() {}

export const TrackerLive: Layer.Layer<TrackerService, never, Config> = Layer.effect(
  TrackerService,
  Effect.map(Config, (config): Tracker => ({
    listIssues: () =>
      GhClient.listIssues(config.trackerRepo, config.trackerLabels).pipe(
        Effect.map((items) =>
          items.map((item) => fromGh(item as Record<string, unknown>)),
        ),
      ),

    getIssue: (id: string) =>
      GhClient.getIssue(config.trackerRepo, Number(id)).pipe(
        Effect.map((item) => fromGh(item as Record<string, unknown>)),
      ),

    comment: (id: string, body: string) =>
      GhClient.comment(config.trackerRepo, Number(id), body),

    close: (id: string) =>
      GhClient.close(config.trackerRepo, Number(id)),

    hasLinkedPR: (id: string) =>
      GhClient.listLinkedPRs(config.trackerRepo, Number(id)).pipe(
        Effect.map((prs) => prs.length > 0),
      ),
  })),
)
