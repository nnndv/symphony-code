---
tracker:
  kind: github
  repo: nnndv/symphony-code-test
  active_states: ["open"]
  terminal_states: ["closed"]

polling:
  interval_ms: 60000

workspace:
  root: /tmp/symphony-e2e

agent:
  max_concurrent_agents: 1
  max_turns: 3
  stall_timeout_ms: 0

hooks:
  timeout_ms: 60000

claude:
  model: claude-sonnet-4-5-20250929
  permission_mode: bypassPermissions
  allowed_tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
---

You are working on issue #{{identifier}}: {{title}}

## Description
{{description}}

## Instructions
Implement the requested changes. Create a branch, make commits, and push to the remote. Open a PR that references this issue.
