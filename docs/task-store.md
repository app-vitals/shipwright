# Task Store

The Shipwright task store is the backing database for the plan-execute-review loop. It holds all tasks, their statuses, dependencies, and PR tracking records.

Two deployment modes are available:

| Mode | Transport | Best for |
|------|-----------|---------|
| **HTTP service** | `SHIPWRIGHT_TASK_STORE_URL` | Production — shared queue across multiple agents |
| **Plugin backends** | env vars (`JIRA_*`) or local file | Single-agent or offline use |

The HTTP service (artifact **D**) is the recommended production setup. Plugin backends (JSON file and Jira) are available for local development and single-agent workflows. See [configuration.md](configuration.md) for env vars.

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

Body: JSON array of task objects. Each task must have `title`, `status`, and `repo` fields. The `repo` key must be present on every task; `null` is accepted as a valid value for tasks that are not scoped to a specific repository. Skips conflicts (existing ID) rather than failing. Returns `{ inserted: number, updated: number }`.

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

Atomically sets `claimedBy` and `claimedAt` if the task is currently unclaimed. Returns `409` if already claimed. Agent tokens pin `claimedBy` to their own ID. Admin tokens must supply `{ claimedBy: string }` in the body.

#### Heartbeat

```
POST /tasks/:id/heartbeat
```

Updates `heartbeatAt` to now. Used by agents to signal they are still working.

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

Clears `claimedBy` and `claimedAt`, resets `status=pending`. Use when the agent stops work without completing or failing.

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
| `phase` | no | Pipeline phase (`review`, `patch`, or `deploy`; default: `review`). When set, the phase is updated and reviewState is preserved. |

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

#### PR lifecycle endpoints

| Endpoint | Effect |
|----------|--------|
| `POST /prs/:id/heartbeat` | Touch `heartbeatAt` |
| `POST /prs/:id/complete` | `reviewState=posted`, increment `reviewCycles`, set `reviewedAt` |
| `POST /prs/:id/patch` | `reviewState=pending`, increment `patchCycles`, set `patchedAt` |
| `POST /prs/:id/release` | Clear `claimedBy`/`claimedAt`, `reviewState=pending` |

#### PR state enums

`state`: `open` | `merged` | `closed`

`reviewState`: `pending` → `in_progress` → `posted` | `approved`

`phase`: `review` | `patch` | `deploy` — tracks which pipeline phase the PR is currently in. Set via `PATCH /prs/:id`. The `readyForReviewAt`, `readyForPatchAt`, and `readyForDeployAt` timestamps record when the PR became ready for each phase; COALESCE across them gives a unified queue-entry time.

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

## Plugin backends

Plugin backends are used by the `task_store.ts` CLI script — they run in-process with the agent rather than as a separate service. Two backends are available:

| Backend | Where tasks live | Best for |
|---------|-----------------|---------|
| `json` | `state/todos.json` (local file) | Local development, offline use |
| `jira` | Jira project issues | Teams already using Jira for project tracking |

Config is resolved at startup using env vars (see [configuration.md](configuration.md)). When no backend env vars are set, Shipwright defaults to the JSON backend.

---

## JSON backend (default)

The JSON backend requires no configuration. When no backend env vars are set, Shipwright automatically uses `state/todos.json` in the process working directory.

### Quick start

```bash
# Initialize the task file (creates state/todos.json with an empty array)
bun plugins/shipwright/scripts/task_store.ts setup

# Confirm everything is healthy
bun plugins/shipwright/scripts/task_store.ts doctor
```

Expected `doctor` output:

```
backend: json
token scope: N/A (JSON backend)
[ok]  storage: /path/to/state/todos.json present
[ok]  data: duplicate-ids — No duplicate IDs found
[ok]  data: dangling-deps — All dependencies resolve
[ok]  data: cross-repo-orphans — All repos are valid
```

The `doctor` command runs two categories of checks:

1. **Config/storage checks** — verifies the backend is configured correctly and accessible
2. **Data integrity checks** — audits task metadata for structural issues:

