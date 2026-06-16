---
name: task-store
description: >
  Query and update the Shipwright task store — pick the next ready task, mark status
  transitions, and append new tasks. Use whenever you need to read from or write to
  the task queue. Covers script resolution, standard lifecycle invocations, and common
  failure modes.
---

# Task Store — Skill

Use this skill to interact with the Shipwright task store. The task store is a CLI
(`task_store.ts`) that abstracts over JSON-file and GitHub Issues backends. The backend
is selected via env vars or `.shipwright.json` — see `references/task-store.md` for the config schema.

---

## Configure the backend

The backend is resolved in this order (first match wins):

### Option A — env vars (preferred for agents)

Set `SHIPWRIGHT_TASK_STORE` to select the backend. No config file required.

**GitHub Issues backend:**

```bash
export SHIPWRIGHT_TASK_STORE=github
export SHIPWRIGHT_GITHUB_OWNER=<org-or-user>   # e.g. app-vitals
export SHIPWRIGHT_GITHUB_REPO=<repo-name>       # e.g. shipwright
```

**JSON file backend (local fallback):**

```bash
export SHIPWRIGHT_TASK_STORE=json
```

### Option B — `.shipwright.json` config file

The script walks up from the current directory looking for `.shipwright.json`. Example:

```json
{ "taskStore": "github", "github": { "owner": "app-vitals", "repo": "shipwright" } }
```

### Option C — `SHIPWRIGHT_CONFIG` env var (explicit file path)

When no `.shipwright.json` is found by walk-up, `SHIPWRIGHT_CONFIG` is consulted next.
Use this in CI or non-standard workspace layouts where the config file lives outside
the working directory:

```bash
export SHIPWRIGHT_CONFIG=/path/to/.shipwright.json
```

If none of the above resolve, the JSON backend is used by default.

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

Write tasks to a temp file, then append:

```bash
bun "$PLUGIN_SCRIPTS/task_store.ts" append --file /tmp/new-tasks.json
# Returns: { "inserted": N, "updated": N }
```

Backend note: the GitHub adapter is insert-only — existing tasks (matched by `id`) are
never updated via `append`. Use `update` for targeted field changes on existing
GitHub-backed tasks. The JSON adapter upserts (idempotent by `id`).

---

## `--ready` flag semantics

When `--ready` is set, `--status`, `--id`, and `--pr` are **ignored**. Only
`--assignee` and `--session` apply as post-filters.

- `--assignee` — filter by GitHub login (pass `$CURRENT_USER`).
  Backend note: the GitHub adapter includes unassigned tasks (`assignee` field absent) —
  they are available to any agent. The JSON adapter uses strict equality — unassigned
  tasks are excluded; omit `--assignee` to see them.
- `--session` — filter by planning session slug (the `session` field stamped on each task
  during `plan-session`). Omit to return ready tasks across all sessions.

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
