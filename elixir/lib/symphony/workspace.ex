defmodule Symphony.Workspace do
  @moduledoc """
  Manages per-issue workspace directories.
  Creates isolated dirs, runs hooks, prevents symlink escapes.
  """
  require Logger

  @type hook_config :: %{optional(String.t()) => String.t()}

  @doc "Create a workspace directory for an issue, run after_create hook."
  def create(issue, opts \\ []) do
    root = Keyword.get(opts, :root, Symphony.Config.workspace_root())
    hooks = Keyword.get(opts, :hooks, %{})
    hook_timeout = Keyword.get(opts, :hook_timeout, 60_000)

    identifier = Symphony.GitHub.Issue.identifier(issue)
    dir = Path.join(root, "issue-#{identifier}")

    with :ok <- File.mkdir_p(dir),
         :ok <- validate_path(dir, root),
         :ok <- run_hook(hooks, "after_create", dir, issue, hook_timeout) do
      {:ok, dir}
    end
  end

  @doc "Remove a workspace directory, running before_remove hook first."
  def remove(dir, opts \\ []) do
    hooks = Keyword.get(opts, :hooks, %{})
    hook_timeout = Keyword.get(opts, :hook_timeout, 60_000)
    root = Keyword.get(opts, :root, Symphony.Config.workspace_root())

    with :ok <- validate_path(dir, root),
         :ok <- run_hook(hooks, "before_remove", dir, nil, hook_timeout) do
      File.rm_rf(dir)
      :ok
    end
  end

  @doc "Run the before_run hook."
  def before_run(dir, issue, opts \\ []) do
    hooks = Keyword.get(opts, :hooks, %{})
    hook_timeout = Keyword.get(opts, :hook_timeout, 60_000)
    run_hook(hooks, "before_run", dir, issue, hook_timeout)
  end

  @doc "Run the after_run hook."
  def after_run(dir, issue, opts \\ []) do
    hooks = Keyword.get(opts, :hooks, %{})
    hook_timeout = Keyword.get(opts, :hook_timeout, 60_000)
    run_hook(hooks, "after_run", dir, issue, hook_timeout)
  end

  @doc "List existing workspace directories."
  def list(root \\ nil) do
    root = root || Symphony.Config.workspace_root()

    case File.ls(root) do
      {:ok, entries} ->
        entries
        |> Enum.filter(&String.starts_with?(&1, "issue-"))
        |> Enum.map(&Path.join(root, &1))

      {:error, :enoent} ->
        []
    end
  end

  # Prevent symlink escape
  defp validate_path(dir, root) do
    real_dir = dir |> Path.expand() |> resolve_symlinks()
    real_root = root |> Path.expand() |> resolve_symlinks()

    if String.starts_with?(real_dir, real_root) do
      :ok
    else
      {:error, {:symlink_escape, dir}}
    end
  end

  defp resolve_symlinks(path) do
    case :file.read_link(String.to_charlist(path)) do
      {:ok, target} ->
        target
        |> List.to_string()
        |> Path.expand(Path.dirname(path))
        |> resolve_symlinks()

      {:error, _} ->
        path
    end
  end

  defp run_hook(hooks, name, dir, issue, timeout) do
    case Map.get(hooks, name) do
      nil ->
        :ok

      cmd_template ->
        cmd = render_hook_cmd(cmd_template, issue)
        Logger.info("Running hook #{name}: #{cmd}")

        task =
          Task.async(fn ->
            System.cmd("sh", ["-c", cmd], cd: dir, stderr_to_stdout: true)
          end)

        case Task.yield(task, timeout) || Task.shutdown(task, :brutal_kill) do
          {:ok, {_output, 0}} ->
            :ok

          {:ok, {output, code}} ->
            Logger.error("Hook #{name} failed (exit #{code}): #{output}")
            {:error, {:hook_failed, name, code}}

          nil ->
            Logger.error("Hook #{name} timed out after #{timeout}ms")
            {:error, {:hook_timeout, name}}
        end
    end
  end

  defp render_hook_cmd(template, nil), do: template

  defp render_hook_cmd(template, issue) do
    template
    |> String.replace("{{identifier}}", Symphony.GitHub.Issue.identifier(issue))
    |> String.replace("{{title}}", issue.title || "")
    |> String.replace("{{number}}", to_string(issue.number))
  end
end
