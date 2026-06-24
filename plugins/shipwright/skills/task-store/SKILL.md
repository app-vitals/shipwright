---
name: task-store
description: >
  Query and update the Shipwright task store — pick the next ready task, mark status
  transitions, and append new tasks. Use whenever you need to read from or write to
  the task queue. Calls the task store HTTP API directly via curl.
---

# Task Store — Skill

Use this skill to interact with the Shipwright task store via its HTTP API.
The task store is a REST service — call it with curl, no script discovery needed.

> **The HTTP API is the only interface.** Never edit the underlying database directly.
> The unit you work with is the **task** (see [task-schema.md](references/task-schema.md)).

---

## Authentication

All requests require a Bearer token:

```bash
Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN
```

Both env vars are provisioned automatically by the agent harness:

| Env var | Description |
|---|---|
| `SHIPWRIGHT_TASK_STORE_URL` | Base URL of the task store service |
| `SHIPWRIGHT_TASK_STORE_TOKEN` | Bearer token for this agent |

Verify the service is reachable before doing anything:

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?ready=true" | jq 'length'
```

---

## Standard lifecycle

### Pick next task

The API scopes results to the calling agent automatically via the bearer token — no assignee parameter needed. Check for an interrupted task first, then fall back to the next ready one:

```bash
# 1. Resume interrupted task (in_progress assigned to you)
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=in_progress" | jq .

# 2. If empty, pick next ready task
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?ready=true" | jq .
```

Both return a JSON array. Use the first element.

### Start a task

```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}" \
  -d "{\"status\": \"in_progress\", \"startedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" | jq .
```

### Open a PR

Must set `pr` and `prCreatedAt` together with the status:

```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}" \
  -d "{\"status\": \"pr_open\", \"pr\": {pr_number}, \"prCreatedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" | jq .
```

### Mark blocked

```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}" \
  -d "{\"status\": \"blocked\", \"blockedReason\": \"{reason}\", \"blockedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" | jq .
```

### Mark merged / done

```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}" \
  -d "{\"status\": \"merged\", \"mergedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" | jq .
```

### Append new tasks

Post each task individually. The service returns 409 if the `id` already exists — skip silently:

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks" \
  -d '{"id": "TSS-X.1", "title": "...", "status": "pending", "repo": "...", "branch": "feat/tss-x-1-..."}' | jq .
# 201 → inserted, 409 → already exists (skip)
```

**Required fields for every new task:**

| Field | Why required |
|---|---|
| `id` | Stable key; used by dependency resolution and all updates |
| `title` | Required by schema |
| `status` | Must be `"pending"` on creation |
| `repo` | Routes `dev-task` to the correct worktree |
| `branch` | `dev-task` creates the worktree from this; absent → task is skipped |
| `assignee` | Agent ID of the agent that should own this task |

Convention: `branch` = `feat/{id-lowercase}` (e.g. `feat/tss-x-1-my-task`).

---

## `?ready=true` semantics

When `?ready=true` is set, `?status` and `?id` filters are ignored. Only
`?session` applies as a post-filter.

- Agent tokens: results are automatically scoped to the calling agent's tasks.
- Admin tokens: results include all agents' tasks.
- `?session` — filter by planning session slug. Omit to return ready tasks across all sessions.

A task is ready when:
- `status === "pending"`, AND
- all `dependencies` are satisfied (merged, or same branch with `pr_open`/`approved`)

---

## Empty results

When `?ready=true` returns `[]`:

| Likely cause | How to check |
|---|---|
| No tasks assigned to this agent | Use an admin token to see all ready tasks |
| Deps not satisfied | Query `?status=pending` — tasks present but blocked on deps |
| Queue empty | No pending tasks exist at all |

---

## Task status values

`pending` → `in_progress` → `pr_open` → `approved` → `merged`

Branch statuses: `blocked`, `cancelled`, `deploying`, `deployed`

---

## Full API reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/tasks` | List tasks (`?status`, `?session`, `?assignee`, `?ready=true`) |
| `POST` | `/tasks` | Create a task (409 if `id` exists) |
| `GET` | `/tasks/:id` | Fetch one task (404 if missing) |
| `PATCH` | `/tasks/:id` | Update fields (partial update, returns updated task) |
| `DELETE` | `/tasks/:id` | Delete a task |
| `POST` | `/tasks/:id/claim` | Atomic claim → `in_progress` (409 if already claimed) |
| `POST` | `/tasks/:id/release` | Unclaim → `pending` |
| `POST` | `/tasks/:id/complete` | Mark `done` |
| `POST` | `/tasks/:id/fail` | Mark `blocked` |
| `GET` | `/tasks/repo` | Resolve the canonical `owner/repo` for this store |

---

## Reference

- **Task schema** (all fields + per-status required fields): [task-schema.md](references/task-schema.md)
