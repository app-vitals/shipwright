# Task Store — Shipwright Backend Reference

Shipwright delegates all task persistence to a pluggable **task store**. The
default store writes to `state/todos.json` (the JSON backend). The GitHub
backend maps each task to a GitHub Issue with label-based status tracking.

This document covers the config schema, the operations contract every backend
must implement, GitHub-specific data model, auth requirements, and a recipe
for adding a new backend.

---

## Config

Task store configuration lives in `.shipwright.json` (or the `shipwright` key
of your `package.json`). The `taskStore` field selects the active backend.

```jsonc
{
  "taskStore": "json" // default — state/todos.json
}
```

To use the GitHub backend:

```jsonc
{
  "taskStore": "github",
  "github": {
    "owner": "app-vitals", // GitHub org or user (required)
    "repo": "shipwright"   // Repository for issues (required)
  }
}
```

### Config resolution chain

`task_store.ts` resolves its config via a 3-step chain, in this order:

**1. Auto-discovery — walk up from `cwd` to find `.shipwright.json`**

Starting from the process working directory, Shipwright walks up the directory
tree until it finds a `.shipwright.json` file or reaches the filesystem root.
Place `.shipwright.json` at the repository root and it will be found
automatically from any subdirectory — no env var needed.

**2. `SHIPWRIGHT_CONFIG` env var — explicit path override**

If no `.shipwright.json` is found by walking up, the `SHIPWRIGHT_CONFIG`
environment variable is consulted. Set it to an absolute path to load config
from a specific location (useful for CI or non-standard layouts):

```bash
export SHIPWRIGHT_CONFIG=/path/to/.shipwright.json
bun task_store.ts query --ready
```

When set, the file must exist and be valid JSON — missing or malformed files
exit non-zero.

In CI, the env var is an alternative to committing `.shipwright.json` at the
root (both work; auto-discovery is simpler when the file is already there):

```yaml
env:
  SHIPWRIGHT_CONFIG: ${{ github.workspace }}/.shipwright.json
```

**3. Default — JSON backend**

If neither auto-discovery nor `SHIPWRIGHT_CONFIG` produces a config,
`task_store.ts` defaults to the JSON backend (`taskStore: "json"`) with no
error. The JSON backend reads and writes `state/todos.json` relative to `cwd`.

### `github` sub-object fields

| Field | Type | Required | Description |
|---|---|---|---|
| `owner` | string | yes | GitHub org or username that owns the repository |
| `repo` | string | yes | Repository where issues are created |

---

## Operations contract

Every backend must expose six operations. The CLI delegates to these; skill
code calls them through the task-store abstraction, never touching the backend
directly.

### 1. `query`

Filter and return tasks.

```
ts-store query [--status <status>] [--session <slug>] [--pr <number>]
               [--id <id>] [--ready]
```

| Flag | Description |
|---|---|
| `--status` | Return only tasks with this status value |
| `--session` | Return only tasks belonging to this session slug |
| `--pr` | Return the task linked to this PR number |
| `--id` | Return exactly the task with this ID |
| `--ready` | Return tasks that are ready to execute (see logic below) |

**Ready flag logic:** A task is ready when `status = pending` AND every
dependency is satisfied. A dependency is satisfied when:
- its `status` is `merged`, OR
- it shares the same `branch` as the candidate AND its `status` is one of
  `pr_open | approved | merged`

**Return shape:** JSON array of task objects (see [todos-schema.md](todos-schema.md)
for the full field reference).

```json
[
  { "id": "TS-1.1", "status": "pending", ... }
]
```

---

### 2. `append`

Idempotently upsert tasks from a JSON file (matched by `id`).

```
ts-store append <file>
```

- If a task with the same `id` already exists, it is updated with the fields
  from the file. Fields not present in the file are left unchanged.
- If the task does not exist, it is inserted.

**Return shape:** Summary object.

```json
{ "inserted": 3, "updated": 1 }
```

---

### 3. `update`

Write specific fields to a task by ID.

```
ts-store update --id <id> --set <key>=<value> [--set <key>=<value> ...]
```

- Accepts multiple `--set` flags in a single invocation.
- Values are coerced to the correct type (numbers for `pr`, `hours`; ISO
  strings for timestamp fields; strings otherwise).

**Return shape:** The updated task object.

```json
{ "id": "TS-1.1", "status": "in_progress", ... }
```

---

### 4. `repos`

Return all repos known to the task store as a newline-separated list.

```
ts-store repos
```

- For the JSON backend, reads all unique `repo` field values from tasks in `state/todos.json`.
- For the GitHub backend, returns the single configured `owner/repo`.

**Return shape:** Newline-separated repo strings (one per line). Empty output if no repos found.

```
app-vitals/shipwright
app-vitals/another-repo
```

---

### 5. `setup`

Create and initialize the backend storage.

```
ts-store setup
```

