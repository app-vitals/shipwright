# Task Store

The Shipwright task store is the backing database for the plan-execute-review loop — it holds all tasks, their statuses, dependencies, and PR tracking records.

The HTTP service (artifact **D**) is the **only** backend — a Postgres-backed Hono service reached via `SHIPWRIGHT_TASK_STORE_URL` + `SHIPWRIGHT_TASK_STORE_TOKEN`. The plugin has no local file or Jira fallback and no bundled CLI script; every command and skill (`dev-task`, `review`, `patch`, `deploy`, `plan-session`, the `task-store` skill) talks to the HTTP API directly via `curl`. See [configuration.md](configuration.md) for env vars.

**Full endpoint reference** — every route, parameter, request/response shape, and status code, including behavioral nuance like atomic claim semantics and lifecycle-guard restrictions — lives in the generated [`task-store/openapi.json`](../task-store/openapi.json) spec (human-browsable summary: [`docs/mcp-tools.md`](./mcp-tools.md)). **Practical usage** — curl-based examples for auth setup, common queries, and claim/release/patch calls — lives in [`plugins/shipwright/skills/task-store/SKILL.md`](../plugins/shipwright/skills/task-store/SKILL.md).

This page covers only the cross-cutting behavioral rules that don't belong to any single endpoint.

---

## HTTP service

### Authentication

Two `Bearer`-authenticated token types: **Admin** (`agentId: null`) — unrestricted, all endpoints and agents; **Agent** (`agentId` set) — scoped to its own tasks and repos. Tokens are minted via `POST /tokens` (admin only); the raw value is returned once and only its SHA-256 hash is stored.

Agent tokens are repo-scoped via a remote scope resolver. If the resolver call fails (network error, timeout, non-2xx, malformed JSON), the agent's `repos` array is forced to `[]` as a fail-safe, and the response's `scopeDegraded` flag is set to `true` so callers can distinguish "resolver outage" from "this agent genuinely has zero repos."

Every authenticated request also resolves a shared `Caller` identity (`lib/request-context.ts`, common to admin/task-store/metrics) onto the context as `caller`: admin tokens → `{name: "admin", scope: "*"}`, agent tokens → `{name: agentId, scope: agentId}`. `callerLabel()` renders it as `name (scope)` (or `anonymous` when unresolved) and the unhandled-error log line embeds it for observability — e.g. `[task-store] unhandled error (caller: agent-42 (agent-42)): ...`.

### Error handling

A single `app.onError` hook (`task-store/src/app.ts`) dispatches every thrown error across **three** tiers:

