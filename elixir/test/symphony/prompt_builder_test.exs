defmodule Symphony.PromptBuilderTest do
  use ExUnit.Case, async: true

  alias Symphony.{PromptBuilder, GitHub.Issue}

  test "renders template with issue context" do
    issue = %Issue{
      number: 42,
      title: "Fix the widget",
      body: "The widget is broken",
      state: "open",
      labels: ["symphony"],
      assignees: [],
      url: "",
      priority: :p2,
      blockers: []
    }

    template = ~S"Issue #{{identifier}}: {{title}} - {{description}}"
    assert {:ok, result} = PromptBuilder.render(template, issue)
    assert result =~ "Issue #42: Fix the widget - The widget is broken"
  end

  test "returns error for invalid template" do
    issue = %Issue{number: 1, title: "Test"}
    assert {:error, {:template_error, _}} = PromptBuilder.render("{% invalid", issue)
  end
end
