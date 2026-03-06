defmodule Symphony.Claude.NodeBridge do
  @moduledoc """
  Manages an Erlang Port to a bun worker process that bridges to the Claude CLI.
  Communicates via line-delimited JSON-RPC 2.0 over stdin/stdout.
  """
  use GenServer
  require Logger

  @default_timeout 120_000

  defstruct [
    :port,
    :worker_path,
    pending: %{},
    next_id: 1,
    notification_handler: nil
  ]

  # --- Public API ---

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  def initialize(bridge \\ __MODULE__, opts \\ []) do
    call(bridge, "initialize", %{}, opts)
  end

  def session_start(bridge \\ __MODULE__, config, opts \\ []) do
    call(bridge, "session/start", config, opts)
  end

  def turn_start(bridge \\ __MODULE__, params, opts \\ []) do
    timeout = Keyword.get(opts, :timeout, 600_000)
    call(bridge, "turn/start", params, [{:timeout, timeout} | opts])
  end

  def turn_stop(bridge \\ __MODULE__, session_id, opts \\ []) do
    call(bridge, "turn/stop", %{session_id: session_id}, opts)
  end

  def session_stop(bridge \\ __MODULE__, session_id, opts \\ []) do
    call(bridge, "session/stop", %{session_id: session_id}, opts)
  end

  def shutdown(bridge \\ __MODULE__, opts \\ []) do
    call(bridge, "shutdown", %{}, opts)
  end

  def set_notification_handler(bridge \\ __MODULE__, handler) do
    GenServer.call(bridge, {:set_notification_handler, handler})
  end

  # --- GenServer Callbacks ---

  @impl true
  def init(opts) do
    worker_path = Keyword.get(opts, :worker_path, default_worker_path())
    notification_handler = Keyword.get(opts, :notification_handler)

    port = open_port(worker_path)

    state = %__MODULE__{
      port: port,
      worker_path: worker_path,
      notification_handler: notification_handler
    }

    {:ok, state}
  end

  @impl true
  def handle_call({:set_notification_handler, handler}, _from, state) do
    {:reply, :ok, %{state | notification_handler: handler}}
  end

  def handle_call({:rpc, method, params, timeout}, from, state) do
    id = state.next_id
    request = Jason.encode!(%{jsonrpc: "2.0", id: id, method: method, params: params})
    Port.command(state.port, request <> "\n")

    timer_ref = Process.send_after(self(), {:rpc_timeout, id}, timeout)
    pending = Map.put(state.pending, id, {from, timer_ref})

    {:noreply, %{state | pending: pending, next_id: id + 1}}
  end

  @impl true
  def handle_info({port, {:data, {:eol, line}}}, %{port: port} = state) do
    case Jason.decode(line) do
      {:ok, %{"jsonrpc" => "2.0", "id" => id} = msg} when not is_nil(id) ->
        handle_response(msg, id, state)

      {:ok, %{"jsonrpc" => "2.0", "method" => method} = msg} ->
        handle_notification(method, msg["params"] || %{}, state)
        {:noreply, state}

      {:ok, _other} ->
        Logger.debug("NodeBridge ignoring message: #{line}")
        {:noreply, state}

      {:error, _} ->
        Logger.warning("NodeBridge unparseable line: #{inspect(line)}")
        {:noreply, state}
    end
  end

  def handle_info({port, {:exit_status, status}}, %{port: port} = state) do
    Logger.error("NodeBridge worker exited with status #{status}")

    # Fail all pending requests
    for {id, {from, timer_ref}} <- state.pending do
      Process.cancel_timer(timer_ref)
      GenServer.reply(from, {:error, {:worker_exit, status}})
      _ = id
    end

    {:stop, {:worker_exit, status}, %{state | pending: %{}, port: nil}}
  end

  def handle_info({:rpc_timeout, id}, state) do
    case Map.pop(state.pending, id) do
      {{from, _timer_ref}, pending} ->
        GenServer.reply(from, {:error, :timeout})
        {:noreply, %{state | pending: pending}}

      {nil, _} ->
        {:noreply, state}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, %{port: port}) when not is_nil(port) do
    # Best-effort shutdown
    try do
      request = Jason.encode!(%{jsonrpc: "2.0", id: 0, method: "shutdown", params: %{}})
      Port.command(port, request <> "\n")
      Process.sleep(200)
      Port.close(port)
    catch
      _, _ -> :ok
    end
  end

  def terminate(_reason, _state), do: :ok

  # --- Private ---

  defp call(bridge, method, params, opts) do
    timeout = Keyword.get(opts, :timeout, @default_timeout)
    GenServer.call(bridge, {:rpc, method, params, timeout}, timeout + 5_000)
  end

  defp handle_response(msg, id, state) do
    case Map.pop(state.pending, id) do
      {{from, timer_ref}, pending} ->
        Process.cancel_timer(timer_ref)

        reply =
          case msg do
            %{"error" => error} -> {:error, error}
            %{"result" => result} -> {:ok, result}
          end

        GenServer.reply(from, reply)
        {:noreply, %{state | pending: pending}}

      {nil, _} ->
        Logger.warning("NodeBridge received response for unknown id: #{id}")
        {:noreply, state}
    end
  end

  defp handle_notification(method, params, state) do
    if state.notification_handler do
      state.notification_handler.(method, params)
    end

    Phoenix.PubSub.broadcast(
      Symphony.PubSub,
      "symphony:events",
      {:claude_notification, method, params}
    )
  end

  defp open_port(worker_path) do
    Port.open({:spawn_executable, bun_path()}, [
      :binary,
      :exit_status,
      {:line, 1_048_576},
      {:args, ["run", worker_path]},
      {:env, env_list()}
    ])
  end

  defp bun_path do
    System.find_executable("bun") || raise "bun not found in PATH"
  end

  defp env_list do
    # Pass through relevant env vars
    for {k, v} <- System.get_env(),
        k in ~w(HOME PATH ANTHROPIC_API_KEY CLAUDE_CODE_USE_BEDROCK AWS_PROFILE AWS_REGION),
        do: {String.to_charlist(k), String.to_charlist(v)}
  end

  defp default_worker_path do
    Path.join([
      Application.app_dir(:symphony, "priv"),
      "..",
      "..",
      "..",
      "node-worker",
      "src",
      "index.ts"
    ])
    |> Path.expand()
  end
end
