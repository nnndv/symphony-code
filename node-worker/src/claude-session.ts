import type { Subprocess } from "bun";
import type { SessionConfig, TurnParams, ClaudeStreamMessage } from "./types.ts";
import { formatNotification } from "./jsonrpc.ts";

function send(msg: string) {
  process.stdout.write(msg + "\n");
}

export class ClaudeSession {
  readonly sessionId: string;
  private config: SessionConfig;
  private proc: Subprocess | null = null;
  private claudeSessionId: string | null = null;
  private abortController: AbortController | null = null;

  constructor(config: SessionConfig) {
    this.sessionId = config.session_id;
    this.config = config;
  }

  async runTurn(params: TurnParams): Promise<{ result: string; cost_usd: number; num_turns: number }> {
    this.abortController = new AbortController();

    const args: string[] = [
      "--print",
      "--output-format", "stream-json",
      "--model", this.config.model,
      "--permission-mode", this.config.permission_mode,
    ];

    if (this.config.max_turns > 0) {
      args.push("--max-turns", String(this.config.max_turns));
    }

    if (this.config.allowed_tools.length > 0) {
      args.push("--allowedTools", ...this.config.allowed_tools);
    }

    if (this.config.system_prompt) {
      args.push("--system-prompt", this.config.system_prompt);
    }

    // Resume previous session if requested
    if (params.resume && this.claudeSessionId) {
      args.push("--resume", this.claudeSessionId);
    }

    args.push(params.prompt);

    const claudeBin = new URL("../../node_modules/.bin/claude", import.meta.url).pathname;

    this.proc = Bun.spawn([claudeBin, ...args], {
      cwd: this.config.workspace_dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    let result = "";
    let costUsd = 0;
    let numTurns = 0;

    try {
      const stdout = this.proc.stdout as ReadableStream<Uint8Array>;
      const reader = stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        if (this.abortController.signal.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg: ClaudeStreamMessage = JSON.parse(line);
            this.handleStreamMessage(msg);

            if (msg.type === "result") {
              result = typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result);
              costUsd = msg.total_cost_usd ?? msg.cost_usd ?? 0;
              numTurns = msg.num_turns ?? 0;
              // Capture session ID for potential resume
              if (msg.session_id) {
                this.claudeSessionId = msg.session_id;
              }
            }

            if (msg.session_id && !this.claudeSessionId) {
              this.claudeSessionId = msg.session_id;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }

      await this.proc.exited;
    } catch (err) {
      if (!this.abortController.signal.aborted) {
        throw err;
      }
    }

    this.proc = null;
    return { result, cost_usd: costUsd, num_turns: numTurns };
  }

  private handleStreamMessage(msg: ClaudeStreamMessage) {
    if (msg.type === "assistant" && msg.message) {
      send(formatNotification("message/assistant", {
        session_id: this.sessionId,
        message: msg.message,
      }));
    } else if (msg.type === "system") {
      send(formatNotification("status", {
        session_id: this.sessionId,
        type: msg.subtype ?? "system",
        data: msg,
      }));
    }
  }

  stop() {
    this.abortController?.abort();
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}
