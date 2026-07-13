# Task Store

The Shipwright task store is the backing database for the plan-execute-review loop. It holds all tasks, their statuses, dependencies, and PR tracking records.

The HTTP service (artifact **D**) is the **only** backend — a Postgres-backed Hono service reached via `SHIPWRIGHT_TASK_STORE_URL` + `SHIPWRIGHT_TASK_STORE_TOKEN`. The plugin has no local file or Jira fallback and no bundled CLI script; every command and skill (`dev-task`, `review`, `patch`, `deploy`, `plan-session`, the `task-store` skill) talks to the HTTP API directly via `curl`. See [configuration.md](configuration.md) for env vars, and `plugins/shipwright/skills/task-store/SKILL.md` for the full curl-based interaction reference used by agents.

---

## HTTP service

The task store ships as a standalone Hono service backed by PostgreSQL. Agents connect to it via `SHIPWRIGHT_TASK_STORE_URL` + `SHIPWRIGHT_TASK_STORE_TOKEN`. The admin service provisions per-agent tokens automatically during agent setup.

### Authentication

All endpoints except `GET /health` and `GET /docs/:id` require a `Bearer` token:

```
Authorization: Bearer <token>
```

Two token types:

| Type | `agentId` | Access |
|------|-----------|--------|
| **Admin** | `null` | Unrestricted — all endpoints, all agents |
| **Agent** | set | Scoped — own tasks and repos only |

Tokens are created via `POST /tokens` (admin only). The raw token is returned once at creation; only its SHA-256 hash is stored. Agent tokens are automatically repo-scoped when the admin service is configured — writes to tasks outside the agent's repo scope return `400`.

On each authenticated request, the service resolves the request's caller — a shared `Caller` identity (from `lib/request-context.ts`) — and makes it available to handlers and error logging. Admin tokens resolve to `{name: 'admin', scope: '*'}` and agent tokens resolve to `{name: agentId, scope: agentId}`. Unhandled errors log the caller label for observability (e.g., `[task-store] unhandled error (caller: agent-42): ...`).

### Tasks

#### List tasks

```
GET /tasks
```

Query params:

| Param | Type | Description |
|-------|------|-------------|
| `status` | string | Filter by exact status (e.g. `pending`, `in_progress`, `pr_open`) |
| `state` | string | `open` (all non-terminal), `closed` (terminal), `in_progress`, `ready`, `blocked` |
| `ready` | `true` | Alias for `state=ready` — returns only tasks with `status=pending`, no `hitl`, and all dependencies satisfied |
| `session` | string | Filter by planning session slug |
| `repo` | string | Filter by repo (`org/repo` format) |
| `assignee` | string | Filter by assignee (admin tokens only; agent tokens see only their own tasks) |
| `claimedBy` | string | Filter by claiming agent |
| `pr` | number | Filter by PR number |
| `branch` | string | Filter by branch name |
| `limit` | number | Page size |
| `offset` | number | Page offset |

Returns `{ tasks: Task[], total: number }`.

Agent tokens with a repo scope return tasks where `assignee === agentId` OR `repo` is in the agent's scope (pool tasks). Agent tokens without a repo scope see only tasks where `assignee === agentId`.

#### Create task

```
POST /tasks
```

Body (JSON): task fields. `title`, `status`, and `repo` are required. The `repo` key must be present; `null` is accepted as a valid value for tasks that are not scoped to a specific repository. Agent tokens force `assignee` to their own ID. Returns `201` with the created task.

#### Bulk insert

```
POST /tasks/bulk
```

Body: JSON array of task objects. Each task must have `title`, `status`, and `repo` fields. The `repo` key must be present on every task; `null` is accepted as a valid value for tasks that are not scoped to a specific repository. Skips conflicts (existing ID) rather than failing. Returns `{ inserted: number, updated: number, skipped: string[] }`, where `skipped` lists the IDs of tasks that collided with an existing task.

#### Distinct values

```
GET /tasks/distinct
```

