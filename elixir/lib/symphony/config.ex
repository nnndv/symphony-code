defmodule Symphony.Config do
  @moduledoc """
  Typed configuration accessors with defaults.
  Reads from Application env under :symphony key.
  """

  @defaults %{
    poll_interval_ms: 30_000,
    max_concurrent: 5,
    max_turns: 20,
    max_retry_backoff_ms: 300_000,
    stall_timeout_ms: 300_000,
    model: "claude-sonnet-4-5-20250929",
    permission_mode: "acceptEdits",
    allowed_tools: ~w(Read Write Edit Bash Glob Grep),
    workspace_root: nil,
    tracker_kind: "github",
    tracker_repo: nil,
    tracker_labels: ["symphony"],
    active_states: ["open"],
    terminal_states: ["closed"],
    node_worker_path: nil,
    http_port: 4000
  }

  def get(key) when is_atom(key) do
    case Application.get_env(:symphony, key) do
      nil -> Map.get(@defaults, key)
      value -> value
    end
  end

  def get(key, default) when is_atom(key) do
    Application.get_env(:symphony, key, default)
  end

  def poll_interval_ms, do: get(:poll_interval_ms)
  def max_concurrent, do: get(:max_concurrent)
  def max_turns, do: get(:max_turns)
  def max_retry_backoff_ms, do: get(:max_retry_backoff_ms)
  def stall_timeout_ms, do: get(:stall_timeout_ms)
  def model, do: get(:model)
  def permission_mode, do: get(:permission_mode)
  def allowed_tools, do: get(:allowed_tools)
  def workspace_root, do: get(:workspace_root) || Path.join(System.tmp_dir!(), "symphony_workspaces")
  def tracker_repo, do: get(:tracker_repo)
  def tracker_labels, do: get(:tracker_labels)
  def node_worker_path, do: get(:node_worker_path)
  def http_port, do: get(:http_port)

  @doc "Applies a workflow config map to application env."
  def apply_workflow(config) when is_map(config) do
    mappings = [
      {[:polling, :interval_ms], :poll_interval_ms},
      {[:agent, :max_concurrent_agents], :max_concurrent},
      {[:agent, :max_turns], :max_turns},
      {[:agent, :max_retry_backoff_ms], :max_retry_backoff_ms},
      {[:agent, :stall_timeout_ms], :stall_timeout_ms},
      {[:claude, :model], :model},
      {[:claude, :permission_mode], :permission_mode},
      {[:claude, :allowed_tools], :allowed_tools},
      {[:claude, :max_turns], :max_turns},
      {[:workspace, :root], :workspace_root},
      {[:tracker, :repo], :tracker_repo},
      {[:tracker, :labels], :tracker_labels},
      {[:tracker, :active_states], :active_states},
      {[:tracker, :terminal_states], :terminal_states}
    ]

    for {path, key} <- mappings do
      case get_in_string_keys(config, path) do
        nil -> :skip
        value -> Application.put_env(:symphony, key, resolve_env(value))
      end
    end

    :ok
  end

  defp get_in_string_keys(map, []), do: map
  defp get_in_string_keys(map, [key | rest]) when is_map(map) do
    val = Map.get(map, to_string(key)) || Map.get(map, key)
    get_in_string_keys(val, rest)
  end
  defp get_in_string_keys(_, _), do: nil

  defp resolve_env("$" <> var_name), do: System.get_env(var_name) || ""
  defp resolve_env(value) when is_binary(value) do
    Regex.replace(~r/\$([A-Z_][A-Z0-9_]*)/, value, fn _, var ->
      System.get_env(var) || ""
    end)
  end
  defp resolve_env(value), do: value
end
