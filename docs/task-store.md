# Task Store

The Shipwright task store is the backing database for the plan-execute-review loop — it holds all tasks, their statuses, dependencies, and PR tracking records.

The HTTP service (artifact **D**) is the **only** backend — a Postgres-backed Hono service reached via `SHIPWRIGHT_TASK_STORE_URL` + `SHIPWRIGHT_TASK_STORE_TOKEN`. The plugin has no local file or Jira fallback and no bundled CLI script; every command and skill (`dev-task`, `review`, `patch`, `plan-session`, the `task-store` skill) talks to the HTTP API directly via `curl`. See [configuration.md](configuration.md) for env vars. For a local store, run `~/shipwright/scripts/local-store.sh` (or `task store:local`) — it boots Postgres + the task-store image, mints an unscoped token, and writes it to a file you source (`~/.shipwright/local-store.env` by default); see [quickstart.md](quickstart.md).

**Full endpoint reference** — every route, parameter, request/response shape, and status code, including behavioral nuance like atomic claim semantics and lifecycle-guard restrictions — lives in the generated [`task-store/openapi.json`](../task-store/openapi.json) spec (human-browsable summary: [`docs/mcp-tools.md`](./mcp-tools.md)). **Practical usage** — curl-based examples for auth setup, common queries, and claim/release/patch calls — lives in [`plugins/shipwright/skills/task-store/SKILL.md`](../plugins/shipwright/skills/task-store/SKILL.md).

This page covers only the cross-cutting behavioral rules that don't belong to any single endpoint.

---

## HTTP service

### Authentication

Two `Bearer`-authenticated token types: **Admin** (`agentId: null`) — unrestricted, all endpoints and agents; **Agent** (`agentId` set) — scoped to its own tasks and repos. Tokens are minted via `POST /tokens` (admin only); the raw value is returned once and only its SHA-256 hash is stored.

Agent tokens are repo-scoped via a remote scope resolver. If the resolver call fails (network error, timeout, non-2xx, malformed JSON), the agent's `repos` array is forced to `[]` as a fail-safe, and the response's `scopeDegraded` flag is set to `true` so callers can distinguish "resolver outage" from "this agent genuinely has zero repos."

Every authenticated request also resolves a shared `Caller` identity (`@app-vitals/agent-lib/request-context`, common to admin/task-store/metrics) onto the context as `caller`: admin tokens → `{name: "admin", scope: "*"}`, agent tokens → `{name: agentId, scope: agentId}`. `callerLabel()` renders it as `name (scope)` (or `anonymous` when unresolved) and the unhandled-error log line embeds it for observability — e.g. `[task-store] unhandled error (caller: agent-42 (agent-42)): ...`.

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

