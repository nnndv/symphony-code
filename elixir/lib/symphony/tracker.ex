defmodule Symphony.Tracker do
  @moduledoc """
  Behaviour for issue trackers.
  """

  @type issue :: Symphony.GitHub.Issue.t()

  @callback list_issues(opts :: keyword()) :: {:ok, [issue()]} | {:error, term()}
  @callback get_issue(identifier :: String.t()) :: {:ok, issue()} | {:error, term()}
  @callback comment(identifier :: String.t(), body :: String.t()) :: :ok | {:error, term()}
  @callback close(identifier :: String.t()) :: :ok | {:error, term()}
  @callback issue_open?(identifier :: String.t()) :: boolean()
end
