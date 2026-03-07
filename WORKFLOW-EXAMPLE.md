---
tracker:
  kind: github
  repo: owner/repo
  labels: ["symphony"]
  active_states: ["open"]
  terminal_states: ["closed"]

polling:
  interval_ms: 30000

workspace:
  root: $SYMPHONY_WORKSPACE_ROOT

hooks:
  after_create: "git clone --depth 1 https://github.com/{{repo}} ."
  timeout_ms: 60000

agent:
  max_concurrent_agents: 5
  max_turns: 20
  max_retry_backoff_ms: 300000
  stall_timeout_ms: 300000

claude:
  model: claude-sonnet-4-5-20250929
  permission_mode: acceptEdits
  allowed_tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
  max_turns: 50
---

You are working on issue #{{identifier}}: {{title}}

## Description
{{description}}

## Instructions
Implement the requested changes. Create a branch, make commits, and open a PR.
