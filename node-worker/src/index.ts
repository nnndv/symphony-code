#!/usr/bin/env bun
/**
 * Symphony Node Worker
 *
 * JSON-RPC bridge between Elixir (Erlang Port) and Claude CLI.
 * Reads JSON-RPC requests from stdin (line-delimited), writes responses/notifications to stdout.
 */

import { ClaudeSession } from "./claude-session.ts";
import {
  parseRequest,
  formatResponse,
  formatError,
  formatNotification,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
} from "./jsonrpc.ts";
import type { SessionConfig, TurnParams } from "./types.ts";

const sessions = new Map<string, ClaudeSession>();

function send(msg: string) {
  process.stdout.write(msg + "\n");
}

async function handleRequest(
  id: number | string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<void> {
  switch (method) {
    case "initialize": {
      send(formatResponse(id, { status: "ok", version: "0.1.0" }));
      break;
    }

    case "session/start": {
      const config = params as unknown as SessionConfig;
      if (!config.session_id || !config.model) {
        send(formatError(id, INVALID_PARAMS, "Missing session_id or model"));
        return;
      }
      const session = new ClaudeSession(config);
      sessions.set(config.session_id, session);
      send(formatResponse(id, { session_id: config.session_id, status: "started" }));
      send(formatNotification("session/initialized", { session_id: config.session_id }));
      break;
    }

    case "turn/start": {
      const turnParams = params as unknown as TurnParams;
      if (!turnParams.session_id || !turnParams.prompt) {
        send(formatError(id, INVALID_PARAMS, "Missing session_id or prompt"));
        return;
      }
      const session = sessions.get(turnParams.session_id);
      if (!session) {
        send(formatError(id, INVALID_PARAMS, `No session: ${turnParams.session_id}`));
        return;
      }
      try {
        const result = await session.runTurn(turnParams);
        send(formatNotification("result/success", {
          session_id: turnParams.session_id,
          ...result,
        }));
        send(formatResponse(id, { status: "completed", ...result }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(formatNotification("result/error", {
          session_id: turnParams.session_id,
          error: message,
        }));
        send(formatError(id, INTERNAL_ERROR, message));
      }
      break;
    }

    case "turn/stop": {
      const sid = params.session_id as string;
      const session = sessions.get(sid);
      if (session) {
        session.stop();
        send(formatResponse(id, { status: "stopped" }));
      } else {
        send(formatError(id, INVALID_PARAMS, `No session: ${sid}`));
      }
      break;
    }

    case "session/stop": {
      const sid = params.session_id as string;
      const session = sessions.get(sid);
      if (session) {
        session.stop();
        sessions.delete(sid);
      }
      send(formatResponse(id, { status: "stopped" }));
      break;
    }

    case "shutdown": {
      for (const [, session] of sessions) {
        session.stop();
      }
      sessions.clear();
      send(formatResponse(id, { status: "shutdown" }));
      // Give time for the response to flush, then exit
      setTimeout(() => process.exit(0), 100);
      break;
    }

    default:
      send(formatError(id, METHOD_NOT_FOUND, `Unknown method: ${method}`));
  }
}

// Main: read line-delimited JSON-RPC from stdin
const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffer = "";

async function readLoop() {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const req = parseRequest(line);
      if (req) {
        // Fire and forget — responses are sent asynchronously
        handleRequest(req.id, req.method, req.params ?? {}).catch((err) => {
          send(formatError(req.id, INTERNAL_ERROR, String(err)));
        });
      }
    }
  }
}

// Signal handlers
process.on("SIGTERM", () => {
  for (const [, session] of sessions) {
    session.stop();
  }
  process.exit(0);
});

readLoop().catch((err) => {
  console.error("Worker fatal:", err);
  process.exit(1);
});
