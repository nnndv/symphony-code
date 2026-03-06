defmodule Symphony.WorkspaceTest do
  use ExUnit.Case, async: true

  alias Symphony.{Workspace, GitHub.Issue}

  setup do
    root = Path.join(System.tmp_dir!(), "symphony_test_#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf!(root) end)
    %{root: root}
  end

  test "create makes a directory for an issue", %{root: root} do
    issue = %Issue{number: 42, title: "Test"}
    assert {:ok, dir} = Workspace.create(issue, root: root)
    assert File.dir?(dir)
    assert String.ends_with?(dir, "issue-42")
  end

  test "remove deletes a workspace directory", %{root: root} do
    issue = %Issue{number: 99, title: "Remove test"}
    {:ok, dir} = Workspace.create(issue, root: root)
    assert File.dir?(dir)

    assert :ok = Workspace.remove(dir, root: root)
    refute File.dir?(dir)
  end

  test "list returns existing workspace dirs", %{root: root} do
    for n <- [1, 2, 3] do
      File.mkdir_p!(Path.join(root, "issue-#{n}"))
    end

    dirs = Workspace.list(root)
    assert length(dirs) == 3
  end

  test "runs after_create hook", %{root: root} do
    issue = %Issue{number: 50, title: "Hook test"}
    hooks = %{"after_create" => "touch hook_ran.txt"}

    assert {:ok, dir} = Workspace.create(issue, root: root, hooks: hooks)
    assert File.exists?(Path.join(dir, "hook_ran.txt"))
  end

  test "hook failure returns error", %{root: root} do
    issue = %Issue{number: 51, title: "Fail hook"}
    hooks = %{"after_create" => "exit 1"}

    assert {:error, {:hook_failed, "after_create", 1}} =
             Workspace.create(issue, root: root, hooks: hooks)
  end
end
