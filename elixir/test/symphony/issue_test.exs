defmodule Symphony.GitHub.IssueTest do
  use ExUnit.Case, async: true

  alias Symphony.GitHub.Issue

  test "from_gh parses a GitHub JSON map" do
    gh_map = %{
      "number" => 42,
      "title" => "Fix the widget",
      "body" => "The widget is broken.\nBlocked by #10 and blocked by #20",
      "state" => "open",
      "labels" => [%{"name" => "P1"}, %{"name" => "symphony"}],
      "assignees" => [%{"login" => "alice"}],
      "url" => "https://github.com/owner/repo/issues/42",
      "createdAt" => "2025-01-01T00:00:00Z",
      "updatedAt" => "2025-01-02T00:00:00Z"
    }

    issue = Issue.from_gh(gh_map)

    assert issue.number == 42
    assert issue.title == "Fix the widget"
    assert issue.state == "open"
    assert issue.priority == :p1
    assert issue.blockers == [10, 20]
    assert "symphony" in issue.labels
    assert "alice" in issue.assignees
  end

  test "identifier returns string number" do
    issue = %Issue{number: 7}
    assert Issue.identifier(issue) == "7"
  end

  test "priority defaults to :p3" do
    issue = Issue.from_gh(%{"number" => 1, "labels" => [], "assignees" => []})
    assert issue.priority == :p3
  end

  test "parses P2 priority" do
    issue = Issue.from_gh(%{
      "number" => 2,
      "labels" => [%{"name" => "P2"}],
      "assignees" => []
    })

    assert issue.priority == :p2
  end
end
