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

### Account scope (tasks)

Every task row carries an `accountId` (`default` for single-tenant installs — never `NULL`). The auth middleware resolves the caller's account alongside its repos, and `task-store/src/account-scope.ts`'s `resolveAccountScope()` turns it into a filter:

- **Agent tokens** see and mutate only their own account's tasks. An unassigned agent belongs to `default`; an agent whose scope lookup failed gets a sentinel that matches no rows and cannot create tasks (403). A client-supplied `?accountId=` is ignored. Repo/assignee scoping still applies on top.
- **Admin tokens** see every account unless `?accountId=` narrows them to one.
- **Reads** — `GET /tasks` (incl. `?ready=true` / `?state=ready` / `?state=blocked`), `GET /tasks/distinct`, `GET /tasks/:id`, and every `/tasks/:id/*` route — filter by the caller's account. Another account's task is a `404`, never a `403`, so its existence isn't revealed.
- **Dependencies never cross accounts.** Ready/blocked resolution loads only the caller's account graph, and an unrestricted admin load is resolved one account at a time, so a dependency id that exists only in another account is always unresolved — and another account's in-progress tasks never trip the [same-branch exclusivity guard](./task-store-pr-tracking.md#same-branch-exclusivity-guard).
- **Writes** — `POST /tasks` and `POST /tasks/bulk` stamp `accountId` from the caller (agent → its account; admin → `?accountId=` or `default`), ignoring any body value. Only admin tokens may change a task's `accountId` via `PATCH`.

**Phase 1 limitation — task ids are global.** `Task.id` is still a single global primary key, so two accounts cannot both use the same id (e.g. `SSP-1.1`). When an agent token's create or bulk insert collides, the response is always `409 {"error": "task id unavailable"}` — the same body whether the id is taken in the caller's own account or in another one, so the collision never reveals another tenant's ids. Pick a different id (e.g. a different session prefix) and retry; bulk inserts remain all-or-nothing. Admin tokens still get the detailed `task '<id>' already exists` message.

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

### PR tracking & dispatch guards

PR origin metrics, verification checks, skip tracking (reason-aware auto-block), the same-branch exclusivity guard, and the session archive sweep are documented in [`task-store-pr-tracking.md`](./task-store-pr-tracking.md).

### Token management

All `/tokens` endpoints are admin-only — create, list, update (relabel/rescope), and revoke (soft-delete via `revokedAt`) scoped tokens. See the OpenAPI spec for request/response shapes.

### Health

`GET /health` (liveness — process-alive only) and `GET /health/ready` (readiness — database-aware, used by the Kubernetes `readinessProbe`) require no authentication.

---

## Troubleshooting

### `?ready=true` returns empty

If `GET /tasks?ready=true` returns `{ tasks: [], total: 0 }` even though tasks exist, check in order: (1) an unfiltered `?assignee=` query can still exclude tasks assigned elsewhere — use an admin token or drop the filter; (2) `hitl: true` (Type A — requires direct human execution) or (3) `kind: "prd"` (a product spec awaiting an autonomous plan session) may be set — query `?status=pending` to check; (4) a same-branch sibling may hold the [exclusivity guard](./task-store-pr-tracking.md#same-branch-exclusivity-guard) — query `?status=in_progress` to check, and note a stale claim (>65 min, no heartbeat) is reaped automatically (three consecutive reaps auto-block the task); (5) [dependencies](#dependency-satisfaction-rules) may be unsatisfied; (6) the queue may simply be empty — confirm with `?status=pending`.

### 401 Unauthorized

The bearer token is missing, malformed, or revoked. Verify `SHIPWRIGHT_TASK_STORE_TOKEN` is set and hasn't been revoked via `DELETE /tokens/:id`. Mint a fresh token with `POST /tokens` (admin token required).

### 400 on writes to a task or PR

Agent tokens are repo-scoped — a write to a task or PR outside the token's configured `repos` is rejected with `400` (`POST /prs/claim`), `403` (`POST /prs/census`, `GET /prs/census/cursor`), or `404` (`/prs/:id/*` routes, indistinguishable from a missing PR). Check the agent's `repos` array (`GET /agents/:id` on the admin service) against the task's `repo` field.

### Tasks not appearing after creation

- **Duplicate `id`** — `POST /tasks/bulk` fails the *entire* batch with `409` when any task's `id` already exists (atomic, all-or-nothing); confirm none of the tasks in the batch already exist under their ID, or drop/rename the colliding one and retry. `POST /tasks` (singular) has no dedicated collision handling — an existing `id` surfaces as an unhandled error, not a clean `409`.
- **Missing `repo` key** — `repo` must be present on every task (`null` is a valid value for unscoped tasks, but the key itself is required).

---

## See also

- [`task-store-pr-tracking.md`](./task-store-pr-tracking.md) — PR origin metrics, verification checks, skip tracking, same-branch guard, session archive sweep
