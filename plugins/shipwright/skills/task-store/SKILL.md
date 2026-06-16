---
name: task-store
description: >
  Query and update the Shipwright task store — pick the next ready task, mark status
  transitions, and append new tasks. Use whenever you need to read from or write to
  the task queue. Covers agent env var configuration, script resolution, standard
  lifecycle invocations, and common failure modes.
---

# Task Store — Skill

Use this skill to interact with the Shipwright task store. The task store is a CLI
(`task_store.ts`) that abstracts over JSON-file and GitHub Issues backends. For agents,
the backend is selected via environment variables — no config file needed.

---

## Configuration (agents)

Agents configure the task store via env vars. These take highest precedence and bypass
config file discovery entirely.

| Variable | Required | Description |
|---|---|---|
| `SHIPWRIGHT_TASK_STORE` | Yes | Backend selector: `github`, `json`, or `jira` |
| `SHIPWRIGHT_GITHUB_OWNER` | If `github` | GitHub org or user that owns the task repo |
| `SHIPWRIGHT_GITHUB_REPO` | If `github` | GitHub repo name where issues are created |
| `GH_TOKEN` | If `github` | GitHub token with `repo` scope |

For local Claude Code sessions, the backend is configured via `.shipwright.json` — see
`references/task-store.md` for that path.

---

## Locate the script

Resolve once at the start of any task store operation and reuse within the same step:

```bash
PLUGIN_SCRIPTS=$(find ~/.claude/plugins/cache -maxdepth 5 -name "task_store.ts" -path "*/shipwright/*" 2>/dev/null | sort -V | tail -1 | xargs dirname 2>/dev/null)
```

Then invoke as:

```bash
bun "$PLUGIN_SCRIPTS/task_store.ts" <subcommand> [flags]
```

---

## Resolve your assignee

Always resolve the current GitHub user before querying. Pass it to every `query` call:

```bash
CURRENT_USER=$(gh api graphql -f "query=query{viewer{login}}" --jq '.data.viewer.login' 2>/dev/null)
```

---

## Standard lifecycle

### Pick next task

Check for an interrupted task first, then fall back to the next ready one:

```bash
# 1. Resume interrupted task (in_progress assigned to you)
bun "$PLUGIN_SCRIPTS/task_store.ts" query --status in_progress --assignee "$CURRENT_USER"

# 2. If empty, pick next ready task
bun "$PLUGIN_SCRIPTS/task_store.ts" query --ready --assignee "$CURRENT_USER"
```

Both return a JSON array sorted by `addedAt`. Use the first element.

### Start a task

```bash
bun "$PLUGIN_SCRIPTS/task_store.ts" update --id {id} \
  --set status=in_progress \
  --set startedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

### Open a PR

Must set `pr` and `prCreatedAt` together with the status:

```bash
bun "$PLUGIN_SCRIPTS/task_store.ts" update --id {id} \
  --set status=pr_open \
  --set pr={pr_number} \
  --set prCreatedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

### Mark blocked

```bash
bun "$PLUGIN_SCRIPTS/task_store.ts" update --id {id} \
  --set status=blocked \
  --set blockedReason="{reason}" \
  --set blockedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

### Mark merged / done

```bash
bun "$PLUGIN_SCRIPTS/task_store.ts" update --id {id} \
  --set status=merged \
  --set mergedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

### Append new tasks

Write tasks to a temp file, then upsert (idempotent by `id`):

```bash
bun "$PLUGIN_SCRIPTS/task_store.ts" append --file /tmp/new-tasks.json
# Returns: { "inserted": N, "updated": N }
```

---

## `--ready` flag semantics

When `--ready` is set, `--status`, `--id`, and `--pr` are **ignored**. Only
`--assignee` and `--session` apply as post-filters.

A task is ready when:
- `status === "pending"`, AND
- all `dependencies` are satisfied (merged, or same branch with `pr_open`/`approved`)

---

## Empty results

When `query --ready` returns `[]`:

| Likely cause | How to check |
|---|---|
| Wrong assignee | Re-run without `--assignee` to see the full ready set |
| Deps not satisfied | Query `--status pending` — tasks present but blocked on deps |
| Queue empty | No pending tasks exist at all |

If `PLUGIN_SCRIPTS` resolves to empty, the plugin is not installed in the cache. Stop
and report the missing plugin rather than retrying.

---

## Task status values

`pending` → `in_progress` → `pr_open` → `approved` → `merged`

Branch statuses: `blocked`, `cancelled`, `deploying`, `deployed`

---

## Reference

Full schema: `references/todos-schema.md`
Backend contract and GitHub data model: `references/task-store.md`
