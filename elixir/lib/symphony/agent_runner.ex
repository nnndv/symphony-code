defmodule Symphony.AgentRunner do
  @moduledoc """
  Executes the full agent pipeline for a single issue:
  workspace creation -> hooks -> NodeBridge session -> prompt -> result -> cleanup.
  """
  require Logger

  alias Symphony.{Config, Workspace, PromptBuilder}
  alias Symphony.Claude.NodeBridge

  defstruct [
    :issue,
    :workspace_dir,
    :session_id,
    :bridge,
    :tracker,
    :hooks,
    :workflow
  ]

  @default_template ~S"""
  You are working on issue #{{identifier}}: {{title}}

  ## Description
  {{description}}

  ## Instructions
  Implement the requested changes. Create a branch, make commits, and open a PR when done.
  """

  @doc """
  Run the full agent pipeline for an issue. Returns {:ok, result} or {:error, reason}.
  Called from Task.Supervisor.async_nolink in the Orchestrator.
  """
  def run(issue, opts \\ []) do
    bridge = Keyword.get(opts, :bridge, NodeBridge)
    tracker = Keyword.get(opts, :tracker, Symphony.GitHub.Adapter)
    hooks = Keyword.get(opts, :hooks, %{})
    workflow = Keyword.get(opts, :workflow)

    identifier = Symphony.GitHub.Issue.identifier(issue)
    session_id = "symphony-#{identifier}-#{System.unique_integer([:positive])}"

    Logger.info("[AgentRunner] Starting issue ##{identifier}: #{issue.title}")

    broadcast(:agent_started, %{issue_number: identifier, title: issue.title})

    runner = %__MODULE__{
      issue: issue,
      session_id: session_id,
      bridge: bridge,
      tracker: tracker,
      hooks: hooks,
      workflow: workflow
    }

    result = run_pipeline(runner, identifier)

    # Always try to clean up workspace
    if runner.workspace_dir do
      Workspace.remove(runner.workspace_dir, hooks: hooks)
    end

    result
  end

  defp run_pipeline(runner, identifier) do
    with {:ok, dir} <- create_workspace(runner),
         runner = %{runner | workspace_dir: dir},
         :ok <- Workspace.before_run(dir, runner.issue, hooks: runner.hooks),
         {:ok, prompt} <- build_prompt(runner),
         {:ok, result} <- execute_agent(runner, prompt),
         :ok <- post_result(runner, result),
         :ok <- Workspace.after_run(dir, runner.issue, hooks: runner.hooks) do
      broadcast(:agent_completed, %{
        issue_number: identifier,
        result: result.result,
        cost_usd: result.cost_usd,
        num_turns: result.num_turns
      })

      Logger.info("[AgentRunner] Completed issue ##{identifier} (#{result.num_turns} turns, $#{result.cost_usd})")
      {:ok, result}
    else
      {:error, reason} = err ->
        Logger.error("[AgentRunner] Failed issue ##{identifier}: #{inspect(reason)}")
        broadcast(:agent_failed, %{issue_number: identifier, error: inspect(reason)})
        try_comment(runner, "Symphony agent failed: #{inspect(reason)}")
        err
    end
  end

  # --- Pipeline Steps ---

  defp create_workspace(runner) do
    Workspace.create(runner.issue, hooks: runner.hooks)
  end

  defp build_prompt(runner) do
    template =
      if runner.workflow do
        runner.workflow.template
      else
        @default_template
      end

    PromptBuilder.render(template, runner.issue)
  end

  defp execute_agent(runner, prompt) do
    _identifier = Symphony.GitHub.Issue.identifier(runner.issue)

    session_config = %{
      session_id: runner.session_id,
      model: Config.model(),
      permission_mode: Config.permission_mode(),
      allowed_tools: Config.allowed_tools(),
      max_turns: Config.max_turns(),
      workspace_dir: runner.workspace_dir
    }

    with {:ok, _} <- NodeBridge.session_start(runner.bridge, session_config),
         {:ok, result} <- NodeBridge.turn_start(runner.bridge, %{
           session_id: runner.session_id,
           prompt: prompt
         }, timeout: 600_000) do
      NodeBridge.session_stop(runner.bridge, runner.session_id)

      {:ok, %{
        result: result["result"] || "",
        cost_usd: result["cost_usd"] || 0,
        num_turns: result["num_turns"] || 0
      }}
    else
      {:error, reason} ->
        NodeBridge.session_stop(runner.bridge, runner.session_id)
        {:error, {:agent_execution, reason}}
    end
  end

  defp post_result(runner, result) do
    identifier = Symphony.GitHub.Issue.identifier(runner.issue)
    cost = result.cost_usd
    turns = result.num_turns

    body = """
    ## Symphony Agent Result

    **Status:** Completed
    **Turns:** #{turns}
    **Cost:** $#{Float.round(cost * 1.0, 4)}

    ### Output
    #{String.slice(result.result, 0, 60_000)}
    """

    runner.tracker.comment(identifier, body)
  end

  defp try_comment(runner, message) do
    if runner.tracker && runner.issue do
      identifier = Symphony.GitHub.Issue.identifier(runner.issue)
      runner.tracker.comment(identifier, message)
    end
  rescue
    _ -> :ok
  end

  defp broadcast(event, payload) do
    Phoenix.PubSub.broadcast(
      Symphony.PubSub,
      "symphony:events",
      {event, payload}
    )
  end
end
