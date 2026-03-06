import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from "./types.ts";

export function parseRequest(line: string): JsonRpcRequest | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed.jsonrpc === "2.0" && parsed.method && parsed.id !== undefined) {
      return parsed as JsonRpcRequest;
    }
    return null;
  } catch {
    return null;
  }
}

export function formatResponse(
  id: number | string,
  result: unknown
): string {
  const resp: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  return JSON.stringify(resp);
}

export function formatError(
  id: number | string,
  code: number,
  message: string,
  data?: unknown
): string {
  const resp: JsonRpcResponse = {
    jsonrpc: "2.0",
    id,
    error: { code, message, data },
  };
  return JSON.stringify(resp);
}

export function formatNotification(
  method: string,
  params?: Record<string, unknown>
): string {
  const notif: JsonRpcNotification = { jsonrpc: "2.0", method, params };
  return JSON.stringify(notif);
}

// Standard JSON-RPC error codes
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
