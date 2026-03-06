defmodule Symphony.StatusDashboard do
  @moduledoc """
  ANSI terminal TUI that subscribes to PubSub and renders
  a live table of running agents, retry queue, and cost/tokens.
  """
  use GenServer
  require Logger

  @refresh_interval 1_000

  defstruct [
    running: %{},
    completed: [],
    retry_queue: [],
    totals: %{cost_usd: 0.0, turns: 0},
    enabled: true
  ]

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @impl true
  def init(opts) do
    enabled = Keyword.get(opts, :enabled, true)

    if enabled do
      Phoenix.PubSub.subscribe(Symphony.PubSub, "symphony:events")
      schedule_render()
    end

    {:ok, %__MODULE__{enabled: enabled}}
  end

  @impl true
  def handle_info(:render, state) do
    if state.enabled, do: render(state)
    schedule_render()
    {:noreply, state}
  end

  def handle_info({:issue_dispatched, payload}, state) do
    running = Map.put(state.running, payload.issue_number, %{
      title: payload.title,
      started_at: System.monotonic_time(:second)
    })
    {:noreply, %{state | running: running}}
  end

  def handle_info({:issue_completed, payload}, state) do
    running = Map.delete(state.running, payload.issue_number)
    completed = [{payload.issue_number, payload.cost_usd} | state.completed] |> Enum.take(20)
    totals = %{
      cost_usd: state.totals.cost_usd + (payload.cost_usd || 0),
      turns: state.totals.turns + (payload.turns || 0)
    }
    {:noreply, %{state | running: running, completed: completed, totals: totals}}
  end

  def handle_info({:issue_failed, payload}, state) do
    running = Map.delete(state.running, payload.issue_number)
    retry_queue = [{payload.issue_number, payload.retry_attempt} | state.retry_queue] |> Enum.take(20)
    {:noreply, %{state | running: running, retry_queue: retry_queue}}
  end

  def handle_info({:agent_started, _}, state), do: {:noreply, state}
  def handle_info({:agent_completed, _}, state), do: {:noreply, state}
  def handle_info({:agent_failed, _}, state), do: {:noreply, state}
  def handle_info({:claude_notification, _, _}, state), do: {:noreply, state}
  def handle_info(_msg, state), do: {:noreply, state}

  defp render(state) do
    now = System.monotonic_time(:second)

    # Clear screen and move cursor to top
    IO.write("\e[2J\e[H")
    IO.puts("\e[1;36m=== Symphony Status Dashboard ===\e[0m\n")

    # Running agents
    IO.puts("\e[1;33mRunning Agents (#{map_size(state.running)}):\e[0m")

    if map_size(state.running) == 0 do
      IO.puts("  (none)")
    else
      IO.puts("  \e[90m#{String.pad_trailing("#", 8)}  #{String.pad_trailing("Title", 50)}  Duration\e[0m")

      for {num, info} <- Enum.sort(state.running) do
        elapsed = now - info.started_at
        title = String.slice(info.title, 0, 48)
        IO.puts("  #{String.pad_trailing("##{num}", 8)}  #{String.pad_trailing(title, 50)}  #{format_duration(elapsed)}")
      end
    end

    IO.puts("")

    # Retry queue
    unless Enum.empty?(state.retry_queue) do
      IO.puts("\e[1;31mRetry Queue:\e[0m")
      for {num, attempt} <- state.retry_queue do
        IO.puts("  ##{num} (attempt #{attempt})")
      end
      IO.puts("")
    end

    # Recent completions
    unless Enum.empty?(state.completed) do
      IO.puts("\e[1;32mRecent Completions:\e[0m")
      for {num, cost} <- Enum.take(state.completed, 5) do
        IO.puts("  ##{num} ($#{Float.round(cost * 1.0, 4)})")
      end
      IO.puts("")
    end

    # Totals
    IO.puts("\e[1mTotals:\e[0m  Cost: $#{Float.round(state.totals.cost_usd, 4)}  |  Turns: #{state.totals.turns}")
  end

  defp format_duration(seconds) when seconds < 60, do: "#{seconds}s"
  defp format_duration(seconds), do: "#{div(seconds, 60)}m #{rem(seconds, 60)}s"

  defp schedule_render do
    Process.send_after(self(), :render, @refresh_interval)
  end
end