Returns distinct values of key fields across the visible task set. Useful for populating filter dropdowns.

#### Get task

```
GET /tasks/:id
```

Returns `404` if the task doesn't exist or is outside the agent's scope.

#### Update task

```
PATCH /tasks/:id
```

Body: partial task fields. Agent tokens can only update their own tasks (by `assignee` or `claimedBy`). Returns the updated task.

#### Delete task

```
DELETE /tasks/:id
```

Returns `204`. Agent tokens can only delete their own tasks.

#### Claim task (atomic)

```
POST /tasks/:id/claim
```

Atomically claims a pending task — a single conditional `UPDATE ... WHERE status='pending'`. Sets `status=in_progress`, `claimedBy`, `claimedAt`, `heartbeatAt`, and `startedAt` (or keeps existing if already set) in one round-trip. No request body is sent by agent tokens — the service pins `claimedBy` to the calling agent's ID server-side. Admin tokens must supply `{ claimedBy: string }` in the body. Returns `200` with the updated task on success, or `409` if already claimed or not in pending status.

#### Heartbeat

```
POST /tasks/:id/heartbeat
```

Updates `heartbeatAt` to now. Used by agents to renew the claim before any long-running operation (e.g., dispatching a subagent, waiting on CI) to prevent the stale-claim reaper from reclaiming the task mid-pipeline. Agents must call this endpoint periodically to keep the claim alive across all pipeline steps.

#### Complete task

```
POST /tasks/:id/complete
```

Sets `status=done` and `completedAt`.

#### Fail task

```
POST /tasks/:id/fail
```

Sets `status=blocked`. Optional body: `{ reason: string }`.

#### Release task

```
POST /tasks/:id/release
```

Clears `claimedBy`, `claimedAt`, and `heartbeatAt`, resets `status=pending`. Use when the agent stops work without completing or failing.

### Task status lifecycle

```
pending → in_progress → pr_open → approved → merged → deploying → deployed
                                                    ↘ done
```

Terminal statuses (closed): `merged`, `done`, `deploying`, `deployed`, `cancelled`.
Paused status: `blocked` (returned to `pending` on retry).

### PR tracking

The `/prs` surface tracks GitHub PRs through the review → patch → deploy pipeline. One record per `(repo, prNumber)`.

#### List PRs

```
GET /prs
```

Query params: `repo`, `prNumber`, `taskId`, `state`, `reviewState`, `staged`, `limit`, `offset`.

Returns `{ prs: PullRequest[], total: number, limit: number, offset: number }`.

#### Claim PR (atomic)

```
POST /prs/claim
```

Body:

| Field | Required | Description |
|-------|----------|-------------|
| `repo` | yes | `org/repo` format |
| `prNumber` | yes | GitHub PR number (integer) |
| `commitSha` | yes | Current head commit SHA |
| `claimedBy` | admin only | Agent ID (agent tokens pin to their own ID) |
| `taskId` | no | Associated task ID |
| `phase` | no | Pipeline phase (`review`, `patch`, or `deploy`; default: `review`). When set, the phase is updated and reviewState is preserved. Phase-specific behavior on record creation: `review` sets `readyForReviewAt=now`; `deploy` sets `readyForDeployAt=now`; `patch` does not set a ready timestamp. |
| `prCreatedAt` | no | ISO timestamp of the GitHub PR's actual creation time. Only applied when the claim creates a new record (`201`); ignored on subsequent claims (`200`) of an existing record since the field is immutable once set. |

Claim semantics:
- No existing record → creates and returns `201`
- Same `commitSha`, same `phase`, and already claimed by another agent → returns `409` (phase already locked)
- Same `commitSha` and `reviewState !== pending` (review phase only) → returns `409` (already reviewed at this commit)
- Different `commitSha` or `reviewState === pending` → updates and returns `200` (new cycle)

The `taskId` field is optional and does not trigger any side effects on the Task table — it is stored as metadata on the PR record only for reference.

