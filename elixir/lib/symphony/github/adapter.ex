defmodule Symphony.GitHub.Adapter do
  @moduledoc "Tracker implementation for GitHub Issues via `gh` CLI."
  @behaviour Symphony.Tracker

  alias Symphony.GitHub.{Client, Issue}
  alias Symphony.Config

  @impl true
  def list_issues(opts \\ []) do
    repo = Keyword.get(opts, :repo, Config.tracker_repo())
    labels = Keyword.get(opts, :labels, Config.tracker_labels())

    case Client.list_issues(repo, labels) do
      {:ok, items} ->
        issues = Enum.map(items, &Issue.from_gh/1)
        {:ok, issues}

      {:error, _} = err ->
        err
    end
  end

  @impl true
  def get_issue(identifier) do
    repo = Config.tracker_repo()
    number = String.to_integer(identifier)

    case Client.get_issue(repo, number) do
      {:ok, item} -> {:ok, Issue.from_gh(item)}
      {:error, _} = err -> err
    end
  end

  @impl true
  def comment(identifier, body) do
    repo = Config.tracker_repo()
    Client.comment(repo, String.to_integer(identifier), body)
  end

  @impl true
  def close(identifier) do
    repo = Config.tracker_repo()
    Client.close(repo, String.to_integer(identifier))
  end

  @impl true
  def issue_open?(identifier) do
    case get_issue(identifier) do
      {:ok, %Issue{state: "open"}} -> true
      _ -> false
    end
  end
end
