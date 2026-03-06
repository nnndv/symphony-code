defmodule Symphony.GitHub.Client do
  @moduledoc """
  Wraps the `gh` CLI for GitHub API operations.
  """
  require Logger

  @doc "List open issues with given labels for a repo."
  def list_issues(repo, labels \\ [], state \\ "open") do
    label_args = Enum.flat_map(labels, &["--label", &1])

    case gh(["issue", "list", "--repo", repo, "--state", state, "--json",
             "number,title,body,state,labels,assignees,url,createdAt,updatedAt",
             "--limit", "100"] ++ label_args) do
      {:ok, json} ->
        case Jason.decode(json) do
          {:ok, items} -> {:ok, items}
          {:error, _} -> {:error, :json_decode}
        end

      {:error, _} = err ->
        err
    end
  end

  @doc "Get a single issue by number."
  def get_issue(repo, number) do
    case gh(["issue", "view", "--repo", repo, to_string(number), "--json",
             "number,title,body,state,labels,assignees,url,createdAt,updatedAt"]) do
      {:ok, json} ->
        case Jason.decode(json) do
          {:ok, item} -> {:ok, item}
          {:error, _} -> {:error, :json_decode}
        end

      {:error, _} = err ->
        err
    end
  end

  @doc "Add a comment to an issue."
  def comment(repo, number, body) do
    case gh(["issue", "comment", "--repo", repo, to_string(number), "--body", body]) do
      {:ok, _} -> :ok
      {:error, _} = err -> err
    end
  end

  @doc "Close an issue."
  def close(repo, number) do
    case gh(["issue", "close", "--repo", repo, to_string(number)]) do
      {:ok, _} -> :ok
      {:error, _} = err -> err
    end
  end

  defp gh(args) do
    Logger.debug("gh #{Enum.join(args, " ")}")

    case System.cmd("gh", args, stderr_to_stdout: true) do
      {output, 0} -> {:ok, String.trim(output)}
      {output, code} -> {:error, {code, output}}
    end
  end
end