The `phase` field is optional (defaults to `review`). When provided, it sets the PR's phase directly. Unlike the review phase, the patch and deploy phases do not alter the PR's reviewState — they preserve it as-is, allowing a PR in `posted` review state to transition to `patch` for patching while maintaining its review history.

#### Claim next PR (atomic)

```
POST /prs/claim-next
```

Atomically finds the oldest eligible PR (not yet claimed by the agent) and claims it in one round-trip. Useful for agents implementing a pull-based task queue instead of manual claim.

Body:

| Field | Required | Description |
|-------|----------|-------------|
| `maxConcurrent` | no | Max concurrent PRs the agent can claim (default `1`). Returns 204 if the agent already has >= `maxConcurrent` claimed PRs. |
| `agentId` | admin only | Agent ID (agent tokens pin to their own ID) |

Returns `200` with `{ pr: PullRequest, phase: string }` (the claimed PR and its current phase) or `204` if no eligible PRs exist.

Agent tokens see only PRs in their configured repo scope; admin tokens see all PRs.

#### Get PR

```
GET /prs/:id
```

Returns `404` if not found.

#### Update PR

```
PATCH /prs/:id
```

Writable fields: `staged`, `commitSha`, `taskId`, `agentId`, `state`, `mergedAt`, `reviewState`, `phase`, `readyForReviewAt`, `readyForPatchAt`, `readyForDeployAt`. All other fields are managed by lifecycle endpoints. Returns `400` if no writable fields are provided.

**Side effect:** When `state` is set to `merged`, the claim fields (`claimedBy`, `claimedAt`, `heartbeatAt`, `phase`) are automatically cleared. This ensures that merged PRs are no longer held by an agent claim.

#### PR lifecycle endpoints

| Endpoint | Effect |
|----------|--------|
| `POST /prs/:id/heartbeat` | Touch `heartbeatAt` |
| `POST /prs/:id/complete` | `reviewState=posted`, increment `reviewCycles`, set `reviewedAt` |
| `POST /prs/:id/patch` | Increment `patchCycles`, set `patchedAt`, clear `claimedBy`/`claimedAt`/`heartbeatAt`/`phase`. Conditionally reset `reviewState=pending` based on optional `commitSha` in body: if omitted, unconditionally reset to pending; if provided and differs from record's stored `commitSha`, reset to pending and update `commitSha`; if provided and matches, leave `reviewState` untouched (no-op patch cycle). |
| `POST /prs/:id/release` | Clear `claimedBy`/`claimedAt`/`heartbeatAt`, `reviewState=pending` |

#### PR state enums

`state`: `open` | `merged` | `closed`

`reviewState`: `pending` → `in_progress` → `posted` | `approved`

`phase`: `review` | `patch` | `deploy` — tracks which pipeline phase the PR is currently in. Set via `PATCH /prs/:id`. The `readyForReviewAt`, `readyForPatchAt`, and `readyForDeployAt` timestamps record when the PR became ready for each phase; COALESCE across them gives a unified queue-entry time.

#### PR timestamp fields

The following timestamp fields are managed by the task store:

| Field | Managed by | Description |
|-------|-----------|-------------|
| `prCreatedAt` | `POST /prs/claim` | ISO timestamp of the GitHub PR's actual creation time (distinct from `createdAt`, which records when the task-store record itself was created). Set once via the optional `prCreatedAt` field on the first `POST /prs/claim` call that creates the record (`201`); read-only thereafter — later claims cannot modify it. Not currently populated by any Shipwright command; callers must supply GitHub's PR `createdAt` explicitly to use this field. |
| `createdAt` | Auto | ISO timestamp when the task-store PR record was created. |
| `updatedAt` | Auto | ISO timestamp when the task-store PR record was last modified. |
| `readyForReviewAt` | `POST /prs/claim` (phase=review) | Set to `now` when `POST /prs/claim` creates a new record with `phase=review`. Records when the PR became eligible for review. |
| `readyForPatchAt` | (internal use) | Records when the PR transitioned to the patch phase; not currently populated by any Shipwright command but available via `PATCH /prs/:id`. |
| `readyForDeployAt` | `POST /prs/claim` (phase=deploy) | Set to `now` when `POST /prs/claim` creates a new record with `phase=deploy`. Records when the PR became eligible for deployment. |
| `reviewedAt` | `POST /prs/:id/complete` | Set when the review cycle completes. |
| `patchedAt` | `POST /prs/:id/patch` | Set when the patch cycle completes. |
| `mergedAt` | Writable via `PATCH /prs/:id` | Manually set or updated when marking the PR as merged. |
| `claimedAt` | `POST /prs/claim` | Set when the PR is claimed by an agent. |
| `heartbeatAt` | `POST /prs/:id/heartbeat` | Updated to now whenever the claiming agent signals it is still working. |

