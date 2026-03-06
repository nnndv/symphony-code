// JSON-RPC 2.0 types for Elixir <-> Node communication

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Session configuration from Elixir
export interface SessionConfig {
  session_id: string;
  model: string;
  permission_mode: string;
  allowed_tools: string[];
  max_turns: number;
  system_prompt?: string;
  workspace_dir: string;
}

// Turn request
export interface TurnParams {
  session_id: string;
  prompt: string;
  resume?: boolean;
}

// Claude CLI stream-json message types
export interface ClaudeStreamMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    role: string;
    content: unknown[];
  };
  result?: string;
  cost_usd?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}
