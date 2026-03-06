defmodule Symphony.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children =
      [
        SymphonyWeb.Telemetry,
        {Phoenix.PubSub, name: Symphony.PubSub},
        {Task.Supervisor, name: Symphony.TaskSupervisor}
      ] ++
        maybe_workflow_store() ++
        maybe_node_bridge() ++
        maybe_orchestrator() ++
        maybe_dashboard() ++
        [SymphonyWeb.Endpoint]

    opts = [strategy: :one_for_one, name: Symphony.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl true
  def config_change(changed, _new, removed) do
    SymphonyWeb.Endpoint.config_change(changed, removed)
    :ok
  end

  defp maybe_workflow_store do
    case Application.get_env(:symphony, :workflow_path) do
      nil -> []
      path -> [{Symphony.WorkflowStore, path: path}]
    end
  end

  defp maybe_node_bridge do
    if Application.get_env(:symphony, :start_bridge, false) do
      opts =
        case Symphony.Config.node_worker_path() do
          nil -> []
          path -> [worker_path: path]
        end

      [{Symphony.Claude.NodeBridge, opts}]
    else
      []
    end
  end

  defp maybe_orchestrator do
    if Application.get_env(:symphony, :start_orchestrator, false) do
      [{Symphony.Orchestrator, []}]
    else
      []
    end
  end

  defp maybe_dashboard do
    if Application.get_env(:symphony, :start_dashboard, false) do
      [{Symphony.StatusDashboard, []}]
    else
      []
    end
  end
end
