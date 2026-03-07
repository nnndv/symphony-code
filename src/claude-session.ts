import { Effect, PubSub } from "effect"
import { EventBus, type SymphonyEvent } from "./event-bus.js"

export interface SessionConfig {
  readonly sessionId: string
  readonly model: string
  readonly permissionMode: string
  readonly allowedTools: readonly string[]
  readonly maxTurns: number
  readonly systemPrompt?: string
  readonly workspaceDir: string
}

export interface TurnParams {
  readonly sessionId: string
  readonly prompt: string
  readonly resume?: boolean
}

export interface TurnResult {
  readonly result: string
  readonly costUsd: number
  readonly numTurns: number
}

interface ClaudeStreamMessage {
  readonly type: string
  readonly subtype?: string
  readonly session_id?: string
  readonly message?: { readonly role: string; readonly content: unknown[] }
  readonly result?: string | object
  readonly cost_usd?: number
  readonly total_cost_usd?: number
  readonly num_turns?: number
}

/** Run a single Claude CLI turn. Fiber-interruptible — interrupting the fiber kills the subprocess. */
export function runTurn(
  config: SessionConfig,
  params: TurnParams,
): Effect.Effect<TurnResult, Error, EventBus> {
  return Effect.flatMap(EventBus, (pubsub) =>
    Effect.async<TurnResult, Error>((resume, signal) => {
      const args: string[] = [
        "--print",
        "--output-format", "stream-json",
        "--model", config.model,
        "--permission-mode", config.permissionMode,
      ]

      if (config.maxTurns > 0) {
        args.push("--max-turns", String(config.maxTurns))
      }
      if (config.allowedTools.length > 0) {
        args.push("--allowedTools", ...config.allowedTools)
      }
      if (config.systemPrompt) {
        args.push("--system-prompt", config.systemPrompt)
      }

      args.push(params.prompt)

      const proc = Bun.spawn(["claude", ...args], {
        cwd: config.workspaceDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      })

      signal.addEventListener("abort", () => {
        proc.kill()
      })

      let result = ""
      let costUsd = 0
      let numTurns = 0
      let claudeSessionId: string | null = null

      const processStream = async () => {
        const stdout = proc.stdout as ReadableStream<Uint8Array>
        const reader = stdout.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        try {
          while (true) {
            if (signal.aborted) break
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() || ""

            for (const line of lines) {
              if (!line.trim()) continue
              try {
                const msg: ClaudeStreamMessage = JSON.parse(line)

                // Publish events
                if (msg.type === "assistant" && msg.message) {
                  Effect.runFork(PubSub.publish(pubsub, {
                    _tag: "ClaudeMessage",
                    sessionId: params.sessionId,
                    message: msg.message,
                  } satisfies SymphonyEvent))
                } else if (msg.type === "system") {
                  Effect.runFork(PubSub.publish(pubsub, {
                    _tag: "ClaudeStatus",
                    sessionId: params.sessionId,
                    type: msg.subtype ?? "system",
                    data: msg,
                  } satisfies SymphonyEvent))
                }

                if (msg.type === "result") {
                  result = typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result)
                  costUsd = msg.total_cost_usd ?? msg.cost_usd ?? 0
                  numTurns = msg.num_turns ?? 0
                  if (msg.session_id) claudeSessionId = msg.session_id
                }
                if (msg.session_id && !claudeSessionId) {
                  claudeSessionId = msg.session_id
                }
              } catch {
                // Skip unparseable lines
              }
            }
          }

          await proc.exited
          resume(Effect.succeed({ result, costUsd, numTurns }))
        } catch (err) {
          if (!signal.aborted) {
            resume(Effect.fail(err instanceof Error ? err : new Error(String(err))))
          }
        }
      }

      processStream()
    }),
  )
}
