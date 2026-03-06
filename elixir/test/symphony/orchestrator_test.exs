defmodule Symphony.OrchestratorTest do
  use ExUnit.Case

  alias Symphony.{Orchestrator, Tracker.Memory, GitHub.Issue}

  setup do
    # PubSub is already started by the application, just ensure TaskSupervisor exists
    case Task.Supervisor.start_link(name: Symphony.TaskSupervisor) do
      {:ok, _} -> :ok
      {:error, {:already_started, _}} -> :ok
    end

    start_supervised!(Memory)

    # Use a long poll interval so ticks don't auto-fire
    Application.put_env(:symphony, :poll_interval_ms, 999_999)
    Application.put_env(:symphony, :max_concurrent, 3)

    on_exit(fn ->
      Application.delete_env(:symphony, :poll_interval_ms)
      Application.delete_env(:symphony, :max_concurrent)
    end)

    :ok
  end

  test "state returns empty snapshot when started" do
    {:ok, pid} =
      Orchestrator.start_link(
        name: :test_orch,
        tracker: Memory,
        task_supervisor: Symphony.TaskSupervisor
      )

    state = Orchestrator.state(:test_orch)
    assert state.running == []
    assert state.completed == []
    assert state.token_totals.cost_usd == 0.0

    GenServer.stop(pid)
  end

  test "refresh triggers a poll" do
    issue = %Issue{
      number: 1,
      title: "Test issue",
      body: "",
      state: "open",
      labels: ["symphony"],
      assignees: [],
      priority: :p3,
      blockers: []
    }

    Memory.add_issue(issue)

    {:ok, pid} =
      Orchestrator.start_link(
        name: :test_orch2,
        tracker: Memory,
        task_supervisor: Symphony.TaskSupervisor
      )

    Orchestrator.refresh(:test_orch2)
    Process.sleep(100)

    state = Orchestrator.state(:test_orch2)
    assert "1" in state.claimed

    GenServer.stop(pid)
  end
end