### Token management (admin only)

All `/tokens` endpoints require an admin token.

#### List tokens

```
GET /tokens
```

Returns token metadata (hash + label + agentId). Never returns raw token values.

#### Create token

```
POST /tokens
```

Body (optional): `{ label?: string, agentId?: string }`. Admin tokens have `agentId=null`. Agent tokens are scoped to the provided `agentId`. Returns the token record plus `rawToken` — the raw value is returned **once** and not stored.

#### Update token

```
PATCH /tokens/:id
```

Body: `{ label?: string, agentId?: string }`. Returns the updated token record.

#### Revoke token

```
DELETE /tokens/:id
```

Soft-deletes the token (sets `revokedAt`). Returns the revoked token record.

### Ephemeral document store

The task store can host short-lived HTML documents — used by the plan skill to publish planning docs for agent reference.

#### Store document

```
POST /docs
```

Body: raw HTML string (not JSON). Requires bearer auth. Returns:

```json
{ "id": "<uuid>", "url": "https://…/docs/<uuid>", "expiresIn": 3600 }
```

The `url` uses `SHIPWRIGHT_TASK_STORE_DOC_TTL_SECONDS` for TTL (default 3600 seconds). Storage is in-memory — a single replica or sticky routing is required.

#### Fetch document

```
GET /docs/:id
```

**No authentication required** — the unguessable `id` is the credential. Returns the HTML with `Content-Type: text/html`. Returns `404` on miss or after expiry.

### Health

```
GET /health
```

No authentication required. Returns `{ "status": "ok", "service": "task-store" }`.

---

## Troubleshooting

### `?ready=true` returns empty

If `GET /tasks?ready=true` returns `{ tasks: [], total: 0 }` even though tasks exist:

1. **No tasks assigned to this agent** — repo-pool visibility means an unfiltered query can still exclude tasks assigned elsewhere. Use an admin token, or drop the `?assignee=` filter, to see all ready tasks in scope.

2. **HITL flag set** — query `?status=pending` to check whether tasks have `"hitl": true`. Clear the flag once the human action is complete.

3. **Dependencies not satisfied** — query `?status=pending` to find pending tasks, then check each task's `dependencies` array against the satisfaction rules above (terminal status, same-branch `pr_open`/`approved`, or a merged cross-branch PR).

4. **Queue empty** — no pending tasks exist at all. Confirm with `?status=pending`.

### 401 Unauthorized

The bearer token is missing, malformed, or revoked. Verify `SHIPWRIGHT_TASK_STORE_TOKEN` is set and hasn't been revoked via `DELETE /tokens/:id`. Mint a fresh token with `POST /tokens` (admin token required).

### 400 on writes to a task or PR

Agent tokens are repo-scoped — a write to a task or PR outside the token's configured `repos` is rejected with `400`. Check the agent's `repos` array (`GET /agents/:id` on the admin service) against the task's `repo` field.

### Tasks not appearing after creation

- **Duplicate `id`** — `POST /tasks` and `POST /tasks/bulk` skip conflicts on an existing `id` rather than erroring; confirm the task doesn't already exist under that ID.
- **Missing `repo` key** — `repo` must be present on every task (`null` is a valid value for unscoped tasks, but the key itself is required).