The task store can notify a downstream service of task writes via a generic `{ type, data }` webhook — configured entirely through env vars (`SHIPWRIGHT_TASK_STORE_WEBHOOK_URL`/`_TOKEN`/`_SIGNING_SECRET`/`_TIMEOUT_MS`, see [`docs/configuration-agent.md`](./configuration-agent.md#metrics--admin--chat--task-store-services)). `task.write` is the only event type today, firing from every `TaskService` method that creates or mutates a task row (`create`, `bulk`, `markMergedByPr`, `update`, `claim`, `complete`, `fail`, `release`, `unblock`, `recordSkip`, `resetSkip`) — `remove()` and `heartbeat()` deliberately don't fire it. Delivery is **fail-closed with no retry**: the dispatch happens inside the same transaction as the write it announces, so a delivery failure rolls back the entire write rather than leaving an unannounced task row. See `task-store/src/webhook-dispatcher.ts` for the envelope/signature implementation.

### Sessions

A `Session` row is upserted automatically whenever a task write sets a non-blank `session` field — only `/shipwright:plan-session` does this; the `*-fix` patrol skills and externally-opened PRs never carry one. See `GET /sessions` / `GET /sessions/:slug` in the OpenAPI spec for the rollup shape and query params, and [`docs/agent-web-ui.md`](./agent-web-ui.md) for the admin UI's Sessions tab.

### Planning documents

A `PlanDocument` row (PLU-2.1 schema) records one numbered spec, or the session's single plan, living as a file in the session's home repo. The document service (`task-store/src/document-service.ts`) and routes (`task-store/src/routes/documents.ts`) expose three endpoints:

- `POST /documents` registers a document. It is idempotent on the unique key `(accountId, session, kind, number)` (plans are always number 1): registering the same key again updates `prUrl`, `title`, `owner`, `repos` and `state` on the one row, and fields omitted from the later request are left as they were. Registering also ensures the `Session` row exists (until now sessions were only created as a side effect of task writes), sets the session's `owner` from the first document that carries one (a later document never overwrites it) and sets `homeRepo` when it is empty. The document's home `repo` must be in the caller's repo scope: an agent token registering outside its scope gets `403`; admin tokens are unrestricted.
- `GET /documents` filters on `session`, `kind`, `owner` and `planned` (admin tokens may also narrow with `accountId`). `planned=false` returns specs with no `plannedAt` and excludes `abandoned` ones; `planned=true` returns documents with `plannedAt` set. Unknown query parameters are a `400` via `rejectUnknownQuery()`, like `GET /tasks` and `GET /sessions`. Agent tokens only see documents in their own account whose home repo is in their repo scope.
- `PATCH /documents/:id` sets `plannedAt` (specs only; `null` clears it), `prUrl`, `owner` and `state`. A document outside the caller's account or repo scope is `404`.

Sessions carry the planning fields too (PLU-2.3). `GET /sessions` and `GET /sessions/:slug` return `owner`, `homeRepo`, the session's `documents` and `repos`, which is now the union of the session's task repos and its declared repos; the `repo` and `org` filters apply to that union, and `GET /sessions` gains an exact-match `owner` filter. `PATCH /sessions/:slug` (admin-only) accepts `owner`, `homeRepo` (both nullable) and `repos`, which is stored as `declaredRepos`.

Scoped-token reads widen additively: besides the existing task-based rule, an agent token sees a document, and its session, when the document's home repo or any of its target repos is in the token's scope, so a spec registered before any task exists is readable. A session's `documents` list is filtered to the documents the token can see. Writes keep their rules (`POST /documents` needs the home repo in scope; `PATCH /documents/:id` is still home-repo only).

Planning lock and scope preflight (PLU-2.4). `POST /sessions/:slug/lock` takes a self-expiring (15 minute) planning lock before a pass reads the plan; `DELETE /sessions/:slug/lock` releases it once tasks are written and the plan is pushed. The holder is the optional body `holder`, else the token's agent id (`admin` for admin tokens). Acquiring a held, unexpired lock returns `409` with `error`, `holder`, `acquiredAt` and `expiresAt`; an expired lock can be re-acquired, and the holder re-acquiring extends it. Releasing a live lock as a non-holder returns `403`; releasing a free or expired lock is a no-op. `GET /sessions/preflight/scope?repo=a&repo=b` is a read-only credential check (not a permission model): it returns `{ covered, uncovered }` for the calling token, where admin tokens cover everything and an agent token covers the repos in its resolved scope.

#### Registering existing planning sessions

Operators register sessions that predate document registration with `task register-planning-sessions` (`scripts/register-planning-sessions.ts`). It walks `planning/*/` in the current checkout and applies the shared PLU-3.1 rules from `plugins/shipwright/scripts/register-planning-documents.ts` (the same module the commands use for lazy registration): `PLAN.md` is plan 1, `PRODUCT-SPEC.md` is spec 1, `SPEC-{NNNN}.md` is spec NNNN, and tasks whose `source` is the plan path gain `planDocumentId` and nothing else. Any other file is listed in the report and never registered; `owner` is never set.

```bash
export SHIPWRIGHT_TASK_STORE_URL=... SHIPWRIGHT_TASK_STORE_TOKEN=...
task register-planning-sessions -- --dry-run   # print what would happen, write nothing
task register-planning-sessions                # apply
```

Flags: `--dry-run`, `--root <dir>` (checkout root, default the current directory) and `--repo <org/repo>` (home repo; default: parsed from `git remote get-url origin`). The script is re-runnable: a second run over an unchanged tree reports zero creates and zero updates. The report lists documents created and updated, tasks linked, non-standard files and any errors; the exit code is non-zero when there are errors. A document already registered keeps its home repo.

The MCP surface exposes `documents_list` only; `documents_create` and `documents_update` are in the allowlist's exclusion list (see [`docs/mcp-tools.md`](./mcp-tools.md)).

#### Nightly reconciler

`PlanDocumentReconciler` (`task-store/src/plan-document-reconciler.ts`, PLU-2.6) runs every 24 hours (a `setInterval` in `task-store/src/main.ts`, like the other reapers) and settles `PlanDocument` rows that are still `draft` or `pr_open` against GitHub. `merged` and `abandoned` rows are never examined.

- `merged`: the document's file exists on its home repo's default branch. `commitSha` is set to the latest default-branch commit touching the file, and `prUrl` is filled from that commit's merged PR when the row had none.
- `abandoned`: the row's `prUrl` PR was closed without merging **and** the file is not on the default branch.
- Otherwise (PR still open, no PR, or a merged PR whose file was later deleted) the row is left alone.

Only `state`, `prUrl` and `commitSha` are ever changed, via a conditional update that skips a row a concurrent `PATCH` already moved. A GitHub error on one row is logged and the sweep continues.

**Credential:** the task-store process needs a GitHub token in `GH_TOKEN` (or `GITHUB_TOKEN`) with read access to the documents' home repos (contents and pull requests). Without one the sweep does nothing and logs `no GitHub credential` once per process. The decision logic is the pure `decideDocumentState()`; GitHub access goes through the injectable `PlanDocumentGitHubClient` (`task-store/src/github-plan-client.ts` takes an injectable `fetch`), so tests replay recorded responses from `task-store/src/fixtures/plan-reconciler-github.json`.

### Task `pr` field

`Task.pr` is an integer column. `POST /tasks`, `POST /tasks/bulk` and `PATCH /tasks/:id` normalize a supplied `pr` (`normalizePr` in `task-store/src/validate.ts`) to a positive integer: a positive integer, an integer string, or a `https://github.com/<owner>/<repo>/pull/<n>` URL are all accepted (`null` clears it). Anything else, or a value above the INT4 maximum, is a `400` naming the accepted forms rather than a Prisma `500`.

### PATCH request field validation

`PATCH /tasks/:id` rejects any body key that is not a valid Task column with a `400` error, naming the unknown field(s). This prevents typos (e.g., `notes` instead of `note`) and malformed requests from reaching Prisma's validation layer, which would otherwise surface as a `500` error. The set of valid fields (`TASK_PATCH_FIELDS` in `task-store/src/routes/tasks.ts`) is kept in sync with `Prisma.TaskScalarFieldEnum` via a unit test — mismatch is a build-time failure, not a deployment surprise.

`POST /tasks`, `POST /tasks/bulk` and `PATCH /tasks/:id` also type-check the non-string columns that the passthrough body schemas leave untyped (`assertTaskFieldTypes` in `task-store/src/routes/tasks.ts`): integer fields such as `complexity`, `skipCount` and the token counters must be an integer or `null`; `hours`, `coverageDelta` and `costUsd` a finite number or `null`; `hitl` a boolean or `null`; `acceptanceCriteria` and `dependencies` an array of strings. A mistyped value (e.g. `complexity: "S"`) is a `400` naming the field — there is no string-to-number coercion — rather than a Prisma `500`.

### GET list query parameter validation

`GET /tasks`, `GET /sessions` and `GET /documents` reject any query parameter the endpoint does not document with a `400` error, naming every unknown parameter and listing the accepted ones. This prevents typos (e.g., `?sesion=x` for `?session=x`) and stray parameters from silently widening results to the whole store. The accepted parameter set is derived from the same zod schema that generates the OpenAPI spec (`TaskListQuerySchema`, `SessionListQuerySchema`, `PlanDocumentListQuerySchema`), so the documented and validated sets cannot drift. The check is shared via the `rejectUnknownQuery()` helper in `task-store/src/lib/reject-unknown-query.ts`.

Error body example: `{"error":"unknown query parameter: sesion (accepted: status, state, source, session, ...)"}`

A documented parameter with a bad value still returns `400` from schema validation — this validation gate catches *unknown* parameters only, before schema coercion.

### Task status lifecycle

```
pending → in_progress → pr_open → approved → merged → deployed
                                                    ↘ released
                                                    ↘ done
```

Terminal statuses (closed): `merged`, `done`, `deployed`, `released`, `cancelled`.
`released` (with its `releasedAt` stamp) mirrors `deployed`/`deployedAt` for changes that ship on a
release cadence rather than a direct deploy.
Paused status: `blocked` (returned to `pending` on retry).

### Task kind

`Task.kind` is a `TaskKind` enum — `dev` (the default), `prd`, `initiative`, or `idea` — recording what a task *is*, as
opposed to what state it's in:

| `kind` | Meaning | Dispatched as |
|---|---|---|
| `dev` | An ordinary work item. The default, and what every row created before the enum existed was backfilled to. | `/shipwright:dev-task {id}` |
| `prd` | A product spec awaiting an autonomous planning pass. Never part of the `?ready=true` set — a PRD task has no dependency graph to resolve and must not be picked up as dev work. | `/shipwright:plan-session {repo} {session} --autonomous {id}` |
| `initiative` | Early-stage idea or initiative not yet ready for planning. Never part of the `?ready=true` set and never executed as regular work. Can be closed out after planning via `--initiative`. | `/shipwright:plan-session {repo} {session} --initiative {id}` or `/shipwright:prd {session} --initiative {id}` (close-out only) |
| `idea` | Brainstorm or concept pending review and scoping. Never part of the `?ready=true` set and never executed as regular work. Can be closed out after planning via `--initiative`. | `/shipwright:plan-session {repo} {session} --initiative {id}` or `/shipwright:prd {session} --initiative {id}` (close-out only) |

Filter on it with `?kind=dev` / `?kind=prd` / `?kind=initiative` / `?kind=idea`; `agent/src/coding/check-plan.ts` collects the plan phase's
candidates with `?kind=prd&status=pending`. A PRD task is deliberately excluded from `?ready=true` —
it has no dependency graph to resolve and must not be picked up as dev work. Initiative and idea tasks
are also excluded from `?ready=true` as they are not yet planned work.
An initiative or idea task can be closed out by the plan that fulfils it: `/shipwright:plan-session {repo} {session} --initiative {id}` PATCHes it to `done` (with `source: planning/{session}/PLAN.md` and `planDocumentId` set to the plan document) after the bulk task write succeeds. When the initiative is already closed (for example `/prd` closed it first), plan-session leaves `status` and `source` alone and still sets `planDocumentId`. `/shipwright:prd {session} --initiative {id}` does the same after the spec is finalized (with `source: planning/{session}/SPEC-{NNNN}.md`, or `planning/{session}/PRODUCT-SPEC.md` for spec 1, and `specDocumentId` linking the registered spec document). Wrong kind, already-closed, missing, or failed PATCH only warns — it never fails the session.

`autonomousPlanSession` was a boolean predecessor to `kind` (TKD-1.1 introduced `kind` alongside it
for a transition window; TKD-1.3 dropped the legacy column, field, and query filter once every
writer — squadron (TKD-1.2) included — moved onto `kind`). `kind: "prd"` is now the only spelling;
there is no dual-accept normalization and `?autonomousPlanSession=` is no longer a recognized
filter.

### Dependency satisfaction rules

When `GET /tasks?ready=true` evaluates whether a task is eligible to run, it checks whether all of the task's dependencies are "satisfied." A task's dependencies are specified in its `dependencies` array (a list of task IDs). A single dependency is satisfied when its task meets one of these conditions:

1. **Terminal status** — the dependency's `status` is `merged`, `done`, `deployed`, `released`, or `cancelled`. These statuses indicate the dependency is complete and no longer blocking.

2. **Same-branch bundled** — the dependency has `status = pr_open` or `status = approved` AND its `branch` field equals the requesting task's `branch`. This indicates both tasks are part of the same feature branch and their PRs are bundled together in the queue (reviewed/approved as a unit).

3. **Cross-branch merged PR** — the dependency has `status = pr_open` AND its `pr` field is set (not null) AND the referenced GitHub PR number is merged in the repository. This indicates a dependency from another branch whose work has landed.

4. **Any other status is not satisfied.** If a dependency does not match one of the three rules above (e.g., it has `status = pending`, `status = blocked`, or is `pr_open` on a different branch with no PR link), the task cannot run — the dependency is unsatisfied and the task is excluded from `?ready=true` results.

### PR tracking & dispatch guards

PR origin metrics, verification checks, skip tracking (reason-aware auto-block), the same-branch exclusivity guard, and the session archive sweep are documented in [`task-store-pr-tracking.md`](./task-store-pr-tracking.md).

### Marking merged tasks deployed or released by PR

`PATCH /tasks/by-pr` is for external deployment/release automation that knows PR numbers, not task ids.

Request body: `{ "repo": "org/repo", "prNumbers": [101, 102], "status": "deployed" | "released", "at"?: "<ISO timestamp>" }`.

- `prNumbers` must hold 1 to 100 positive integers; an empty list, an over-large batch, a non-integer entry, an unknown `status` (only `deployed` and `released` are accepted), a malformed `repo` or an unparseable `at` is a `400`.
- Every task of `repo` whose `pr` is listed is considered. Only tasks currently `merged` transition: they get the requested `status` and `deployedAt` / `releasedAt` set to `at` (default: now), with TaskEvent audit rows.
- Idempotent: a task already at the requested `status` is reported under `unchanged` and left untouched, so repeating a call is safe.
- Tasks in any other status (`pr_open`, `approved`, `blocked`, `done`, ...) are never modified and are reported under `skipped` with their current status. Note that a task already `deployed` is `skipped` (not `unchanged`) when `released` is requested, and vice versa.
- Everything runs in one transaction (including the single `task.write` webhook dispatch): a bundle of tasks on one PR is updated all-or-nothing. A task changing status concurrently aborts the call with `409`; retry.
- Scope: agent tokens may only target a `repo` in their repo scope (`403` otherwise) and only see tasks of their own account; admin tokens are unrestricted or narrowed with `?accountId=`.

Response: `{ "updated": ["<id>"], "unchanged": ["<id>"], "skipped": [{ "id": "<id>", "status": "pr_open" }] }`.

The manual two-request alternative is `GET /tasks?pr=<n>&repo=<org/repo>` to find the task ids, then `PATCH /tasks/:id` with `{ "status": "deployed", "deployedAt": "<ISO>" }` (or `released` / `releasedAt`) per task; `PATCH /tasks/by-pr` replaces that with one atomic request.

### Agent repo scoping on `GET /tasks`

An agent token never sees the whole account's task list. When the token carries an agent id and a repo scope, `TaskService.list` replaces the plain `assignee` filter with an OR clause (`agentScope` in `task-store/src/task-service.ts`, applied at the `if (filters.agentScope)` branch of `list`): tasks assigned to that agent, **or** any task whose `repo` is in the agent's repos. `?repo=` and the other filters still AND-narrow on top, and the account scope applies to every result. An agent token with no repo scope falls back to its own tasks only (`effectiveFilters` drops a caller-supplied `assignee`).

So the same `GET /tasks?source=system-cron` legitimately returns different counts per agent (8, 16 and 22 tasks for three agents in SCM-8's investigation): each agent's repo list differs. These counts are correct for that agent and must not be quoted as totals. Client-facing numbers come from the metrics service, which reads with its own account-wide `METRICS_TASK_STORE_TOKEN` (admin token, no agent scope) and states its repo scope; see [`/metrics/system-crons`](./metrics.md#metricssystem-crons-scope-and-bucket-rules).

### System crons

`/system-crons` (admin-only; agent tokens get `403`) stores system-cron definitions — `id` (lowercase slug), `name`, `schedule` (5-field cron), `timezone` (IANA, default `UTC`), `enabled`, `enabledAt` (stamped on each disabled→enabled flip, `null` while disabled), `titleTemplate`, `descriptionTemplate`, `repoScope` (`"all"` or `"selected"`, default `"all"`), `repos` (array of `org/repo` entries, only meaningful when `repoScope` is `"selected"`) — managed with `GET /system-crons`, `POST /system-crons`, `PATCH /system-crons/:id`, and `POST /system-crons/:id/enable` / `/disable`. The task store does not schedule anything itself: an external scheduler calls `POST /system-crons/:id/fire` with `{ "scheduledFor": "<ISO with Z or offset>", "repos": ["org/repo", ...] }`.

- Each `(id, scheduledFor)` slot is claimed exactly once via a `SystemCronTrigger` row (unique on `cronId` + `scheduledFor`). `scheduledFor` is normalized to whole-second UTC.
- The claiming call creates, in the same transaction, one `pending` task per distinct repo: kind `dev`, `hitl: false`, no assignee, `source: "system-cron"`, the definition's account, id `SC-{id}-{slot}-{owner}-{repo}`, and branch `feat/{id}` (the task id lowercased). The slot is the compact UTC form `YYYYMMDDTHHMMSSZ` (e.g. `2026-11-14T09:00:00Z` → `20261114T090000Z`).
- Title and description come from the templates by plain `{repo}` substitution (the full `org/repo`). Nothing else is evaluated, so `${x}`, `{{x}}` and `{other}` stay literal.
- Response: `201 { "claimed": true, "taskIds": [...] }` for the winner; `200 { "claimed": false, "taskIds": [] }` when the slot was already claimed or a concurrent call won. A failed fire rolls back the claim along with the tasks, so retrying is always safe. A disabled definition is `409`.
- `GET /system-crons/:id/last-trigger` returns `{ "scheduledFor": <max claimed slot> | null }`.
- At boot the task store seeds two definitions, **disabled**, in the `default` account, inserting only missing ids (edits and enable state are never overwritten): `docs-freshness` (`0 7 * * *`, `/shipwright:research-docs --auto --repo {repo}`) and `test-readiness` (`0 6 * * *`, `/shipwright:test-readiness --repo {repo} --full --publish`).

The scheduler is the admin's `system-cron-scheduler` background pass (`admin/src/coding/system-cron-scheduler.ts`, every 60s; registered when the task store is configured). Each tick it lists enabled definitions and computes every due slot strictly after `max(last-trigger, enabledAt)` and up to now, evaluated in the definition's timezone (`system-cron-schedule.ts`; standard 5-field cron, Vixie day-of-month/day-of-week OR rule). So a never-fired or re-enabled definition fires no backlog, while slots missed during downtime are caught up, oldest first, with no cap. Only when a slot is due does it list repositories, once per owning account, through the GitHub lookup App (archived repos dropped). A `repoScope: "selected"` definition fires only for its `repos` that appear in that listing (`"all"` uses every unarchived repo; a selection with none visible is skipped). An account with no lookup App configured is skipped and nothing is recorded for it, and a listing error fires nothing. It then fires each slot in order; the claim makes N admin replicas safe, and a failed fire stops that definition's later slots until the next tick.

To query recent claimed slots, use `GET /system-crons/:id/triggers?limit=N` (admin-only; returns `{ triggers: [...] }`). Triggers are sorted newest first by `scheduledFor` (tie-break: `createdAt` desc), capped at `limit` (1–50, default 5). Each trigger object contains `scheduledFor` (ISO timestamp of the slot), `claimedAt` (when the slot was claimed), and `taskCount` (number of tasks created for that slot). This is read-only and does not record skipped ticks.

### Coverage snapshots

`CoverageSnapshot` stores one measured test-coverage reading per commit: `id`, `accountId`, `repo`, `branch`, `commitSha`, `linesCovered` / `linesTotal` / `linesPct`, optional `branchesCovered` / `branchesTotal` / `branchesPct` and `functionsCovered` / `functionsTotal` / `functionsPct`, `tool`, optional `runUrl`, `measuredAt`, `createdAt`. It is unique on `(accountId, repo, commitSha)` and indexed on `(repo, measuredAt)`. A snapshot has no parent task or PR, so its account comes from the caller.

- `POST /coverage-snapshots` takes counts only; the server computes each pct as `covered / total * 100` (a branches/functions pair with `total` 0 gets a `null` pct). It upserts on `(accountId, repo, commitSha)`: `201` when the row is new, `200` when a repeat POST for the same commit replaced it (still one row per commit). `measuredAt` defaults to now.
- `400` when `linesTotal` is not > 0, any covered exceeds its total, a branches/functions pair is only half supplied, a count is negative or non-integer, `commitSha`/`branch`/`tool` is empty, or `repo` is not `owner/repo`.
- `GET /coverage-snapshots?repo=&since=&limit=&offset=` returns `{ snapshots, total, limit, offset }`, newest `measuredAt` first (default `limit=50`). `since` is an ISO timestamp (`400` if unparseable).
- `GET /coverage-snapshots/latest` returns `{ snapshots }` with exactly one row per repo, the newest by `measuredAt`.
- Scope: agent tokens may write only repos in their scope (`403` otherwise), always write to and read from their own account (a client-supplied `accountId` is ignored); admin tokens are unrestricted and may pass `accountId` (body on POST, query on GET; default `default` on POST).

### Planning documents (schema)

`PlanDocument` (PLU-2.1) records one planning file per row: `id`, `accountId`, `session` (slug), `kind` (`spec` | `plan`), `number` (specs 1, 2, 3… per session; plans always 1), `repo` (home repo), `path`, optional `title` and `owner` (email), `repos` (target `org/repo` list, default empty), optional `prUrl`, `state` (`draft` | `pr_open` | `merged` | `abandoned`, default `draft`), optional `commitSha`, `plannedAt` and `originTaskId`, `createdAt`, `updatedAt`. It is unique on `(accountId, session, kind, number)`.

The same migration adds nullable, default-free columns to existing tables, so rows written before it read `NULL`: `Session` gains `owner`, `homeRepo`, `declaredRepos` (string array) and the planning lock (`planningLockHolder`, `planningLockExpiresAt`); `Task` gains `owner`, `planDocumentId`, `specDocumentId`, `originKind` and `originRef`. `session`, `originTaskId` and the Task document ids are plain strings rather than foreign keys, matching `Task.session`. The document service and routes ([Planning documents](#planning-documents)) and the session routes (including the [planning lock](#planning-documents)) read and write the `Session` and `PlanDocument` columns; the task fields are described in [Task provenance](#task-provenance).

### Task provenance

`POST /tasks`, `POST /tasks/bulk` and `PATCH /tasks/:id` accept, and every task response returns, `owner` (the requester's email), `planDocumentId`, `specDocumentId`, `originKind` and `originRef` (each a string or `null`). They never reuse `assignee` or `claimedBy`, which identify agents, and `source` is unchanged and still written. `GET /tasks` filters on `owner` (exact match), `originKind` and `originRef` (exact match, e.g. `?originKind=cron&originRef=test-readiness`). `?createdFrom=` / `?createdTo=` (ISO timestamps, inclusive) bound `createdAt` on the paginated list (not `?state=ready|blocked`).

`originKind` comes from one registered list, `ORIGIN_KINDS` in `task-store/src/origin-kinds.ts` (`document`, `skill`, `cron`, `human`). The write validator and the `?originKind=` filter schema both read it, so any value a row can hold is a value the filter accepts, and anything else is a `400` on both. Adding a kind means adding it to that one list (the column is a plain string, so no migration). Tasks filed by a system cron write `originKind: "cron"` with `originRef` set to the cron's id (stable, unlike the display name) and no `owner`. Migration `20261118000000_backfill_system_cron_origin` backfills older `source='system-cron'` rows (`originKind='cron'`, `originRef` = the `SystemCronDefinition.id` matched on the `SC-<cronId>-` task-id prefix); other pre-PLU-2.5 rows still read `null`.

### Token management

All `/tokens` endpoints are admin-only — create, list, update (relabel/rescope), and revoke (soft-delete via `revokedAt`) scoped tokens. See the OpenAPI spec for request/response shapes.

### Health

`GET /health` (liveness — process-alive only) and `GET /health/ready` (readiness — database-aware, used by the Kubernetes `readinessProbe`) require no authentication.

---

## Local setup

For local development or HITL execution, run the setup script from a clone of [app-vitals/shipwright](https://github.com/app-vitals/shipwright) (requires only Docker + curl; idempotent). Run `./scripts/doctor.sh` first to check the other prerequisites (bun, `gh` sign-in, a GitHub remote, git identity); `local-store.sh` runs it for you with `--skip-task-store`, because the task-store env vars do not exist until the store is up.

```bash
./scripts/local-store.sh
```

This script:
1. Boots a local Postgres + task-store container stack
2. Mints an unscoped token (reused on re-run)
3. Writes the env var exports to a file (`~/.shipwright/local-store.env` by default, mode 600) and prints the `source` line to run

Use the exports directly:

```bash
export SHIPWRIGHT_TASK_STORE_URL=http://localhost:3002
export SHIPWRIGHT_TASK_STORE_TOKEN=<token>
```

Or in one command:

```bash
eval "$(./scripts/local-store.sh)"
```

To tear down:

```bash
./scripts/local-store.sh --down
```

---

## Troubleshooting

### `?ready=true` returns empty

If `GET /tasks?ready=true` returns `{ tasks: [], total: 0 }` even though tasks exist, check in order: (1) an unfiltered `?assignee=` query can still exclude tasks assigned elsewhere — use an admin token or drop the filter; (2) `hitl: true` (Type A — requires direct human execution) or (3) `kind` may exclude the task — `kind: "prd"` (a product spec awaiting an autonomous plan session), `kind: "initiative"` (early-stage idea not yet ready for planning), or `kind: "idea"` (brainstorm pending review) are not part of `?ready=true` — query `?status=pending` to check; (4) a same-branch sibling may hold the [exclusivity guard](./task-store-pr-tracking.md#same-branch-exclusivity-guard) — query `?status=in_progress` to check, and note a stale claim (>65 min, no heartbeat) is reaped automatically (three consecutive reaps auto-block the task); (5) [dependencies](#dependency-satisfaction-rules) may be unsatisfied; (6) the queue may simply be empty — confirm with `?status=pending`.

### 401 Unauthorized

The bearer token is missing, malformed, or revoked. Verify `SHIPWRIGHT_TASK_STORE_TOKEN` is set and hasn't been revoked via `DELETE /tokens/:id`. Mint a fresh token with `POST /tokens` (admin token required).

### 400 on writes to a task or PR

Agent tokens are repo-scoped — a write to a task or PR outside the token's configured `repos` is rejected with `400` (`POST /prs/claim`), `403` (`POST /prs/census`, `GET /prs/census/cursor`), or `404` (`/prs/:id/*` routes, indistinguishable from a missing PR). Check the agent's `repos` array (`GET /agents/:id` on the admin service) against the task's `repo` field.

### Tasks not appearing after creation

- **Duplicate `id`** — `POST /tasks/bulk` fails the *entire* batch with `409` when any task's `id` already exists (atomic, all-or-nothing); confirm none of the tasks in the batch already exist under their ID, or drop/rename the colliding one and retry. `POST /tasks` (singular) has no dedicated collision handling — an existing `id` surfaces as an unhandled error, not a clean `409`.
- **Missing `repo` key** — `repo` must be present on every task (`null` is a valid value for unscoped tasks, but the key itself is required).
- **Missing or invalid `status`** — `POST /tasks/bulk` also requires a valid `status` on every task (e.g. `"pending"`); a missing or unrecognized value fails the whole batch with `400`.

---

## See also

- [`task-store-pr-tracking.md`](./task-store-pr-tracking.md) — PR origin metrics, verification checks, skip tracking, same-branch guard, session archive sweep
