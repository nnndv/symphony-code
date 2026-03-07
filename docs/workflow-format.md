# WORKFLOW.md Format

A WORKFLOW.md file has two sections separated by `---` delimiters: YAML front matter (configuration) and a Liquid template (agent prompt).

## Structure

```markdown
---
<yaml configuration>
---

<liquid template — the prompt sent to each agent>
```

## YAML Configuration Keys

### `tracker`

| Key | Type | Default | Description |
|---|---|---|---|
| `tracker.kind` | string | `"github"` | Issue tracker type (only `github` supported) |
| `tracker.repo` | string | **required** | GitHub repo in `owner/name` format |
| `tracker.labels` | string[] | `["symphony"]` | Labels to filter issues by |
| `tracker.active_states` | string[] | `["open"]` | Issue states to consider active |
| `tracker.terminal_states` | string[] | `["closed"]` | Issue states to consider done |

### `polling`

| Key | Type | Default | Description |
|---|---|---|---|
| `polling.interval_ms` | number | `30000` | Milliseconds between poll cycles |

### `workspace`

| Key | Type | Default | Description |
|---|---|---|---|
| `workspace.root` | string | `~/.symphony/workspaces` | Base directory for agent workspaces |

### `hooks`

| Key | Type | Default | Description |
|---|---|---|---|
| `hooks.timeout_ms` | number | `60000` | Max hook execution time |
| `hooks.after_create` | string | — | Shell command after workspace creation |
| `hooks.before_run` | string | — | Shell command before agent runs |
| `hooks.after_run` | string | — | Shell command after agent completes |
| `hooks.before_remove` | string | — | Shell command before workspace cleanup |

Hook commands support `{{identifier}}`, `{{title}}`, `{{number}}` interpolation.

### `agent`

| Key | Type | Default | Description |
|---|---|---|---|
| `agent.max_concurrent_agents` | number | `5` | Max agents running simultaneously |
| `agent.max_turns` | number | `20` | Max Claude conversation turns per issue |
| `agent.max_retry_backoff_ms` | number | `300000` | Cap on exponential retry backoff |
| `agent.stall_timeout_ms` | number | `300000` | Kill agents after this inactivity period |

### `claude`

| Key | Type | Default | Description |
|---|---|---|---|
| `claude.model` | string | `"claude-sonnet-4-5-20250929"` | Claude model ID |
| `claude.permission_mode` | string | `"acceptEdits"` | Claude CLI permission mode |
| `claude.allowed_tools` | string[] | `["Read","Write","Edit","Bash","Glob","Grep"]` | Tools the agent may use |
| `claude.max_turns` | number | — | Overrides `agent.max_turns` if set |

### Environment Variable Resolution

String values starting with `$` are resolved from environment variables:

```yaml
tracker:
  repo: $SYMPHONY_REPO   # reads process.env.SYMPHONY_REPO
```

Inline `$VAR` references are also expanded: `"prefix-$VAR-suffix"`.

## Liquid Template Variables

The template body is rendered per-issue with these variables:

| Variable | Type | Description |
|---|---|---|
| `identifier` | string | Issue number as string |
| `number` | number | Issue number |
| `title` | string | Issue title |
| `description` | string | Issue body (alias: `body`) |
| `body` | string | Issue body |
| `state` | string | Issue state (`open`, `closed`) |
| `labels` | string[] | Issue label names |
| `assignees` | string[] | Assignee login names |
| `url` | string | Issue URL |
| `priority` | string | Parsed priority (`p1`-`p4`) |
| `blockers` | string[] | Blocker issue numbers (from `blocked by #N`) |
| `repo` | string | Repository in `owner/name` format |

## Example

```markdown
---
tracker:
  repo: myorg/myrepo
  labels: ["symphony"]

agent:
  max_concurrent_agents: 3
  max_turns: 30

claude:
  model: claude-sonnet-4-5-20250929
  permission_mode: acceptEdits

hooks:
  after_create: "git clone https://github.com/{{identifier}} ."
  before_run: "npm install"
---

You are working on issue #{{identifier}}: {{title}}

## Description
{{description}}

## Instructions
Implement the requested changes. Create a branch, make commits, and open a PR.
```
