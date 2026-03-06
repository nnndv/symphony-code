defmodule Symphony.ConfigTest do
  use ExUnit.Case

  alias Symphony.Config

  test "returns defaults for unconfigured keys" do
    assert Config.poll_interval_ms() == 30_000
    assert Config.max_concurrent() == 5
    assert Config.max_turns() == 20
    assert Config.model() == "claude-sonnet-4-5-20250929"
    assert Config.permission_mode() == "acceptEdits"
  end

  test "apply_workflow sets config from map" do
    config = %{
      "polling" => %{"interval_ms" => 15_000},
      "claude" => %{"model" => "claude-opus-4-5-20250630"},
      "tracker" => %{"repo" => "test/repo", "labels" => ["auto"]}
    }

    Config.apply_workflow(config)

    assert Application.get_env(:symphony, :poll_interval_ms) == 15_000
    assert Application.get_env(:symphony, :model) == "claude-opus-4-5-20250630"
    assert Application.get_env(:symphony, :tracker_repo) == "test/repo"
    assert Application.get_env(:symphony, :tracker_labels) == ["auto"]
  after
    # Clean up
    for key <- [:poll_interval_ms, :model, :tracker_repo, :tracker_labels] do
      Application.delete_env(:symphony, key)
    end
  end

  test "resolve_env expands environment variables" do
    System.put_env("TEST_SYMPHONY_VAR", "/tmp/test")

    config = %{"workspace" => %{"root" => "$TEST_SYMPHONY_VAR"}}
    Config.apply_workflow(config)

    assert Application.get_env(:symphony, :workspace_root) == "/tmp/test"
  after
    System.delete_env("TEST_SYMPHONY_VAR")
    Application.delete_env(:symphony, :workspace_root)
  end
end
