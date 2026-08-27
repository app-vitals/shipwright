# Task Store

The Shipwright task store is the backing database for the plan-execute-review loop. It holds all tasks, their statuses, dependencies, and PR tracking records.

The HTTP service (artifact **D**) is the **only** backend — a Postgres-backed Hono service reached via `SHIPWRIGHT_TASK_STORE_URL` + `SHIPWRIGHT_TASK_STORE_TOKEN`. The plugin has no local file or Jira fallback and no bundled CLI script; every command and skill (`dev-task`, `review`, `patch`, `deploy`, `plan-session`, the `task-store` skill) talks to the HTTP API directly via `curl`. See [configuration.md](configuration.md) for env vars, and `plugins/shipwright/skills/task-store/SKILL.md` for the full curl-based interaction reference used by agents.

---

## HTTP service

The task store ships as a standalone Hono service backed by PostgreSQL. Agents connect to it via `SHIPWRIGHT_TASK_STORE_URL` + `SHIPWRIGHT_TASK_STORE_TOKEN`. The admin service provisions per-agent tokens automatically during agent setup.

### Authentication

All endpoints except `GET /health` and `GET /health/ready` require a `Bearer` token:

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

**Scope resolver:**

When the admin service is configured with a scope resolver (a remote service that looks up an agent's accessible repos by ID), the task-store invokes it on every agent-token request to populate the agent's `repos` array. If the resolver call fails (network error, timeout, non-2xx status, malformed JSON), the `repos` array is set to `[]` as a fail-safe to prevent accidental unrestricted access. To help callers detect and respond to resolver outages, the `scopeDegraded` signal is set to `true` only when a resolver failure occurs (see the `/tasks` response format above). Resolver failures are surfaced in error logs but do not block the request — writes within the restrictive empty scope are still permitted, and reads reflect the restricted visibility.

### Tasks

#### List tasks

```
GET /tasks
```

Query params:

| Param | Type | Description |
|-------|------|-------------|
| `status` | string | Filter by exact status (e.g. `pending`, `in_progress`, `pr_open`) |
| `state` | string | `open` (all non-terminal), `closed` (terminal), `in_progress`, `ready`, `blocked`. `blocked` returns tasks with `status=blocked` OR (a non-terminal status AND an unresolved `blockedBy` entry — dependency or HITL). `session`/`source`/`repo`/`org`/`claimedBy`/`pr`/`branch`/`assignee`/`hitl` all apply under `?state=blocked` identically to the plain list path and to `?ready=true` (applied as an AND filter *after* the full task graph is loaded and dependency resolution has run — a task excluded by one of these filters can still contribute a `blockedBy` entry for an in-scope dependent task, since resolution needs the complete graph). `limit`/`offset`/`updatedSince` have no effect under `?state=blocked` (see the unpaginated-convenience-endpoint note below); `sort` does apply (see that same note). |
| `ready` | `true` | Alias for `state=ready` — returns only tasks with `status=pending`, `hitl !== true` (Type A HITL tasks excluded), no fresh same-branch in-progress sibling (exclusivity guard, see "Same-branch exclusivity guard" below), and all dependencies satisfied. `session`/`source`/`repo`/`org`/`claimedBy`/`pr`/`branch`/`assignee`/`hitl` all apply under `?ready=true` identically to the plain list path (applied as an AND filter *after* dependency resolution — a task excluded by one of these filters can still satisfy a dependency edge for an in-scope task, since resolution needs the complete graph). `limit`/`offset`/`sort`/`updatedSince` have no effect under `?ready=true` (see the unpaginated-convenience-endpoint note below). Tasks are always returned in ascending `createdAt` order (oldest first) to ensure deterministic selection regardless of insertion order. |
| `source` | string | Filter by task source (e.g. `plan-session`, `entropy-fix`, `manual`) |
| `session` | string | Filter by planning session slug |
| `repo` | string, repeatable | Filter by repo (`org/repo` format). Repeat the param to match any repo in the list (e.g. `?repo=org/a&repo=org/b`). A single `?repo=` behaves identically to before (exact match). |
| `org` | string, repeatable | Filter by org — matches any repo whose `org/repo` string starts with `<org>/`. Repeat the param to match any of several orgs (e.g. `?org=org-a&org=org-b`). Combines with `repo` as an AND filter (both narrow the same result set). |
| `assignee` | string | Filter by assignee. For admin tokens, filters tasks to those assigned to the specified agent. For repo-scoped agent tokens, further narrows the visible set (AND filter on the OR union of assigned + pool tasks). For agent tokens without repo scope, a mismatched `assignee` filter falls back to the token's own tasks (ignoring the filter); see agent-token-visibility section below for details. |
| `claimedBy` | string | Filter by claiming agent |
| `pr` | number | Filter by PR number |
| `branch` | string | Filter by branch name |
| `hitl` | `true` or `false` | Filter by HITL (human-in-the-loop) flag: return tasks with or without the flag set |
| `limit` | number | Page size. Defaults to `50` when omitted. |
| `offset` | number | Page offset. Defaults to `0` when omitted. |
| `sort` | string | `asc` (default) or `desc` — orders results by `createdAt`. Default preserves existing ascending order for all callers. |
| `updatedSince` | string | ISO timestamp. Only return tasks with `updatedAt >= this value`. A conservative pre-filter (not a precise sync anchor). Omitting it preserves current (unfiltered) behavior. |

The underlying `TaskService.list()` accepts `repo` as a `string[]` (matches any repo in the
list) and a separate `org` filter (matches any repo whose `org/repo` string starts with
`"<org>/"`) — both are wired through as repeatable HTTP query params (`?repo=` / `?org=`) via
Hono's `c.req.queries()`, so `?repo=org/a&repo=org/b` and `?org=app-vitals` both work as
documented in the table above.

Returns `{ tasks: Task[], total: number, limit: number, offset: number, scopeDegraded: boolean }`. 

`total` is the count of *all* tasks matching the filters, independent of `limit`/`offset` — compare it
against `tasks.length` to detect truncation. A caller that queries without an explicit
`&limit=` and gets back 50 tasks with `total: 137` has only seen the first page; re-issue the
query with `&limit=` raised (or page via `&offset=`, accumulating pages until the summed
`tasks.length >= total`) rather than treating the 50-task response as the full result set.
This matters most for any dedup-style check (e.g. `entropy-fix`/`error-fix`/`test-fix`/`security-fix`/
`consolidation-fix`'s "Dedup Check" steps) that queries `?status=pending`/`?status=in_progress`
before filing new tasks — an unbounded default-limit query on a repo with more than 50 active
tasks will silently miss the tail of the list.

`scopeDegraded` is `true` only when the agent token's repo-scope resolver call itself failed
upstream (network error, timeout, non-2xx status, malformed JSON body) and `repos` was forced
to `[]` as a fail-safe. It is always `false` for admin tokens and for any request where the
resolver either was not invoked or succeeded (including when it legitimately returned `[]`).
This field is purely observational — it does not change any authorization decision — but
allows callers to distinguish "the lookup failed catastrophically" from "the lookup succeeded
and this agent truly has zero accessible repos."

`?ready=true` (or `?state=ready`) and `?state=blocked` are unpaginated convenience endpoints —
they compute over the entire task graph (dependency resolution needs every task, not a
`limit`/`offset` slice) and always return every matching task in one response. Their `total`
is simply `tasks.length`; `limit`/`offset` query params have no effect on these two branches. The
`?sort` parameter applies to `?state=blocked` (sort by `createdAt`; default `asc`), but is not
supported with `?ready=true`. `updatedSince` has no effect on either branch, for the same
whole-graph reason.

Aside from those pagination/sort/recency exceptions, every filter in
the table — `session`, `source`, `repo`, `org`, `claimedBy`, `pr`, `branch`, `assignee`, `hitl` — applies
under `?ready=true` and `?state=blocked` exactly as it does on the plain list path.
`TaskService.listReady()` applies these as a post-filter *after* `resolveReadyTasks()` has
resolved the complete dependency graph; `TaskService.listBlocked()` applies the identically-shaped
filter set (`TaskListPostFilters`) as a post-filter
*after* the full task graph is loaded and `computeBlockedBy()` has resolved it. Neither is folded
into the initial query — a task that gets filtered out of the final response can still correctly
satisfy a dependency edge (for `?ready=true`) or contribute a `blockedBy` entry (for
`?state=blocked`) for another, in-scope task. `repo`/`org` matching mirrors the same
array-any-match (`repo`) / `startsWith "<org>/"` (`org`) / AND-between-both semantics described
above for the plain list path, just evaluated in-memory instead of as a Prisma `where` clause. `hitl` is a simple
equality AND-filter: when omitted it has no effect (matches all `hitl` values); when set to `true` or `false`,
it matches only tasks where `task.hitl` equals that value.

**Agent token visibility:**
- **With repo scope** (repos configured): Return tasks where `assignee === agentId` OR (`assignee === null` AND `repo` is in the agent's scope). This union of explicitly-assigned and pool tasks enables the agent to claim unassigned work from its scoped repositories.
- **Without repo scope** (repos empty or not configured): See only tasks where `assignee === agentId` — no pool tasks visible.
- **Admin tokens** (agentId null) have unrestricted visibility and can see any task matching the query filters.

An explicit `?assignee=` filter behaves differently depending on the agent's repo scope: when an agent token has repo scope (repos configured), the filter narrows the result (acts as an AND condition on the OR union) — safe, since it only restricts visibility within an already-permitted set. When an agent token has no repo scope (repos empty or not configured), a mismatched `?assignee=` filter is automatically stripped and the agent sees its own tasks instead — this prevents the footgun of silently receiving empty results when a caller passes an `assignee` that differs from the token's own `agentId`.

#### Create task

```
POST /tasks
```

Body (JSON): task fields. `title`, `status`, and `repo` are required. The `repo` key must be present; `null` is accepted as a valid value for tasks that are not scoped to a specific repository. Agent tokens leave `assignee` as supplied by the caller, defaulting to `null` (unassigned / pool task) when omitted. Returns `201` with the created task.

#### Bulk insert

```
POST /tasks/bulk
```

Body: JSON array of task objects. Each task must have `title`, `status`, and `repo` fields. The `repo` key must be present on every task; `null` is accepted as a valid value for tasks that are not scoped to a specific repository. Agent tokens leave each task's `assignee` as supplied by the caller, defaulting to `null` (unassigned / pool task) when omitted. Skips conflicts (existing ID) rather than failing. Returns `{ inserted: number, updated: number, skipped: string[] }`, where `skipped` lists the IDs of tasks that collided with an existing task.

#### Distinct values

```
GET /tasks/distinct
```

Returns distinct values of key fields across the visible task set. Useful for populating filter dropdowns.

Response: `{ sessions: string[], repos: string[], orgs: string[] }`
- `sessions` — distinct `session` values across visible tasks
- `repos` — distinct `repo` values (in `org/repo` format) across visible tasks
- `orgs` — distinct organization prefixes extracted from `repo` values (the `org` part of `org/repo`)

#### Get task

```
GET /tasks/:id
```

Returns `404` if the task doesn't exist or is outside the agent's scope.

#### Update task

```
PATCH /tasks/:id
```

Body: partial task fields. Agent tokens can only update their own tasks (by `assignee` or `claimedBy`). Writable fields (agents): `status` (except `'pending'`), `blockedReason`, `description`, `note`, `model`, and any other fields not listed below. **Agent tokens cannot set the following fields via PATCH** — these are managed exclusively by their lifecycle endpoints:

- `claimedBy`, `claimedAt`, `heartbeatAt` — use `/claim` or `/release`
- `status: 'pending'` — use `/release` to unclaim, or `/claim` to reclaim

Admin tokens (`agentId === null`) may set any field. Returns the updated task.

**Common use:** Agents use PATCH to set `status: 'blocked'` alongside `blockedReason` when an implementation attempt hits an unrecoverable dead end (e.g., after exhausting model-upgrade escalations in dev-task Step 5c).

#### Delete task

```
DELETE /tasks/:id
```

Returns `204`. Agent tokens can only delete their own tasks.

#### Claim task (atomic)

```
POST /tasks/:id/claim
```

Atomically claims a pending task — a single conditional `UPDATE ... WHERE status='pending' AND "claimedBy" IS NULL`. Sets `status=in_progress`, `claimedBy`, `claimedAt`, `heartbeatAt`, and `startedAt` (or keeps existing if already set) in one round-trip. No request body is sent by agent tokens — the service pins `claimedBy` to the calling agent's ID server-side. Admin tokens must supply `{ claimedBy: string }` in the body. Returns `200` with the updated task on success, or `409` if already claimed or not in pending status.

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

#### Record skip

```
POST /tasks/:id/skip
```

Increments `skipCount` by 1 and updates `lastSkippedAt` to now. When `skipCount` crosses the threshold (3, matching `SPIN_DETECTION_THRESHOLD`), automatically sets `status=blocked` and `blockedReason="Auto-blocked after {skipCount} consecutive skips (dispatched but found nothing to do)"` to halt further dispatches. Called by orchestrators that detect a task is being repeatedly re-selected but produces no visible outcome ([silent] dispatch). Returns `200` with the updated task.

#### Reset skip tracking

```
POST /tasks/:id/skip/reset
```

Resets `skipCount` back to 0 and clears `lastSkippedAt`. Called after a human reviews and unblocks a task that was auto-blocked by skip threshold. Returns `200` with the updated task.

### Task status lifecycle

```
pending → in_progress → pr_open → approved → merged → deploying → deployed
                                                    ↘ done
```

Terminal statuses (closed): `merged`, `done`, `deploying`, `deployed`, `cancelled`.
Paused status: `blocked` (returned to `pending` on retry).

### Dependency satisfaction rules

When `GET /tasks?ready=true` evaluates whether a task is eligible to run, it checks whether all of the task's dependencies are "satisfied." A task's dependencies are specified in its `dependencies` array (a list of task IDs). A single dependency is satisfied when its task meets one of these conditions:

1. **Terminal status** — the dependency's `status` is `merged`, `done`, `deploying`, `deployed`, or `cancelled`. These statuses indicate the dependency is complete and no longer blocking.

2. **Same-branch bundled** — the dependency has `status = pr_open` or `status = approved` AND its `branch` field equals the requesting task's `branch`. This indicates both tasks are part of the same feature branch and their PRs are bundled together in the queue (reviewed/approved as a unit).

3. **Cross-branch merged PR** — the dependency has `status = pr_open` AND its `pr` field is set (not null) AND the referenced GitHub PR number is merged in the repository. This indicates a dependency from another branch whose work has landed.

4. **Any other status is not satisfied.** If a dependency does not match one of the three rules above (e.g., it has `status = pending`, `status = blocked`, or is `pr_open` on a different branch with no PR link), the task cannot run — the dependency is unsatisfied and the task is excluded from `?ready=true` results.

### Same-branch exclusivity guard

A pending task is excluded from the ready set if another task shares its non-null/non-empty `branch` field and is `in_progress` with a fresh claim. This "same-branch exclusivity guard" prevents multiple agents from simultaneously executing tasks bound to the same feature branch — a real dev-task session is likely mid-flight on that shared git branch.

**Freshness definition:** A claim is considered fresh if its `heartbeatAt` (or `claimedAt` if heartbeat is absent) is within `DEFAULT_CLAIM_TTL_MS` (default: 65 minutes — `DEFAULT_CLAUDE_TIMEOUT_MS` + `CLAIM_TTL_BUFFER_MS`, overridable via `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS`) of now. This mirrors the stale-claim-reaper's exact freshness formula, ensuring a genuinely crashed or abandoned sibling task (one whose agent failed to heartbeat) does not permanently starve pending bundled tasks on the same branch.

**Example:** If two tasks share `branch=feat/foo` and the first is `in_progress` with a fresh claim, the second remains excluded from `?ready=true` until either:
- The first task completes, fails, or is released (no longer `in_progress`)
- The first task's claim becomes stale (more than 65 minutes without heartbeat) and is reaped

This rule only applies when `branch` is set. Tasks with `branch=null` or `branch=""` are not subject to the exclusivity check.

### PR tracking

The `/prs` surface tracks GitHub PRs through the review → patch → deploy pipeline. One record per `(repo, prNumber)`.

#### List PRs

```
GET /prs
```

Query params: `repo`, `org`, `prNumber`, `taskId`, `state`, `reviewState`, `staged`, `limit`, `offset`, `ready`, `blocked`, `sort`, `updatedSince`.

`repo` — repeatable query param (`?repo=a&repo=b`). Matches PRs whose `repo` field equals any of the provided repos (string exact-match, OR logic). Omit to search across all repos in scope.

`org` — repeatable query param (`?org=x&org=y`). Matches PRs whose `repo` field starts with any of the provided org prefixes (`repo.startsWith("<org>/")`), OR logic. Omit to search across all repos in scope. When both `repo` and `org` are supplied, they compose via AND — only PRs matching the repo set AND at least one org prefix are returned (see `buildRepoOrgWhere` in `task-store/src/lib/repo-org-filter.ts`).

`ready=true` returns only unclaimed PRs (`claimedBy IS NULL`) — mirrors `/tasks?ready=true`'s semantics for tasks. It composes with the other filters (e.g. `?ready=true&repo=org/repo`) rather than hardcoding `claim-next`'s `state=open AND reviewState IN (pending, posted, approved)` eligibility rules; claim staleness itself is handled entirely by the `StaleClaimReaper` background job, not by this filter.

`blocked=true` returns only PRs considered "blocked" — a PR is blocked when `pr.blocked===true` OR its linked task (joined by `PullRequest.taskId`) has `status==='blocked'`. The `blocked` filter composes with other filters (e.g. `?blocked=true&state=open`).

`sort` orders results by `createdAt`: `asc` (default, oldest first — current behavior for every existing caller) or `desc` (newest first). Unrelated to `claim-next`'s own deterministic ordering, which is a separate, non-configurable `ORDER BY` used for phase-ready claiming.

`updatedSince` is an ISO timestamp; only PRs with `updatedAt >= this value` are returned. A conservative pre-filter (not a precise sync anchor). Omitting it preserves current (unfiltered) behavior.

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

Claim semantics (atomic via Postgres row locking):
- No existing record → creates and returns `201`; a concurrent INSERT loser hits the `@@unique([repo, prNumber])` constraint → `409`. PR creation does not produce an audit event (the creation itself is captured by the PullRequest row's `createdAt`).
- Existing record with conflict conditions re-checked in the UPDATE's WHERE clause (Postgres holds the row lock, ensuring only one writer wins):
  - Same `commitSha`, same `phase`, and already claimed by another agent → no rows affected → `409` (phase already locked)
  - Already claimed (claimedBy !== null) AND same `commitSha` AND `reviewState !== pending` (review phase only) → no rows affected → `409` (already reviewed at this commit)
- Not claimed, OR different `commitSha`, OR `reviewState === pending` → row affected → updates and returns `200` (new cycle). Records field-level transitions as `PullRequestEvent` rows (one per changed field that is not `heartbeatAt`).

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

#### Get PR events

```
GET /prs/:id/events
```

Fetch a PR's `PullRequestEvent` audit trail — a complete history of field-level state transitions recorded in append-only order.

Query params:

| Param | Type | Description |
|-------|------|-------------|
| `limit` | number | Page size. Defaults to `50` when omitted. |
| `offset` | number | Page offset. Defaults to `0` when omitted. |

Returns `{ events: PullRequestEvent[], total: number, limit: number, offset: number }` where:
- `events` — the PR's `PullRequestEvent` objects, ordered by `at` ascending (oldest first)
- `total` — count of all events for this PR (independent of `limit`/`offset`)
- `limit` — the limit applied (defaults to 50)
- `offset` — the offset applied (defaults to 0)

Returns `404` if the PR doesn't exist.

#### Update PR

```
PATCH /prs/:id
```

Writable fields: `staged`, `commitSha`, `reviewedCommitSha`, `taskId`, `agentId`, `state`, `mergedAt`, `reviewState`, `reviewedAt`, `phase`, `readyForReviewAt`, `readyForPatchAt`, `readyForDeployAt`, `blocked`, `blockedReason`. All other fields are managed by lifecycle endpoints. Returns `400` if no writable fields are provided.

**Note:** PATCH does not record an audit event; only the lifecycle endpoints (`POST /prs/:id/claim`, `POST /prs/:id/complete`, `POST /prs/:id/patch`, `POST /prs/:id/release`, `POST /prs/:id/skip`, `POST /prs/:id/skip/reset`) record field-level transitions as `PullRequestEvent` rows. PATCH is designed for late-stage corrections (e.g., force-setting `state=merged` after GitHub confirms it) where the transactional guarantees and field-diff auditing of a lifecycle endpoint are not needed.

**Side effect:** When `state` is set to `merged` or `closed`, the claim fields (`claimedBy`, `claimedAt`, `heartbeatAt`, `phase`) are automatically cleared. This ensures that merged or closed PRs are no longer held by an agent claim.

**Side effect:** When `reviewState` is set to `posted` or `approved`, the claim fields (`claimedBy`, `claimedAt`, `heartbeatAt`, `phase`) are cleared in the same write. This releases the review claim as soon as the review is done, so a PR awaiting patch/deploy is not held by a stale claim that the reaper would otherwise reap (which would regress `reviewState` and re-dispatch a duplicate review).

**Commit-level dedup pattern:** Setting `reviewState=posted` together with `reviewedCommitSha` (e.g. `PATCH /prs/:id` with `{"reviewState": "posted", "reviewedCommitSha": "abc123..."}`, RCS-1.2) records that this PR was reviewed at a specific commit head. The review phase's staged-review guard (RCS-1.3) reads `reviewedCommitSha` explicitly (not the shared `commitSha` field) to detect whether a review is already being staged at the PR's current head — this prevents a stale, never-re-reviewed staged review from being masked as still current by an unrelated `commitSha` bump from a concurrent patch/deploy operation. The dedup-pattern semantics: when `reviewState=posted` and `reviewedCommitSha` match the PR's current head, the PR is excluded from review candidacy; when `reviewedCommitSha` differs (author pushed a new commit since staging), the PR remains eligible for re-review. This is distinct from `POST /prs/:id/release`, which resets `reviewState=pending` and allows re-review at the same commit immediately. Caveat: `agent/src/pr-state-reconciler.ts`'s background `reconcilePostedReviewStateRecord()` heals a `posted` record back to `pending` once it finds no formal GitHub review object at the current head commit (`hasAnyReviewAtHead()` does not inspect issue-level PR comments) — so this dedup only persists indefinitely when the marker was set in response to a formal review at head. When the marker was set in response to a plain PR comment (no formal review object at head), the reconciler's next pass (every 30-60 min) reverts `reviewState` to `pending`, and the same commit becomes re-claimable again after that delay.

#### PR lifecycle endpoints

| Endpoint | Effect |
|----------|--------|
| `POST /prs/:id/heartbeat` | Touch `heartbeatAt`. **Does not record an audit event** — a bare heartbeat only updates liveness (excluded from the audit trail); recording would be a guaranteed no-op and keeping this path cheap (single UPDATE) avoids dominating write volume with liveness pings. |
| `POST /prs/:id/complete` | `reviewState=posted`, increment `reviewCycles`, set `reviewedAt`, clear `claimedBy`/`claimedAt`/`heartbeatAt`/`phase`. Records field-level transitions as `PullRequestEvent` rows. |
| `POST /prs/:id/patch` | Increment `patchCycles`, set `patchedAt`, clear `claimedBy`/`claimedAt`/`heartbeatAt`/`phase`. Conditionally reset `reviewState=pending` based on optional `commitSha` in body: if omitted, unconditionally reset to pending; if provided and differs from record's stored `commitSha`, reset to pending and update `commitSha`; if provided and matches, leave `reviewState` untouched (no-op patch cycle). Optional `ciFailureSignature` field tracks consecutive patch cycles hitting the same CI failure: when it matches the stored `lastCiFailureSignature`, `consecutiveCiFailureCount` increments; when it differs (or none is stored), the count resets to 1. Crossing the threshold (3, matching `SPIN_DETECTION_THRESHOLD`) auto-sets `blocked=true` and a descriptive `blockedReason`. When omitted, CI-failure tracking fields are left untouched. Records field-level transitions as `PullRequestEvent` rows. |
| `POST /prs/:id/release` | Clear `claimedBy`/`claimedAt`/`heartbeatAt`. Resets `reviewState=pending` unless it is already a terminal value (`posted`/`approved`), in which case `reviewState` is left untouched. Records field-level transitions as `PullRequestEvent` rows. |
| `POST /prs/:id/skip` | Increment `skipCount`, update `lastSkippedAt` to now. When `skipCount` crosses threshold (3), auto-set `blocked=true` and `blockedReason="Auto-blocked after {skipCount} consecutive skips (dispatched but found nothing to do)"`. Records field-level transitions as `PullRequestEvent` rows. |
| `POST /prs/:id/skip/reset` | Reset `skipCount` back to 0 and clear `lastSkippedAt`. If the PR is currently blocked with a `blockedReason` matching the skip-auto-block message (contains `"consecutive skips"`), also clears `blocked=false` and `blockedReason=null` in the same update — otherwise `blocked`/`blockedReason` are left untouched (e.g. a block set by the CI-failure-streak mechanism in `POST /prs/:id/patch` is not cleared). Records field-level transitions as `PullRequestEvent` rows. |
| `POST /prs/:id/findings` | Append a review/patch finding to the PR. Request body: `{ref, disposition, source, evidence, at?, agentId?}` where `disposition` is one of `resolved`, `superseded`, `rejected`; `source` is one of `review`, `patch`. Authority rule (server-enforced): `source:"patch"` may only submit `disposition:"rejected"` (returns `400` otherwise); `source:"review"` may submit any disposition. Returns `201` with the created `PrFinding` record. |

#### PR state enums

`state`: `open` | `merged` | `closed`

`reviewState`: `pending` → `in_progress` → `posted` | `approved`

`phase`: `review` | `patch` | `deploy` — tracks which pipeline phase the PR is currently in. Set via `PATCH /prs/:id`. The `readyForReviewAt`, `readyForPatchAt`, and `readyForDeployAt` timestamps record when the PR became ready for each phase; COALESCE across them gives a unified queue-entry time.

`blocked`: boolean (default `false`) — when `true`, blocks automation on this PR until a human intervenes. Used when a PR requires human decision-making or escalation (e.g., no linked task, second-round review disagreement). Set via `PATCH /prs/:id`.

`blockedReason`: optional string — human-readable explanation for why this PR is blocked and requires human intervention (e.g., `"no linked task"`, `"second-round disagreement between reviewer and automated fix"`). Set via `PATCH /prs/:id`.

`skipCount`: integer (default `0`) — consecutive count of times this PR has been dispatched but produced no visible outcome ([silent] dispatch). Incremented by `POST /prs/:id/skip`; reset by `POST /prs/:id/skip/reset`. When it crosses the threshold (3, matching `SPIN_DETECTION_THRESHOLD`), the service auto-sets `blocked=true` and `blockedReason="Auto-blocked after {skipCount} consecutive skips (dispatched but found nothing to do)"` to prevent infinite spin loops. `POST /prs/:id/skip/reset` narrowly reverses this: it clears `blocked`/`blockedReason` only when the current `blockedReason` matches the skip-auto-block's own message pattern (contains `"consecutive skips"`) — a block set by a different mechanism (e.g. the CI-failure-streak auto-block from `POST /prs/:id/patch`) is left untouched, since `blocked:true` PRs are intentionally excluded from all candidate providers as a human-escalation gate and only a human deciding to retry should be able to clear it.

`lastSkippedAt`: optional ISO timestamp — records when the most recent skip was recorded. Updated by `POST /prs/:id/skip`, cleared by `POST /prs/:id/skip/reset`.

`lastCiFailureSignature`: optional string — signature of the most recent CI failure reported via `POST /prs/:id/patch`'s optional `ciFailureSignature` field (e.g. `"npm-test-failed-foo.unit.test.ts"` — a stable identifier capturing which check and which test failed). Used to detect consecutive patch cycles hitting the same CI failure, enabling auto-blocking when a patch loop keeps hitting the same wall rather than making progress. Mirrors `skipCount`/`lastSkippedAt`'s structure and purpose. Set via `POST /prs/:id/patch` when `ciFailureSignature` is provided; left untouched when the field is omitted.

`consecutiveCiFailureCount`: integer (default `0`) — consecutive count of patch cycles whose `ciFailureSignature` matched the stored `lastCiFailureSignature`. When a new, differing signature arrives (or none was previously stored), the count resets to 1 and the new signature is stored. When it crosses the threshold (3, matching `SPIN_DETECTION_THRESHOLD` and `SKIP_BLOCK_THRESHOLD`), the service auto-sets `blocked=true` and `blockedReason="Auto-blocked after {count} consecutive CI failures: {signature}"` to halt repeated dispatch cycles. Updated by `POST /prs/:id/patch` when `ciFailureSignature` is provided; left untouched when the field is omitted.

`reviewedCommitSha`: optional string — the review pipeline's exclusive commit-tracking field, separate from the shared `commitSha` field written by claim()/patch()/deploy for their own multi-phase bookkeeping. Set via `PATCH /prs/:id`. Used by the review phase to independently track the commit at which a review was conducted, allowing review state to persist across pipeline transitions without interference from concurrent patch/deploy phase operations updating `commitSha`.

`findings`: optional array of `PrFinding` objects — review/patch findings recorded against this PR. Appended via `POST /prs/:id/findings`. Always included in responses from `GET /prs/:id` and list queries; omitted from responses if the finding population is disabled or if findings have not been recorded. Each finding records a specific review or patch action that addressed a code finding (e.g., "resolved null-check bug in follow-up commit", "rejected as out-of-scope").

`events`: optional array of `PullRequestEvent` objects — field-level state transitions recorded in an append-only audit trail for this PR. Each event captures which field changed, its old/new values, which actor and method performed the write, and when. Always included in responses from `GET /prs/:id` and list queries; omitted from responses if event population is disabled or if events have not been recorded. Events are never deleted even if the PR record itself is removed.

#### PR Finding type

A `PrFinding` object represents a single code finding that has been triaged during the review or patch phase:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (auto-generated, e.g., `clxfinding123456`) |
| `prRecordId` | string | Reference to the parent PR record's ID |
| `ref` | string | Identifier for the finding location (e.g., `src/foo.ts:42`, or a slug like `null-check-bug`) |
| `disposition` | enum | Triage outcome: `resolved` (the finding was fixed), `superseded` (another fix addressed it), or `rejected` (out-of-scope/not a real issue) |
| `source` | enum | Which pipeline recorded this finding: `review` (code review phase) or `patch` (automated patch/fix phase). Authority rule (enforced server-side): `source:"patch"` may only submit `disposition:"rejected"`; `source:"review"` may submit any disposition. |
| `evidence` | string | Human-readable explanation of the triage decision (e.g., `"Fixed the null check in commit abc123"`, `"Already superseded by the bounds-check fix"`, `"This is intentional — caller guarantees non-null"`) |
| `at` | string | ISO timestamp of when the finding was triaged / resolved (defaults to current time if omitted on creation) |
| `agentId` | string \| null | Optional agent instance that triaged this finding (e.g., the agent ID that performed the review or submitted the patch fix). Set via the `POST /prs/:id/findings` request body; defaults to `null` when omitted. |
| `createdAt` | string | ISO timestamp when the task-store record itself was created |

#### PR Event type

A `PullRequestEvent` object represents a single field-level state transition on a pull request, recorded in an append-only audit trail:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (auto-generated, e.g., `clxevent123456`) |
| `prRecordId` | string | Reference to the parent PR record's ID |
| `field` | string | Name of the field that changed (e.g., `reviewState`, `commitSha`, `blocked`). Stored as a plain string to allow new fields to be auditable without requiring schema migrations. |
| `oldValue` | string (nullable) | The previous value of the field before this transition. When `null`, the field did not previously exist. |
| `newValue` | string (nullable) | The new value of the field after this transition. When `null`, the field was cleared/deleted. |
| `actor` | string (nullable) | The agent ID or system identifier that performed the transition (e.g., `"agent-42"`, `"system"`). When `null`, the actor was not recorded. |
| `method` | string | The service method or API endpoint that performed the write (e.g., `"claim"`, `"complete"`, `"patch"`, `"PATCH /prs/:id"`) — a stable identifier for tracing which code path made the change. |
| `at` | string | ISO timestamp of when the transition occurred, stamped by the caller at insert time. Distinct from `createdAt`, which records when the task-store record itself was persisted. |
| `createdAt` | string | ISO timestamp when the task-store event record was created (auto-managed). |

**Design notes:**
- Events are written incrementally as service methods mutate the parent PR — a plain `INSERT` is race-safe, whereas a JSON-array read-modify-write `PATCH` on the PR itself would not be (mirrors the `PrFinding` rationale).
- Events form an append-only log and are never deleted — even if the parent `PullRequest` row were removed, the audit trail would survive (the relation omits `onDelete=Cascade` to enforce retention).
- Field, actor, and method are plain strings (not enums) — new fields and call sites can be auditable without requiring schema migrations.

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
| `reviewedAt` | `POST /prs/:id/complete` or `PATCH /prs/:id` | Set when the review cycle completes, or advanced via PATCH by the review command's terminal-skip write-back paths (Step 5, Step 14.3, Pre-Check) to serve as a watermark for `agent/src/check-review.ts`'s `hasFreshNonAgentComment` — without advancing it on terminal transitions, a PR would be perpetually re-selected for review. |
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

### Health

Two health endpoints — no authentication required:

```
GET /health
```

Liveness probe (process-alive only, independent of database state). Returns `{ "status": "ok", "service": "task-store" }`. A transient database blip must never trigger a liveness-driven restart.

```
GET /health/ready
```

Readiness probe (database-aware). Used by the Kubernetes `readinessProbe` so traffic is not routed to this pod before Postgres is reachable. Returns `{ "status": "ok" }` with HTTP 200 when the database is healthy, or `{ "status": "not_ready" }` with HTTP 503 when unavailable. In test environments where a database check is omitted, this endpoint defaults to always-ready.

---

## Troubleshooting

### `?ready=true` returns empty

If `GET /tasks?ready=true` returns `{ tasks: [], total: 0 }` even though tasks exist:

1. **No tasks assigned to this agent** — repo-pool visibility means an unfiltered query can still exclude tasks assigned elsewhere. Use an admin token, or drop the `?assignee=` filter, to see all ready tasks in scope.

2. **HITL flag set** — query `?status=pending` to check whether tasks have `"hitl": true`. This is the Type A classification — the task cannot be completed autonomously because it requires a human to execute it directly (no code/acceptance-criteria diff). Clear the flag once the human action is complete.

3. **Same-branch sibling in progress** — query `?status=in_progress` to check whether another task shares the pending task's `branch` with an active claim. If so, that task holds the exclusivity lock on the branch. Wait for it to complete, fail, or release. If the sibling's claim looks stale (more than 65 minutes old with no heartbeat, by default), it will be reaped automatically; verify via the stale-claim-reaper logs in the meanwhile.

4. **Dependencies not satisfied** — query `?status=pending` to find pending tasks, then check each task's `dependencies` array against the [dependency satisfaction rules](#dependency-satisfaction-rules) (terminal status, same-branch `pr_open`/`approved`, or a merged cross-branch PR).

5. **Queue empty** — no pending tasks exist at all. Confirm with `?status=pending`.

### 401 Unauthorized

The bearer token is missing, malformed, or revoked. Verify `SHIPWRIGHT_TASK_STORE_TOKEN` is set and hasn't been revoked via `DELETE /tokens/:id`. Mint a fresh token with `POST /tokens` (admin token required).

### 400 on writes to a task or PR

Agent tokens are repo-scoped — a write to a task or PR outside the token's configured `repos` is rejected with `400`. Check the agent's `repos` array (`GET /agents/:id` on the admin service) against the task's `repo` field.

### Tasks not appearing after creation

- **Duplicate `id`** — `POST /tasks` and `POST /tasks/bulk` skip conflicts on an existing `id` rather than erroring; confirm the task doesn't already exist under that ID.
- **Missing `repo` key** — `repo` must be present on every task (`null` is a valid value for unscoped tasks, but the key itself is required).
