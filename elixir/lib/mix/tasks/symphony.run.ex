defmodule Mix.Tasks.Symphony.Run do
  @moduledoc """
  Starts the Symphony orchestrator.

      mix symphony.run --workflow WORKFLOW.md [--port 4000] [--no-tui]

  Options:
    --workflow   Path to WORKFLOW.md file (required)
    --port       HTTP port for web dashboard (default: 4000)
    --no-tui     Disable the terminal dashboard
  """
  use Mix.Task

  @shortdoc "Start the Symphony orchestrator"

  @impl true
  def run(args) do
    {opts, _, _} =
      OptionParser.parse(args,
        strict: [workflow: :string, port: :integer, no_tui: :boolean],
        aliases: [w: :workflow, p: :port]
      )

    workflow_path = Keyword.get(opts, :workflow) || raise "Missing --workflow flag"
    port = Keyword.get(opts, :port, 4000)
    tui = not Keyword.get(opts, :no_tui, false)

    # Configure before starting the app
    Application.put_env(:symphony, :workflow_path, Path.expand(workflow_path))
    Application.put_env(:symphony, :start_bridge, true)
    Application.put_env(:symphony, :start_orchestrator, true)
    Application.put_env(:symphony, :start_dashboard, tui)
    Application.put_env(:symphony, SymphonyWeb.Endpoint, http: [port: port])

    Mix.Task.run("app.start")

    Mix.shell().info("Symphony running on http://localhost:#{port}")
    Mix.shell().info("Workflow: #{workflow_path}")
    Mix.shell().info("Press Ctrl+C to stop\n")

    # Block forever
    Process.sleep(:infinity)
  end
end
