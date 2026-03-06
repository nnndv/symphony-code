defmodule Symphony.Orchestrator do
  @moduledoc """
  Poll-dispatch-monitor GenServer.
  Periodically fetches issues from the tracker, dispatches agent runs,
  handles retries, stall detection, and reconciliation.
  """
  use GenServer
  require Logger

  alias Symphony.{Config, AgentRunner}

  defstruct [
    :tracker,
    :bridge,
    :workflow,
    :hooks,
    :task_supervisor,
    running: %{},
    completed: MapSet.new(),
    claimed: MapSet.new(),
    retry_queue: [],
    token_totals: %{cost_usd: 0.0, turns: 0},
    monitors: %{}
  ]

  # --- Public API ---

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  def state(name \\ __MODULE__) do
    GenServer.call(name, :get_state)
  end

  def refresh(name \\ __MODULE__) do
    send(name, :tick)
    :ok
  end

  # --- Callbacks ---

  @impl true
  def init(opts) do
    tracker = Keyword.get(opts, :tracker, Symphony.GitHub.Adapter)
    bridge = Keyword.get(opts, :bridge, Symphony.Claude.NodeBridge)
    workflow = Keyword.get(opts, :workflow)
    hooks = Keyword.get(opts, :hooks, %{})
    task_supervisor = Keyword.get(opts, :task_supervisor, Symphony.TaskSupervisor)

    state = %__MODULE__{
      tracker: tracker,
      bridge: bridge,
      workflow: workflow,
      hooks: hooks,
      task_supervisor: task_supervisor
    }

    schedule_tick(Config.poll_interval_ms())
    {:ok, state}
  end

  @impl true
  def handle_call(:get_state, _from, state) do
    snapshot = %{
      running: Map.keys(state.running),
      completed: MapSet.to_list(state.completed),
      claimed: MapSet.to_list(state.claimed),
      retry_queue: Enum.map(state.retry_queue, fn {id, attempt, _} -> {id, attempt} end),
      token_totals: state.token_totals
    }

    {:reply, snapshot, state}
  end

  @impl true
  def handle_info(:tick, state) do
    state = poll_and_dispatch(state)
    state = check_stalls(state)
    state = process_retries(state)
    schedule_tick(Config.poll_interval_ms())
    {:noreply, state}
  end

  # Task completion
  def handle_info({ref, {:ok, result}}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    state = handle_task_success(ref, result, state)
    {:noreply, state}
  end

  def handle_info({ref, {:error, reason}}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    state = handle_task_failure(ref, reason, state)
    {:noreply, state}
  end

  # Task crash
  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    state = handle_task_failure(ref, {:crash, reason}, state)
    {:noreply, state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    Logger.info("[Orchestrator] Shutting down, stopping #{map_size(state.running)} running agents")

    for {_id, %{task: task}} <- state.running do
      Task.Supervisor.terminate_child(state.task_supervisor, task.pid)
    end

    :ok
  end

  # --- Private ---

  defp poll_and_dispatch(state) do
    case state.tracker.list_issues() do
      {:ok, issues} ->
        candidates = filter_candidates(issues, state)
        dispatch_candidates(candidates, state)

      {:error, reason} ->
        Logger.error("[Orchestrator] Poll failed: #{inspect(reason)}")
        state
    end
  end

  defp filter_candidates(issues, state) do
    running_ids = MapSet.new(Map.keys(state.running))
    all_issue_numbers = MapSet.new(Enum.map(issues, &Symphony.GitHub.Issue.identifier/1))

    issues
    |> Enum.filter(fn issue ->
      id = Symphony.GitHub.Issue.identifier(issue)

      not MapSet.member?(running_ids, id) and
        not MapSet.member?(state.completed, id) and
        not MapSet.member?(state.claimed, id) and
        issue.state == "open" and
        blockers_resolved?(issue, all_issue_numbers, state)
    end)
    |> Enum.sort_by(&priority_sort_key/1)
  end

  defp blockers_resolved?(issue, _all_ids, state) do
    Enum.all?(issue.blockers, fn blocker_num ->
      blocker_id = to_string(blocker_num)
      MapSet.member?(state.completed, blocker_id)
    end)
  end

  defp priority_sort_key(issue) do
    case issue.priority do
      :p1 -> 1
      :p2 -> 2
      :p3 -> 3
      :p4 -> 4
    end
  end

  defp dispatch_candidates(candidates, state) do
    slots = Config.max_concurrent() - map_size(state.running)

    candidates
    |> Enum.take(max(slots, 0))
    |> Enum.reduce(state, &dispatch_issue/2)
  end

  defp dispatch_issue(issue, state) do
    identifier = Symphony.GitHub.Issue.identifier(issue)
    Logger.info("[Orchestrator] Dispatching issue ##{identifier}: #{issue.title}")

    task =
      Task.Supervisor.async_nolink(state.task_supervisor, fn ->
        AgentRunner.run(issue,
          bridge: state.bridge,
          tracker: state.tracker,
          hooks: state.hooks,
          workflow: state.workflow
        )
      end)

    running =
      Map.put(state.running, identifier, %{
        task: task,
        issue: issue,
        started_at: System.monotonic_time(:millisecond),
        last_event_at: System.monotonic_time(:millisecond)
      })

    claimed = MapSet.put(state.claimed, identifier)

    broadcast(:issue_dispatched, %{issue_number: identifier, title: issue.title})

    %{state | running: running, claimed: claimed}
  end

  defp handle_task_success(ref, result, state) do
    case find_by_ref(ref, state) do
      {identifier, _info} ->
        running = Map.delete(state.running, identifier)
        completed = MapSet.put(state.completed, identifier)

        cost = result[:cost_usd] || 0
        turns = result[:num_turns] || 0

        totals = %{
          cost_usd: state.token_totals.cost_usd + cost,
          turns: state.token_totals.turns + turns
        }

        broadcast(:issue_completed, %{issue_number: identifier, cost_usd: cost, turns: turns})

        %{state | running: running, completed: completed, token_totals: totals}

      nil ->
        state
    end
  end

  defp handle_task_failure(ref, reason, state) do
    case find_by_ref(ref, state) do
      {identifier, _info} ->
        Logger.error("[Orchestrator] Issue ##{identifier} failed: #{inspect(reason)}")
        running = Map.delete(state.running, identifier)

        # Schedule retry with exponential backoff
        attempt = retry_attempt(identifier, state) + 1
        max_backoff = Config.max_retry_backoff_ms()
        backoff = min(round(:math.pow(2, attempt) * 1_000), max_backoff)
        retry_at = System.monotonic_time(:millisecond) + backoff

        retry_queue = state.retry_queue ++ [{identifier, attempt, retry_at}]

        broadcast(:issue_failed, %{
          issue_number: identifier,
          error: inspect(reason),
          retry_attempt: attempt,
          retry_in_ms: backoff
        })

        %{state | running: running, retry_queue: retry_queue}

      nil ->
        state
    end
  end

  defp check_stalls(state) do
    now = System.monotonic_time(:millisecond)
    stall_timeout = Config.stall_timeout_ms()

    stalled =
      Enum.filter(state.running, fn {_id, info} ->
        now - info.last_event_at > stall_timeout
      end)

    Enum.reduce(stalled, state, fn {identifier, info}, acc ->
      Logger.warning("[Orchestrator] Issue ##{identifier} stalled, killing")
      Task.Supervisor.terminate_child(acc.task_supervisor, info.task.pid)
      running = Map.delete(acc.running, identifier)
      %{acc | running: running}
    end)
  end

  defp process_retries(state) do
    now = System.monotonic_time(:millisecond)

    {ready, pending} =
      Enum.split_with(state.retry_queue, fn {_, _, retry_at} -> retry_at <= now end)

    state = %{state | retry_queue: pending}

    Enum.reduce(ready, state, fn {identifier, _attempt, _}, acc ->
      # Re-fetch the issue to check if still open
      case acc.tracker.get_issue(identifier) do
        {:ok, issue} when issue.state == "open" ->
          # Remove from claimed so it can be redispatched
          claimed = MapSet.delete(acc.claimed, identifier)
          %{acc | claimed: claimed}

        _ ->
          Logger.info("[Orchestrator] Issue ##{identifier} no longer open, skipping retry")
          acc
      end
    end)
  end

  defp find_by_ref(ref, state) do
    Enum.find(state.running, fn {_id, info} -> info.task.ref == ref end)
    |> case do
      {id, info} -> {id, info}
      nil -> nil
    end
  end

  defp retry_attempt(identifier, state) do
    case Enum.find(state.retry_queue, fn {id, _, _} -> id == identifier end) do
      {_, attempt, _} -> attempt
      nil -> 0
    end
  end

  defp schedule_tick(interval) do
    Process.send_after(self(), :tick, interval)
  end

  defp broadcast(event, payload) do
    Phoenix.PubSub.broadcast(
      Symphony.PubSub,
      "symphony:events",
      {event, payload}
    )
  end
end