1. **`ApiError` subclasses** (`task-store/src/errors.ts`) — answered with their own status, no Sentry capture: `BadRequestError` → 400, `UnauthorizedError` → 401, `ForbiddenError` → 403, `NotFoundError` → 404, `ConflictError` → 409 (e.g. a lost claim race), `PayloadTooLargeError` → 413, `WebhookDeliveryError` → 502.
2. **Bare `HTTPException` with `status < 500`** — treated exactly like an `ApiError` (own status, **no** Sentry capture). This covers errors `hono`/`@hono/zod-openapi` raise before any handler runs, notably a malformed JSON request body rejected by hono's own `c.req.json()` parse path — a routine 4xx, not a reported 500.
3. **Everything else** (including an `HTTPException` with `status >= 500`) — an unhandled error: captured by Sentry if configured, logged via `console.error` with the resolved caller label (see [Authentication](#authentication)), and answered with a generic 500 (or the `HTTPException`'s own `>= 500` status).

### Outbound webhook

The task store can notify a downstream service of task writes via a generic `{ type, data }` webhook — configured entirely through env vars (`SHIPWRIGHT_TASK_STORE_WEBHOOK_URL`/`_TOKEN`/`_SIGNING_SECRET`/`_TIMEOUT_MS`, see [`docs/configuration-agent.md`](./configuration-agent.md#metrics--admin--chat--task-store-services)). `task.write` is the only event type today, firing from every `TaskService` method that creates or mutates a task row (`create`, `bulk`, `update`, `claim`, `complete`, `fail`, `release`, `unblock`, `recordSkip`, `resetSkip`) — `remove()` and `heartbeat()` deliberately don't fire it. Delivery is **fail-closed with no retry**: the dispatch happens inside the same transaction as the write it announces, so a delivery failure rolls back the entire write rather than leaving an unannounced task row. See `task-store/src/webhook-dispatcher.ts` for the envelope/signature implementation.

### Sessions

A `Session` row is upserted automatically whenever a task write sets a non-blank `session` field — only `/shipwright:plan-session` does this; the `*-fix` patrol skills and externally-opened PRs never carry one. See `GET /sessions` / `GET /sessions/:slug` in the OpenAPI spec for the rollup shape and query params, and [`docs/agent-web-ui.md`](./agent-web-ui.md) for the admin UI's Sessions tab.

### Task status lifecycle

```
pending → in_progress → pr_open → approved → merged → deploying → deployed
                                                    ↘ done
```

Terminal statuses (closed): `merged`, `done`, `deploying`, `deployed`, `cancelled`.
Paused status: `blocked` (returned to `pending` on retry).

### Task kind

`Task.kind` is a `TaskKind` enum — `dev` (the default) or `prd` — recording what a task *is*, as
opposed to what state it's in:

| `kind` | Meaning | Dispatched as |
|---|---|---|
| `dev` | An ordinary work item. The default, and what every row created before the enum existed was backfilled to. | `/shipwright:dev-task {id}` |
| `prd` | A product spec awaiting an autonomous planning pass. Never part of the `?ready=true` set — a PRD task has no dependency graph to resolve and must not be picked up as dev work. | `/shipwright:plan-session {repo} {session} --autonomous {id}` |

Filter on it with `?kind=dev` / `?kind=prd`; `agent/src/check-plan.ts` collects the plan phase's
candidates with `?kind=prd&status=pending`. A PRD task is deliberately excluded from `?ready=true` —
it has no dependency graph to resolve and must not be picked up as dev work.

`autonomousPlanSession` was a boolean predecessor to `kind` (TKD-1.1 introduced `kind` alongside it
for a transition window; TKD-1.3 dropped the legacy column, field, and query filter once every
writer — squadron (TKD-1.2) included — moved onto `kind`). `kind: "prd"` is now the only spelling;
there is no dual-accept normalization and `?autonomousPlanSession=` is no longer a recognized
filter.

### Dependency satisfaction rules

When `GET /tasks?ready=true` evaluates whether a task is eligible to run, it checks whether all of the task's dependencies are "satisfied." A task's dependencies are specified in its `dependencies` array (a list of task IDs). A single dependency is satisfied when its task meets one of these conditions:

1. **Terminal status** — the dependency's `status` is `merged`, `done`, `deploying`, `deployed`, or `cancelled`. These statuses indicate the dependency is complete and no longer blocking.

2. **Same-branch bundled** — the dependency has `status = pr_open` or `status = approved` AND its `branch` field equals the requesting task's `branch`. This indicates both tasks are part of the same feature branch and their PRs are bundled together in the queue (reviewed/approved as a unit).

3. **Cross-branch merged PR** — the dependency has `status = pr_open` AND its `pr` field is set (not null) AND the referenced GitHub PR number is merged in the repository. This indicates a dependency from another branch whose work has landed.

4. **Any other status is not satisfied.** If a dependency does not match one of the three rules above (e.g., it has `status = pending`, `status = blocked`, or is `pr_open` on a different branch with no PR link), the task cannot run — the dependency is unsatisfied and the task is excluded from `?ready=true` results.

### PR origin metrics

`PullRequest` carries four nullable, purely additive origin-tracking columns: `origin` (a
`PrOrigin` enum — `shipwright` | `ci` | `dependency_bot` | `human` | `unknown`), `authorLogin`,
`headRef`, and `title`. `origin` is **first-write-wins**: once set, no later write ever overwrites
it — see `PullRequestService.stampOrigin()`. `authorLogin`/`headRef`/`title` are written
unconditionally by whichever call site supplies them — the latest known value always wins for
those three. Three call sites write these fields:

1. `TaskService.update()` — when a PATCH sends `status: "pr_open"` and the resulting `pr` is
   non-null (either supplied in the same PATCH or already on the row), the task-store stamps
   `origin: "shipwright"` on the linked `(repo, pr)` PullRequest row **in the same transaction** as
   the task write — no extra API call from `dev-task.md`/`unblock.md`. A PATCH that would leave
   `status: "pr_open"` with `pr` null (neither supplied nor already on the row) is rejected with
   `400` — this invariant is enforced server-side, not just by convention.
2. `PullRequestService.claim()` (`POST /prs/claim`) — accepts optional `authorLogin`, `headRef`,
   and `title` fields, which are stored unconditionally (latest value always wins). After every
   successful claim (update or create branch), looks up whether a Task row links `(repo, prNumber)`
   and derives a `PrOrigin` via the pure `deriveOrigin()` helper (`task-store/src/pr-origin-derivation.ts`),
   then calls `stampOrigin()` atomically with the claim write. A task-row match always wins over any
   author/branch-based signal — see [metrics.md](./metrics.md#origin-classification-rules) for
   the exact precedence table `deriveOrigin()` implements.
3. `POST /prs/census` — a batch upsert (`{repo, prNumber, origin?, authorLogin?, headRef?, title?,
   state?, mergedAt?, prCreatedAt?}[]`, capped at 200 entries per call) used by POM-4.1's
   repo-wide census sweep (see [agent-ops.md](./agent-ops.md#pr-origin-census-sweep)) to backfill
   origin/author/branch/title for PRs the pipeline never claimed directly. It never touches
   claim/phase/review/patch/blocked fields, so it's safe to run alongside review/patch/deploy's
   separate `POST /prs/claim` lock. New rows get `phase=null`, `reviewState="pending"`,
   `staged=false`.

`GET /prs/census/cursor?repo=org/name` returns `{ cursor }` — the max `mergedAt` among rows scoped
to `repo` with a non-null `origin`, or `null` when none exist — the incremental search window the
census sweep uses to avoid re-scanning the same PRs every run.

`GET /prs` accepts `?origin=shipwright,ci` (comma-separated) to filter by any of the given values.

**Known gap:** a PR that never goes through the `pr_open` transition, `POST /prs/claim`, or the
census sweep has no PullRequest row at all, and therefore no `origin`. In practice this now only
affects `deploy.md`'s canary-revert PR: it never transitions a task to `pr_open` and never calls
`/prs/claim`, but it IS a merged PR like any other, so POM-4.1's census sweep classifies it
(typically `human`, via author login) once it merges. A canary-revert PR that already merged
before POM-4.1 shipped stays `origin=null` (`unknown`) permanently — historical backfill is out of
scope.

### Same-branch exclusivity guard

A pending task is excluded from the ready set if another task shares its non-null/non-empty `branch` field and is `in_progress` with a fresh claim. This "same-branch exclusivity guard" prevents multiple agents from simultaneously executing tasks bound to the same feature branch — a real dev-task session is likely mid-flight on that shared git branch.

**Freshness definition:** A claim is considered fresh if its `heartbeatAt` (or `claimedAt` if heartbeat is absent) is within `DEFAULT_CLAIM_TTL_MS` (default: 65 minutes — `DEFAULT_CLAUDE_TIMEOUT_MS` + `CLAIM_TTL_BUFFER_MS`, overridable via `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS`) of now. This mirrors the stale-claim-reaper's exact freshness formula, ensuring a genuinely crashed or abandoned sibling task (one whose agent failed to heartbeat) does not permanently starve pending bundled tasks on the same branch.

**Example:** If two tasks share `branch=feat/foo` and the first is `in_progress` with a fresh claim, the second remains excluded from `?ready=true` until either:
- The first task completes, fails, or is released (no longer `in_progress`)
- The first task's claim becomes stale (more than 65 minutes without heartbeat) and is reaped

This rule only applies when `branch` is set. Tasks with `branch=null` or `branch=""` are not subject to the exclusivity check.

### Session archive sweep

A background job, `SessionRetentionReaper` (`task-store/src/session-retention-reaper.ts`), archives sessions that have gone inactive. It runs on a 1-hour interval registered in `task-store/src/main.ts` (`SESH-8.1`) — a housekeeping pass, not a liveness check like the stale-claim reaper above.

A session is archived (`archivedAt` set, `archivedBy = "system"`) when **all** of these hold:

1. it is not already archived,
2. every task in the session is terminal (no open/non-terminal tasks remain),
3. the session has at least one task ever (an empty session is never archived), and
4. its last task activity is older than `SHIPWRIGHT_TASK_STORE_SESSION_ARCHIVE_AFTER_DAYS` days (default `30`; see [`docs/configuration-agent.md`](./configuration-agent.md#metrics--admin--chat--task-store-services) — set to `0` to disable the sweep).

Archiving is **non-destructive and reversible**: it only removes the session from the default list view. Nothing is deleted, and writing any new task into an archived session automatically un-archives it (`SessionService.upsert()`, SES-1.2) — the next sweep will not re-archive it while that task remains open.

**Retention is archive-only.** There is no purge/delete endpoint for sessions (or for the tasks
within them) — `SessionRetentionReaper` only ever sets `archivedAt`/`archivedBy`, and no route under
`/sessions` accepts a `DELETE`. A session's rows, and every task that ever belonged to it, persist
indefinitely; "retention" here means "stop showing it by default," never "remove it."

### Token management

All `/tokens` endpoints are admin-only — create, list, update (relabel/rescope), and revoke (soft-delete via `revokedAt`) scoped tokens. See the OpenAPI spec for request/response shapes.

### Health

`GET /health` (liveness — process-alive only) and `GET /health/ready` (readiness — database-aware, used by the Kubernetes `readinessProbe`) require no authentication.

---

## Troubleshooting

### `?ready=true` returns empty

If `GET /tasks?ready=true` returns `{ tasks: [], total: 0 }` even though tasks exist, check in order: (1) an unfiltered `?assignee=` query can still exclude tasks assigned elsewhere — use an admin token or drop the filter; (2) `hitl: true` (Type A — requires direct human execution) or (3) `kind: "prd"` (a product spec awaiting an autonomous plan session) may be set — query `?status=pending` to check; (4) a same-branch sibling may hold the [exclusivity guard](#same-branch-exclusivity-guard) — query `?status=in_progress` to check, and note a stale claim (>65 min, no heartbeat) is reaped automatically; (5) [dependencies](#dependency-satisfaction-rules) may be unsatisfied; (6) the queue may simply be empty — confirm with `?status=pending`.

### 401 Unauthorized

The bearer token is missing, malformed, or revoked. Verify `SHIPWRIGHT_TASK_STORE_TOKEN` is set and hasn't been revoked via `DELETE /tokens/:id`. Mint a fresh token with `POST /tokens` (admin token required).

### 400 on writes to a task or PR

Agent tokens are repo-scoped — a write to a task or PR outside the token's configured `repos` is rejected with `400`. Check the agent's `repos` array (`GET /agents/:id` on the admin service) against the task's `repo` field.

### Tasks not appearing after creation

- **Duplicate `id`** — `POST /tasks/bulk` fails the *entire* batch with `409` when any task's `id` already exists (atomic, all-or-nothing); confirm none of the tasks in the batch already exist under their ID, or drop/rename the colliding one and retry. `POST /tasks` (singular) has no dedicated collision handling — an existing `id` surfaces as an unhandled error, not a clean `409`.
- **Missing `repo` key** — `repo` must be present on every task (`null` is a valid value for unscoped tasks, but the key itself is required).
