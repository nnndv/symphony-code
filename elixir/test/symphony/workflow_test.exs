defmodule Symphony.WorkflowTest do
  use ExUnit.Case, async: true

  alias Symphony.Workflow

  @sample_workflow ~S"""
  ---
  tracker:
    kind: github
    repo: owner/repo
    labels: ["symphony"]

  polling:
    interval_ms: 30000

  claude:
    model: claude-sonnet-4-5-20250929
    permission_mode: acceptEdits
  ---

  You are working on issue #{{identifier}}: {{title}}

  ## Description
  {{description}}
  """

  test "parses YAML front matter and template" do
    assert {:ok, %Workflow{config: config, template: template}} = Workflow.parse(@sample_workflow)
    assert config["tracker"]["repo"] == "owner/repo"
    assert config["tracker"]["labels"] == ["symphony"]
    assert config["claude"]["model"] == "claude-sonnet-4-5-20250929"
    assert template =~ "You are working on issue"
    assert template =~ "{{identifier}}"
  end

  test "returns error for missing front matter" do
    assert {:error, :no_front_matter} = Workflow.parse("just some text")
  end

  test "returns error for invalid YAML" do
    bad = """
    ---
    [invalid: yaml: {{
    ---
    template
    """

    assert {:error, {:yaml_error, _}} = Workflow.parse(bad)
  end

  test "parse_file reads from disk" do
    path = Path.join(System.tmp_dir!(), "test_workflow_#{System.unique_integer([:positive])}.md")
    File.write!(path, @sample_workflow)

    try do
      assert {:ok, %Workflow{source_path: ^path}} = Workflow.parse_file(path)
    after
      File.rm(path)
    end
  end

  test "parse_file returns error for missing file" do
    assert {:error, {:file_error, :enoent, _}} = Workflow.parse_file("/nonexistent/file.md")
  end
end
