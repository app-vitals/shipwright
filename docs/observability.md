# Observability

> Coding half. The platform half is the vendored snapshot [`docs/platform/observability.md`](./platform/observability.md), sourced from `app-vitals/agent`.

> Optional Sentry error/log reporting, wired identically across the admin, metrics, task-store, and agent services via the shared `@app-vitals/agent-lib/sentry` helper.

Everything below this line through [Configuration reference](#configuration-reference) covers the **write side**: services reporting their own errors/logs into Sentry via the SDK. See [Read side](#read-side) for the error-patrol skills, which query the Sentry Issues API in the opposite direction — pulling issues *out* of Sentry to drive automated fixes.

## What is collected

| Data | Captured by Sentry? |
|---|---|
| Caller identity — which admin or agent token triggered an error | Yes |
| Tags (structured key-value metadata: `service`, `agent_id`, `item_type`, `item_id`) | Yes |

### Foreign response-body snippets

The one exception to "response bodies are never attached" is the agent's task-store client (`createTaskStoreClient().query()` in `agent/src/coding/check-helpers.ts`). When a `GET /tasks` call returns a non-ok status, the response body is attached to the thrown `Error`'s message so a task-store 500 (e.g. its database being unreachable) is diagnosable from the Sentry Issue alone, instead of requiring a timestamp-correlated cross-reference against task-store's own events.

Because the body comes from a *different* service, neither scrub hook above protects it: `stripSensitiveHeaders` only touches `event.request.headers`, and `redactSecrets` only masks *this* process's own live `SECRET_ENV_VARS` values by exact string match. Task-store's `onError` returns `{ error: err.message }` verbatim for any unhandled 500, so a dependency error that echoes its own credentials (a Prisma `P1013` connection-string validation error, for example) would otherwise reach Sentry unredacted.

`redactBodySnippet()` closes that gap at the point of capture, before the message is ever constructed:

- URI userinfo credentials (`postgresql://user:pw@host` → `postgresql://[Filtered]@host`)
- Well-known token prefixes (`ghp_`/`github_pat_`/`sk-`/`xox*-`)
- `Authorization`-style scheme values (`Bearer …`, `Basic …`, `token …`)
- Secret-shaped key/value pairs (`password`, `secret`, `token`, `api_key`, `credential`, `private_key`, `authorization`) in JSON, query strings, and env dumps

Redaction runs over a 2000-char window and the result is then truncated to 500 chars, so a secret straddling the truncation boundary is masked in full rather than half-emitted. What survives is the diagnostic remainder: status text, error class, Prisma error code, host and table names.

### Task-store pool observability

The task-store instruments its `pg` pool to diagnose pool starvation (Sentry SENTRY-5T). It is observability only — pool size and queries are unchanged.

- **Route context** — a middleware records each request's method and matched route pattern, so pool events can be attributed to a route.
- **Connection holds** — a connection held longer than `SHIPWRIGHT_TASK_STORE_POOL_HOLD_THRESHOLD_MS` (default 2000) logs `pg connection held past threshold` with the route, duration, and pool stats.
- **Pool monitor** — every `SHIPWRIGHT_TASK_STORE_POOL_MONITOR_INTERVAL_MS` (default 30000) the pool is checked and `pg pool has waiting clients` is logged when `waiting > 0`. It is stopped on graceful shutdown.
- **Sentry** — when an unhandled error is a pool timeout (Prisma `P2028`, `Unable to start a transaction`, or a pg connection timeout), the captured event carries a `pg_pool` context (total/idle/waiting/max and route) and `route` / `server_name` tags. Other errors are captured unchanged.

Both thresholds are documented in [`docs/configuration-agent.md`](./configuration-agent.md#metrics--admin--chat--task-store-services). The helpers live in `@app-vitals/agent-lib/pool-observability`.

### Pool starvation diagnostics (admin)

The admin service instruments its own `pg.Pool` (separate from task-store's) using `@app-vitals/agent-lib/pool-observability`. This is observability only: pool size and queries are unchanged.

- **Route context** — a middleware records the HTTP method and matched route pattern for each request.
- **Hold tracking** — `pool.connect()` is wrapped so a connection held longer than `SHIPWRIGHT_ADMIN_POOL_HOLD_THRESHOLD_MS` (default 2000) logs `pg connection held past threshold` with the route, `heldMs`, and pool stats.
- **Monitor** — every `SHIPWRIGHT_ADMIN_POOL_MONITOR_INTERVAL_MS` (default 30000) it logs `pg pool has waiting clients` while any client is queued. It is stopped during graceful shutdown.
- **Sentry** — when an unhandled error captured by the admin API is a pool timeout (Prisma `P2028`, "Unable to start a transaction", or a pg connection timeout), the event carries a `pg_pool` context (`total`, `idle`, `waiting`, `max`, `route`) and `route` / `server_name` tags. Other errors are captured unchanged.

## Read side

Where the sections above cover services *reporting* their own errors into Sentry (the write side), the **error-patrol** subsystem reads *out* of Sentry's Issues API to drive automated triage, fixing, and resolution. It's a separate credential pair — `SENTRY_ORG` / `SENTRY_AUTH_TOKEN` — from the write-side `SENTRY_DSN`, and the two are independent: a service can report to Sentry without error-patrol configured, and vice versa.

### Credentials

| Var | Purpose |
|---|---|
| `SENTRY_ORG` | Sentry organization slug (e.g. `acme-corp`), used to build every Issues API URL (`/api/0/organizations/{org}/...`). |
| `SENTRY_AUTH_TOKEN` | Bearer token sent as `Authorization: Bearer $SENTRY_AUTH_TOKEN` on every read-side request. Needs `event:read` scope for the GET endpoints below, and `event:write` scope for error-resolve's mutating PUT. |

Both are env-var-only secrets — see the [Plugin Config](./configuration.md#plugin-config) table in `docs/configuration.md` for the full reference row. Unlike the write-side `SENTRY_DSN` (per-service, optional, silently inert when unset), these two gate whether the read-side skills run at all: each skill checks for both at its first step and exits early (without writing files or mutating the ledger) if either is missing.

### Skills and scripts

Four surfaces read from Sentry, each with a distinct role in the error-patrol pipeline:

- **`error-scan`** (`plugins/shipwright/skills/error-scan/SKILL.md`) — enumerates Sentry projects (`GET /organizations/{org}/projects/`) and unresolved issues (`GET /organizations/{org}/issues/?query=is:unresolved`), tags each issue with its owning service (`GET /projects/{org}/{project_slug}/tags/service/values/`, falling back to the per-issue tag endpoint), diffs against the local ledger to find new/regressed issues, and writes a report. Makes no code changes.
- **`error-fix`** (`plugins/shipwright/skills/error-fix/SKILL.md`) — for each issue surfaced by error-scan, fetches full issue detail (`GET /organizations/{org}/issues/{issue_id}/`) and the latest event's stack trace (`GET /organizations/{org}/issues/{issue_id}/events/latest/`) to drive root-cause analysis, then queues task-store tasks. Opens no PRs itself.
- **`error-resolve`** (`plugins/shipwright/skills/error-resolve/SKILL.md`) — polls the task store for each gating task's status and, only once a task reaches `deployed` or `done`, marks the corresponding Sentry issue resolved (`PUT /organizations/{org}/issues/{issue_id}/` with `{"status": "resolved"}`). This is the only read-side surface that mutates Sentry state.
- **`check-error-patrol.ts`** (`plugins/shipwright/scripts/check-error-patrol.ts`) — the precheck for the `error-patrol-maintenance` cron. Fetches unresolved issues (`GET /organizations/{org}/issues/?query=is:unresolved`) and compares against the ledger to decide whether the cron has new/regressed work to do. Unlike the three skills above, a missing credential or failed fetch here exits permissively (runs the cron anyway) rather than skipping — an unknown state favors running the check over silently going quiet.

All four share the same ledger at `state/error-patrol-ledger.json` and the same Bearer-token auth pattern; none of them ever log `$SENTRY_AUTH_TOKEN`.