| Check | Level | Applies to | Trigger condition |
|-------|-------|-----------|-------------------|
| `duplicate-ids` | `fail` | all backends | Two or more tasks share the same `id` |
| `dangling-deps` | `fail` | all backends | A task's `dependencies` reference an `id` that doesn't exist |
| `cross-repo-orphans` | `warn` | all backends | A task's `repo` field doesn't match the adapter's configured repo |

Any check that returns `[fail]` causes the command to exit with status code 1. Results with `[warn]` severity are printed but do not cause a non-zero exit.

### When to use

- Getting started locally without any external accounts
- Single-developer workflows where the task queue doesn't need to be shared
- Offline environments

### Notes

- `state/todos.json` is git-ignored by default — it is a local queue, not a shared artifact
- Writes are atomic (temp-file rename)
- The JSON backend has no GitHub access, so cross-branch `pr_open` dependency checks are conservatively treated as unsatisfied

---

## Jira backend

The Jira backend stores tasks as Jira issues. Each issue is tagged with the `shipwright-session` label so Shipwright can find them, and task metadata is stored in an ADF `codeBlock` with language `"shipwright"` inside the issue description. Issues without a `shipwright` code block in their description are ignored.

### Prerequisites

1. A Jira Cloud instance (the adapter uses the Jira REST API v3)
2. A Jira project with a known project key (e.g. `SHIP`)
3. An Atlassian API token — generate one at <https://id.atlassian.com/manage-profile/security/api-tokens>
4. The project must use the `shipwright-session` label to mark Shipwright-managed issues (the adapter applies this label automatically when it creates issues)

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JIRA_EMAIL` | yes | Email address of the Atlassian account associated with the API token |
| `JIRA_API_TOKEN` | yes | Atlassian API token (not your account password) |

Authentication uses HTTP Basic: `base64(JIRA_EMAIL:JIRA_API_TOKEN)`.

### Configuration

Set the following env vars to select the Jira backend:

| Env var | Required | Description |
|---------|----------|-------------|
| `JIRA_BASE_URL` | yes | Base URL of your Jira instance (no trailing slash) |
| `JIRA_PROJECT_KEY` | yes | Jira project key, e.g. `SHIP` |

### Default status map

Shipwright maps Jira status names to its internal `TaskStatus` values. Custom entries in `statusMap` are merged over these defaults — you only need to specify statuses that differ from the defaults.

| Jira status | Shipwright status |
|-------------|------------------|
| `To Do` | `pending` |
| `Backlog` | `pending` |
| `Open` | `pending` |
| `In Progress` | `in_progress` |
| `In Review` | `pr_open` |
| `PR Open` | `pr_open` |
| `Done` | `done` |
| `Closed` | `done` |
| `Resolved` | `done` |
| `Blocked` | `blocked` |
| `On Hold` | `blocked` |
| `Won't Do` | `cancelled` |
| `Cancelled` | `cancelled` |

If your Jira project uses non-standard status names, configure them via `statusMap` in your task store configuration.

### Default JQL query

When `readyJql` is not set, the adapter fetches issues using:

```
project = "PROJECT_KEY" AND labels = "shipwright-session" ORDER BY created ASC
```

The `readyJql` field overrides this entire query. Use it to narrow scope (e.g. a specific sprint or fix version), add status filters, or change the sort order.

> **Important:** The default JQL has no status clause — status filtering is applied client-side after the fetch. If you provide `readyJql`, include explicit status clauses (e.g. `AND status in ("To Do", "In Progress")`). Without them, the query will fetch **all** issues labelled `shipwright-session` regardless of status, which can be expensive on large Jira instances.

Example JQL — limit to the current sprint and only pending tasks:

```
project = "SHIP" AND labels = "shipwright-session" AND sprint in openSprints() AND status = "To Do" ORDER BY created ASC
```

### Human-in-the-loop (HITL) filtering

Tasks marked with the `hitl` field are automatically excluded from the ready task set. Use this to temporarily gate high-risk or uncertain tasks from automated execution — they will not be picked up by `resolveReadyTasks()` even when all dependencies are satisfied and status is `pending`.

