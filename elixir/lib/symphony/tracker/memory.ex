defmodule Symphony.Tracker.Memory do
  @moduledoc "In-memory tracker for tests."
  @behaviour Symphony.Tracker

  use Agent

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    Agent.start_link(fn -> %{issues: %{}, comments: %{}} end, name: name)
  end

  def add_issue(agent \\ __MODULE__, issue) do
    Agent.update(agent, fn state ->
      id = Symphony.GitHub.Issue.identifier(issue)
      put_in(state, [:issues, id], issue)
    end)
  end

  @impl true
  def list_issues(_opts \\ []) do
    issues = Agent.get(__MODULE__, & &1.issues) |> Map.values()
    {:ok, Enum.filter(issues, &(&1.state == "open"))}
  end

  @impl true
  def get_issue(identifier) do
    case Agent.get(__MODULE__, &get_in(&1, [:issues, identifier])) do
      nil -> {:error, :not_found}
      issue -> {:ok, issue}
    end
  end

  @impl true
  def comment(identifier, body) do
    Agent.update(__MODULE__, fn state ->
      comments = Map.get(state.comments, identifier, [])
      put_in(state, [:comments, identifier], comments ++ [body])
    end)

    :ok
  end

  @impl true
  def close(identifier) do
    Agent.update(__MODULE__, fn state ->
      case get_in(state, [:issues, identifier]) do
        nil -> state
        issue -> put_in(state, [:issues, identifier], %{issue | state: "closed"})
      end
    end)

    :ok
  end

  @impl true
  def issue_open?(identifier) do
    case get_issue(identifier) do
      {:ok, %{state: "open"}} -> true
      _ -> false
    end
  end

  def get_comments(agent \\ __MODULE__, identifier) do
    Agent.get(agent, &Map.get(&1.comments, identifier, []))
  end
end