- **JSON backend:** Creates `state/todos.json` if it does not exist.
- **GitHub backend:** Creates all 6 status labels in the configured repository
  via `gh label create --force` (idempotent — safe to run multiple times).

**Return shape:** Setup summary printed to stdout.

```
Created 6 status labels in app-vitals/shipwright.
```

---

### 6. `doctor`

Validate config and auth. Prints diagnostics; exits non-zero on any
misconfiguration.

```
ts-store doctor
```

Checks performed:
- Config file present and valid JSON
- Required fields populated for the active backend
- Auth token present and `gh auth status` succeeds
- For GitHub backend: all 6 status labels exist in the configured repository

**Return shape:** Diagnostic lines printed to stdout/stderr; exit code `0`
(healthy) or `1` (misconfigured).

```
[ok]  config: taskStore=github
[ok]  auth: gh auth status ok
[ok]  label: status:pending
[ok]  label: status:in_progress
[ok]  label: status:pr_open
[ok]  label: status:approved
[ok]  label: status:merged
[ok]  label: status:blocked
```

---

## GitHub Issues data model

The GitHub backend stores each task as a GitHub Issue in the configured
repository. Status and metadata are tracked as follows:

### Status labels

Task status is tracked via a label applied to the issue. Exactly one status
label is present at any time.

| Label | Color | Meaning |
|---|---|---|
| `status:pending` | gray | Queued, not yet started |
| `status:in_progress` | yellow | Currently being worked on |
| `status:pr_open` | blue | PR created, awaiting CI/review |
| `status:approved` | green | PR approved, ready to merge |
| `status:merged` | purple | Merged and done |
| `status:blocked` | red | Blocked, needs human intervention |

### Body block

Full task metadata is stored in a fenced `shipwright` JSON block in the issue
body. This block contains the complete task object and is used for lossless
round-trips between the backend and the task-store abstraction.

~~~markdown
## Description

Implement the new billing export endpoint.

## Acceptance Criteria

- [ ] Returns CSV export for a given date range
- [ ] Handles empty result sets gracefully

```shipwright
{
  "id": "TS-2.3",
  "session": "may-billing-refactor",
  "layer": "API",
  "branch": "feat-ts-2-3-billing-export",
  "estHours": 3,
  "criticality": "high",
  "dependencies": ["TS-2.1"]
}
```
~~~

### Dedup key

The `id` field in the `shipwright` body block is the dedup key. `append`
searches existing issues for a matching `id` before deciding whether to insert
a new issue or update the existing one.

---

## Auth

### JSON backend

No authentication required — reads and writes `state/todos.json` on the local
filesystem.

### GitHub backend

The GitHub backend uses the GitHub CLI (`gh`) and the GitHub REST API (Issues).

**Required scope:** `repo`

The `repo` scope is sufficient for all GitHub Issues operations. No `project`
scope is needed.

Set `GH_TOKEN` to any token with `repo` scope:

- **Classic PAT** — create at `github.com/settings/tokens`, grant `repo` scope
- **Fine-grained PAT** — grant "Issues: Read and write" permission on the target repository
- **`GITHUB_TOKEN`** in GitHub Actions — the default `GITHUB_TOKEN` has `repo`
  scope for the workflow's repository; no additional configuration required

In CI:

```yaml
- name: Task store setup
  run: |
    PLUGIN_SCRIPTS=$(find ~/.claude/plugins/cache -maxdepth 5 -name "task_store.ts" -path "*/shipwright/*" 2>/dev/null | head -1 | xargs dirname)
    bun "$PLUGIN_SCRIPTS/task_store.ts" setup
  env:
    SHIPWRIGHT_CONFIG: ${{ github.workspace }}/.shipwright.json
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

> `gh` CLI reads `GH_TOKEN` automatically — no other change required.

---

## Add a backend

To implement a new task store backend, provide a module (script, binary, or
TypeScript module) that exposes all six operations via CLI subcommands. The
task-store harness invokes them as child processes and parses stdout as JSON
(or plain text for `repos` and `setup`).

### Required operations checklist

| Op | What it must do |
|---|---|
| `query` | Accept `--status`, `--session`, `--pr`, `--id`, `--ready` flags; return a JSON array of task objects matching the filters |
| `append` | Read a JSON file of tasks; upsert each by `id`; return `{ inserted, updated }` |
| `update` | Accept `--id` and one or more `--set key=value` flags; write those fields to the matching task; return the updated task object |
| `repos` | Print all unique `owner/repo` values to stdout (one per line, empty output if none) |
| `setup` | Create/initialize the backend storage; print a human-readable summary |
| `doctor` | Validate config and auth; print `[ok]` / `[fail]` lines; exit non-zero if any check fails |

### Registration

Point `taskStore` in `.shipwright.json` to your backend module:

```jsonc
{
  "taskStore": "./backends/my-store.ts"
}
```

The harness resolves relative paths from the workspace root. The value
`"json"` and `"github"` are built-in aliases.