To mark a task as HITL:
- Add `hitl: true` to the task metadata block, or use a custom JQL filter (see `readyJql` above) to exclude them

HITL is a runtime flag — it does not affect `query()` filters or direct task lookup. Use `query(filters: { hitl: true })` to return only HITL tasks, or `query(filters: { hitl: false })` to return only non-HITL tasks.

**Notification workflow:** When `check-dev-task.ts` finds pending HITL tasks that have not been notified (no `hitlNotifiedAt` timestamp), it returns exit code 0 with a notification message listing the tasks. The notification should be posted to the configured channel, and then each task's `hitlNotifiedAt` field should be stamped with the current timestamp using the task store update command to prevent duplicate notifications. The field format is an ISO 8601 timestamp string (e.g., `"2026-06-17T10:00:00Z"`).

### How task metadata is stored

When Shipwright creates a Jira issue, it stores the full task JSON in an ADF `codeBlock` with `language: "shipwright"` in the issue description. A human-readable description paragraph appears above it. Issues without this block are ignored by the adapter.

Jira's own status field is authoritative for `TaskStatus` — it overrides whatever status value is stored in the metadata block. Status transitions are performed via the Jira transitions API using the same names as the status map.

### Quick start

```bash
# Export credentials and backend config
export JIRA_EMAIL="you@example.com"
export JIRA_API_TOKEN="your-api-token"
export JIRA_BASE_URL="https://yourorg.atlassian.net"
export JIRA_PROJECT_KEY="SHIP"

# Run setup to verify the project exists and credentials are valid
bun plugins/shipwright/scripts/task_store.ts setup

# Check diagnostics
bun plugins/shipwright/scripts/task_store.ts doctor
```

The `setup` command calls the Jira project API (`GET /rest/api/3/project/{key}`) and throws a clear error if auth fails or the project is not found. It does not create any Jira objects — Jira projects must be created through the Jira UI. The command is safe to re-run.

---

## CLI Reference

The `task_store.ts` script provides several subcommands for manual interaction with the task store.

### Subcommands

| Command | Description |
|---------|-------------|
| `setup` | Create `state/todos.json` if missing (JSON backend) or initialize Jira labels and validation (Jira backend) |
| `doctor` | Validate configuration and print diagnostics (includes `backend:` line showing the active backend) |
| `backend` | Print the active backend name: `json` or `jira` (useful for scripts that need to detect the backend) |
| `query` | Filter and return tasks as JSON array (supports `--status`, `--id`, `--pr`, `--assignee`, `--branch`, `--session`, `--hitl`, and `--ready`) |
| `append` | Append tasks from a JSON file. JSON backend performs upsert; Jira backend inserts only (warns when duplicate task ID is encountered) |
| `update` | Write specific fields to a task by ID |
| `repos` | Print all org/repo strings (one per line) |
| `resolve-repo` | Print first org/repo (deprecated alias for `repos`) |

### `query` filter reference

All filters are AND-combined. `--ready` takes precedence and ignores `--status`, `--id`, and `--pr`.

| Flag | Type | Description |
|------|------|-------------|
| `--status` | string | Match tasks with this exact status (e.g. `pending`, `in_progress`, `pr_open`) |
| `--id` | string | Match the task with this exact ID |
| `--pr` | number | Match the task whose `pr` field equals this PR number |
| `--assignee` | string | Match tasks assigned to this GitHub login |
| `--branch` | string | Match tasks whose `branch` field equals this branch name — useful for querying all tasks in a bundle |
| `--session` | string | Match tasks belonging to this planning session slug |
| `--hitl` | boolean | `true` returns only HITL tasks; `false` returns only non-HITL tasks |
| `--ready` | flag | Return only tasks with `status === pending`, no `hitl` flag set, and all dependencies satisfied (see Dependency satisfaction rules below) |

#### Dependency satisfaction rules

When determining whether a task is ready (via `--ready`), each dependency is evaluated in order. The first matching rule wins:

