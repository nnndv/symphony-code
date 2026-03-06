defmodule Symphony.WorkflowStore do
  @moduledoc """
  GenServer that caches the parsed Workflow and watches the file for changes.
  """
  use GenServer
  require Logger

  defstruct [:workflow, :path, :watcher_pid]

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  def get(store \\ __MODULE__) do
    GenServer.call(store, :get)
  end

  def reload(store \\ __MODULE__) do
    GenServer.call(store, :reload)
  end

  # --- Callbacks ---

  @impl true
  def init(opts) do
    path = Keyword.fetch!(opts, :path)

    case Symphony.Workflow.parse_file(path) do
      {:ok, workflow} ->
        # Apply config to application env
        Symphony.Config.apply_workflow(workflow.config)

        watcher_pid = start_watcher(path)

        {:ok, %__MODULE__{workflow: workflow, path: path, watcher_pid: watcher_pid}}

      {:error, reason} ->
        {:stop, {:workflow_parse_error, reason}}
    end
  end

  @impl true
  def handle_call(:get, _from, state) do
    {:reply, {:ok, state.workflow}, state}
  end

  def handle_call(:reload, _from, state) do
    case Symphony.Workflow.parse_file(state.path) do
      {:ok, workflow} ->
        Symphony.Config.apply_workflow(workflow.config)
        Logger.info("Workflow reloaded from #{state.path}")
        {:reply, :ok, %{state | workflow: workflow}}

      {:error, reason} ->
        Logger.error("Workflow reload failed: #{inspect(reason)}")
        {:reply, {:error, reason}, state}
    end
  end

  @impl true
  def handle_info({:file_event, _watcher, {path, events}}, state) do
    if path == state.path and :modified in events do
      case Symphony.Workflow.parse_file(state.path) do
        {:ok, workflow} ->
          Symphony.Config.apply_workflow(workflow.config)
          Logger.info("Workflow hot-reloaded: #{state.path}")
          {:noreply, %{state | workflow: workflow}}

        {:error, reason} ->
          Logger.warning("Workflow hot-reload failed: #{inspect(reason)}")
          {:noreply, state}
      end
    else
      {:noreply, state}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}

  defp start_watcher(path) do
    dir = Path.dirname(path)

    case FileSystem.start_link(dirs: [dir]) do
      {:ok, pid} ->
        FileSystem.subscribe(pid)
        pid

      {:error, reason} ->
        Logger.warning("Could not start file watcher: #{inspect(reason)}")
        nil
    end
  end
end
