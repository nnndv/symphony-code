import { PubSub, type Effect, Context, Layer } from "effect"

export type SymphonyEvent =
  | { readonly _tag: "PollCompleted"; readonly issuesFound: number; readonly candidateCount: number; readonly dispatchedCount: number }
  | { readonly _tag: "PollFailed"; readonly error: string }
  | { readonly _tag: "IssueDispatched"; readonly issueNumber: string; readonly title: string }
  | { readonly _tag: "IssueCompleted"; readonly issueNumber: string; readonly costUsd: number; readonly turns: number }
  | { readonly _tag: "IssueFailed"; readonly issueNumber: string; readonly error: string; readonly retryAttempt: number; readonly retryInMs: number }
  | { readonly _tag: "IssueStalled"; readonly issueNumber: string }
  | { readonly _tag: "AgentStarted"; readonly issueNumber: string; readonly title: string }
  | { readonly _tag: "AgentCompleted"; readonly issueNumber: string; readonly result: string; readonly costUsd: number; readonly numTurns: number }
  | { readonly _tag: "AgentFailed"; readonly issueNumber: string; readonly error: string }
  | { readonly _tag: "AgentCompletedWithoutPR"; readonly issueNumber: string; readonly costUsd: number; readonly numTurns: number }
  | { readonly _tag: "ClaudeMessage"; readonly sessionId: string; readonly message: unknown }
  | { readonly _tag: "ClaudeStatus"; readonly sessionId: string; readonly type: string; readonly data: unknown }

export class EventBus extends Context.Tag("EventBus")<
  EventBus,
  PubSub.PubSub<SymphonyEvent>
>() {}

export const EventBusLive: Layer.Layer<EventBus> = Layer.effect(
  EventBus,
  PubSub.unbounded<SymphonyEvent>(),
)