1. **Terminal status** — dependency has `status ∈ { merged, done, deploying, deployed, cancelled }` → **satisfied**
2. **Same-branch PR** — dependency is on the same branch as the dependent task with `status ∈ { pr_open, approved }` → **satisfied** (bundled PR)
3. **`pr_open` with a PR number** — dependency has `status === pr_open` and a PR number; check whether the PR is merged in GitHub → **satisfied** if merged
4. **Anything else** → **not satisfied** (task is excluded from `--ready` results)

**`--branch` example** — find all tasks sharing a bundle branch:

```bash
bun plugins/shipwright/scripts/task_store.ts query --branch feat/some-bundle
```

The deploy cron uses this internally to check bundle completeness before merging: it queries all tasks on the PR's branch and blocks the merge if any are still `pending`, `in_progress`, or `blocked`.

---

## Troubleshooting

### `--ready` returns empty

If `task_store.ts query --ready` returns an empty array even though tasks exist:

1. **No tasks assigned to this agent** — The CLI command returns only tasks assigned to the authenticated user. Use an admin token or check the task store directly to see all ready tasks.

2. **HITL flag set** — Query `task_store.ts query --status pending` to check if tasks have `"hitl": true`. Clear the flag once the human action is complete (remove the `hitl` label on GitHub, or set `hitl: false` in Jira metadata).

3. **Dependencies not satisfied** — Query `task_store.ts query --status pending` to find pending tasks. See the dependency satisfaction rules above — terminal status, same-branch PR open/approved, or a merged cross-branch PR all count. Check the `dependencies` array and verify each referenced task ID exists and meets at least one rule.

4. **Queue empty** — No pending tasks exist at all. Check with `task_store.ts query --status pending` to confirm.

### Jira: 401 Unauthorized

```
Jira auth failure (401): check JIRA_EMAIL and JIRA_API_TOKEN
```

Causes:
- `JIRA_EMAIL` does not match the Atlassian account that owns the API token
- `JIRA_API_TOKEN` is copied incorrectly (check for leading/trailing whitespace)
- The API token has been revoked — generate a new one at <https://id.atlassian.com/manage-profile/security/api-tokens>

### Jira: 403 Forbidden

```
Jira auth failure (403): check JIRA_EMAIL and JIRA_API_TOKEN
```

Causes:
- The Atlassian account does not have permission to access the project
- IP allowlisting is blocking the request (common in enterprise Jira instances)
- The account is a service account that lacks the Browse Projects permission

### Jira: 404 project not found

```
Jira project not found: "SHIP" — verify jira.projectKey in your config
```

Causes:
- `JIRA_PROJECT_KEY` does not match the actual project key
- The project exists in a different Jira instance — verify `JIRA_BASE_URL`
- The project has been archived or deleted

To find the correct project key: open the project in Jira and look at the URL (`/projects/KEY/...`) or go to **Project settings > Details**.

### Tasks not appearing

If `task_store.ts query --status pending` returns an empty array even though issues exist in Jira:

1. **Missing label** — Shipwright only queries issues tagged `shipwright-session`. Issues created outside of Shipwright will not be picked up unless you add this label manually.

2. **Missing metadata block** — Issues must contain a `shipwright` code block in their description. Issues without it are silently ignored. Check the issue description in Jira to confirm the block is present.

3. **JQL not matching** — If you have a custom `readyJql`, verify it returns the expected issues by running it directly in Jira's issue navigator. Check for typos in the project key or label name.

4. **Status not in map** — If your Jira project uses custom status names not in the default map (and not added to `statusMap`), tasks will default to `pending` regardless of the actual Jira status. This does not prevent tasks from appearing, but status-filtered queries may behave unexpectedly.

5. **Wrong backend active** — Run `bun plugins/shipwright/scripts/task_store.ts doctor` to confirm the Jira backend is active. If it reports `backend: json`, check that `JIRA_BASE_URL`, `JIRA_PROJECT_KEY`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` are all set in the environment.
