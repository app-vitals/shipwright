# Metrics Dashboard

> Hono service (artifact **B**) that turns Shipwright's pipeline events into analytics. Five read-only JSON endpoints served by a backend-agnostic `MetricsProvider`, plus a session-gated server-rendered dashboard. Four modes: **fixtures** (offline), **posthog** (live PostHog queries), **postgres** (Postgres event store), and **sqlite** (local SQLite store — the default).

## Overview

The metrics service exposes pipeline telemetry two ways: machine-readable JSON under `/metrics/*` (for tooling and the `/shipwright:metrics` command) and a human-facing `/dashboard`. All read endpoints are served by a backend-agnostic `MetricsProvider` interface (`metrics/src/metrics-provider.ts`). The active backend is selected at startup by `selectProviderMode()` (`metrics/src/select-provider.ts`) based on env vars, in priority order:

1. `METRICS_OFFLINE=true` → **fixtures** mode: fixture PostHog client; auth bypassed.
2. PostHog read keys present → **posthog** mode: live `PostHogProvider` (`metrics/src/providers/posthog-provider.ts`).
3. `METRICS_DATABASE_URL` (or `DATABASE_URL_METRICS`) starts with `postgres` → **postgres** mode: `PostgresProvider` (`metrics/src/providers/postgres-provider.ts`) over a Postgres event store; `POST /batch/` ingest is registered.
4. Otherwise (default) → **sqlite** mode: `SqliteProvider` (`metrics/src/providers/sqlite-provider.ts`) over a local SQLite event store; `POST /batch/` ingest is always registered in this mode.

In sqlite mode (the default), the server creates a `LocalEventStore` (`metrics/src/local-store.ts`) at `METRICS_DB_PATH` (`state/metrics.db` by default) and wires it into both the provider and the `POST /batch/` ingest route.

In postgres mode, the server connects to Postgres using `METRICS_DATABASE_URL` (or `DATABASE_URL_METRICS`), provisions the `events` table idempotently (with `insert_id UNIQUE` for dedup), and wires `POST /batch/` ingest to the Postgres store. All aggregation logic is shared with the SQLite provider via `SqlEventStoreProvider` (`metrics/src/providers/sql-provider.ts`) — query results are identical regardless of backend.

Entrypoint: `metrics/src/server.ts` (standalone Bun server, default port **3460**). The app factory `createMetricsApp()` in `metrics/src/api.ts` is what tests drive via `app.request()`.

## Running locally

**Preferred — offline mode** (no credentials needed):

```bash
task api        # or: task ui (same process)
```

Both targets start the metrics server with `METRICS_OFFLINE=true` and serve the dashboard at http://localhost:3460/dashboard. No PostHog keys required — fixture data is injected automatically.

For a full dev environment with Ctrl-C cleanup:

```bash
task dev        # supervisor: starts metrics + kills all children on Ctrl-C
```

**With live PostHog credentials:**

```bash
# Required: a PostHog personal API key + project id
export POSTHOG_PERSONAL_API_KEY=phx_...
export POSTHOG_PROJECT_ID=<your-project-id>

bun metrics/src/server.ts          # serves on :3460 (override with METRICS_API_PORT)
```

`server.ts` calls `validateRequiredEnv(["POSTHOG_PERSONAL_API_KEY", "POSTHOG_PROJECT_ID"])` and **fails fast** listing any missing vars. Env can also be loaded from a dotenv file (`SHIPWRIGHT_ENV_FILE`, default `~/.shipwright/.env`) — set vars are never overwritten.

**Offline mode** — run without any PostHog credentials or external services:

```bash
METRICS_OFFLINE=true bun metrics/src/server.ts
```

When `METRICS_OFFLINE=true`, `server.ts` skips the PostHog env gate, injects a fixture PostHog client (pre-recorded sample data for every query type), and bypasses session auth for `/dashboard` (serves as "Offline User"). Safe for local development and CI environments with no secrets configured.

Validate every HogQL query before deploy (metadata-only, read-only key sufficient):

```bash
POSTHOG_PERSONAL_API_KEY=phx_... POSTHOG_PROJECT_ID=<id> bun run validate:hogql
```

## API Endpoints

All metric endpoints are `GET`, return JSON, and accept the same date-window query params: `preset` (`today` | `7d` | `30d` | `90d`) or an explicit `from`/`to` range. `/metrics/trends` additionally accepts `groupBy`.

| Method | Path | Description |
|---|---|---|
| GET | `/metrics/summary` | Headline totals + average cycle time over the window. |
| GET | `/metrics/trends` | Time-series trends; supports `groupBy`. |
| GET | `/metrics/features` | Per-feature task / CI / review breakdown. |
| GET | `/metrics/queue` | Shipwright v3 queue metrics: funnel counts, block rate, avg cycle time (days), avg review findings. |
| GET | `/metrics/tokens` | Token usage — totals, by agent, by session type, and trends. |
| POST | `/batch/` | PostHog-shaped batch ingest — writes events to the local SQLite store. Only registered when `localStore` is injected via `MetricsDeps`; returns 404 otherwise. |
| GET | `/dashboard` | Server-rendered dashboard HTML (session-gated). |
| GET | `/dashboard/*` | Static dashboard assets (`styles.css`, `app.js`). |
| GET | `/health` | Liveness check — `{ status: "ok" }`, **no auth**. |
| GET | `/openapi.json` | OpenAPI 3.1 document for the service. |

## Auth

The `/metrics/*` endpoints accept **either** credential:

- **Bearer API key** — tokens parsed from `METRICS_API_KEYS`. Scoped tokens (scope `!== "*"`) are rejected with `403` on metrics routes.
- **Session cookie** (`admin_session`) — when `METRICS_REQUIRE_OWNER_ROLE=true` and an accounts client is configured, the caller's role is checked and non-`OWNER` users get `403`.

The **dashboard** is protected by the session cookie middleware; an invalid/absent session redirects to `/admin/login`. In offline mode (`METRICS_OFFLINE=true`), session auth is skipped entirely and `/dashboard` is served as "Offline User". `/health` is always open.

## Environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `POSTHOG_PERSONAL_API_KEY` | ✅ (posthog mode) | — | PostHog personal API key for queries. Not required when `METRICS_OFFLINE=true`. |
| `POSTHOG_PROJECT_ID` | ✅ (posthog mode) | — | PostHog project id. Not required when `METRICS_OFFLINE=true`. |
| `METRICS_OFFLINE` | | `false` | When `true`, skips PostHog env gate, injects fixture data, and bypasses dashboard session auth. |
| `METRICS_DATABASE_URL` | ✅ (postgres mode) | — | Postgres connection URL (`postgres://...`). Selects postgres mode. Takes precedence over `DATABASE_URL_METRICS`. |
| `DATABASE_URL_METRICS` | | — | Alias for `METRICS_DATABASE_URL`. Accepted when `METRICS_DATABASE_URL` is absent. |
| `METRICS_BASE_PATH` | | — | URL path prefix the app is mounted at (e.g. `/sw`). All routes including `/dashboard` and `/metrics/*` are served under this prefix. |
| `METRICS_API_PORT` | | `3460` | Listen port. |
| `METRICS_API_KEYS` | | — | Comma-parsed Bearer API keys for `/metrics/*`. |
| `SHIPWRIGHT_SESSION_SECRET` | | — | HS256 secret for verifying the `admin_session` cookie. |
| `METRICS_REQUIRE_OWNER_ROLE` | | `false` | When `true`, gate dashboard/API on `OWNER` role via the accounts client. |
| `METRICS_ADMIN_URL` | | `http://localhost:3000` | Shipwright admin service base URL (agent name lookups). |
| `METRICS_INTERNAL_API_KEY` | | — | Internal key for the accounts client. |
| `METRICS_DASHBOARD_TOKEN` | | — | Optional dashboard access token. |
| `METRICS_DASHBOARD_DEV_AUTH` | | `false` | Bypasses `/dashboard` and `/metrics/*` auth for local dev (no login flow in `task stack`). Must not be enabled in production. |
| `METRICS_DB_PATH` | | `state/metrics.db` | Path for the local SQLite event store (sqlite mode only). Pass `:memory:` for ephemeral use. |
| `GCP_PROJECT_ID` | | — | Optional — enables GCP Secret Manager as an env-absent fallback for secrets. |
| `SHIPWRIGHT_ENV_FILE` | | `~/.shipwright/.env` | Dotenv file loaded at startup (existing vars win). |

## Key Files

| File | Purpose |
|---|---|
| `metrics/src/server.ts` | Process entrypoint — env validation, provider selection, wiring, `Bun.serve`. |
| `metrics/src/api.ts` | App factory `createMetricsApp()`, route + auth middleware registration, dashboard handler. |
| `metrics/src/metrics-provider.ts` | `MetricsProvider` interface + `MetricQuery` / `MetricTable` types — the backend-agnostic read seam. |
| `metrics/src/select-provider.ts` | Pure env-to-mode selector (`selectProviderMode()`) — maps env vars to `"fixtures" \| "posthog" \| "postgres" \| "sqlite"`. |
| `metrics/src/providers/posthog-provider.ts` | `PostHogProvider` — implements `MetricsProvider` over a `PostHogClient` and HogQL query builders. |
| `metrics/src/providers/sql-provider.ts` | `SqlEventStoreProvider` — shared aggregation engine; all 13 query kinds in TypeScript over any `SqlEventStore`. |
| `metrics/src/providers/sqlite-provider.ts` | `SqliteProvider` — thin wrapper adapting `LocalEventStore` to `SqlEventStoreProvider`. |
| `metrics/src/providers/postgres-provider.ts` | `PostgresProvider` / `createPostgresEventStore()` — Postgres backend using `pg.Pool`; provisions DDL; wraps `SqlEventStoreProvider`. |
| `metrics/src/queries.ts` | HogQL query builders (summary, trends, features, queue, tokens); used by `PostHogProvider`. |
| `metrics/src/posthog-client.ts` | PostHog client (interface + `Http` impl). |
| `metrics/src/fixtures/posthog-fixtures.ts` | Fixture PostHog client (`createFixturePostHogClient()`) — pre-recorded sample data for every query type; used in offline mode and integration tests. |
| `metrics/src/local-store.ts` | Local SQLite event store (`LocalEventStore` interface + `createLocalEventStore()`). Deduplicates on `insert_id`; used by `POST /batch/` and `SqliteProvider`. |
| `metrics/src/validate-hogql.ts` | Pre-deploy HogQL validation runner (`validate:hogql`). |
| `metrics/src/cache.ts` | In-process query-result cache. |
| `metrics/src/secrets.ts` | Secrets resolution: env-first, optional GCP Secret Manager fallback. |
| `metrics/src/dashboard/` | Server-rendered dashboard (`dashboard-page.ts`, `app.js`, `styles.css`, `index.html`). |
| `metrics/src/lib/` | Shared closure: accounts client, api-auth, session middleware, env, errors, clock. |

## Testing

Unit + integration + smoke layers (`bun test --filter metrics`). Integration tests inject a `createFixturePostHogClient()` double (from `metrics/src/fixtures/posthog-fixtures.ts`) — pre-recorded sample results, no network calls — or a `RecordedPostHogClient` (cassettes under `metrics/tests/fixtures/posthog/`); smoke tests drive the Hono app via `app.request()`. Keep `POSTHOG_PERSONAL_API_KEY` **unset** so the suite stays offline.

E2E layer (`task e2e` → `cd metrics && bunx playwright test`): Playwright Chromium headless tests against a real running Bun server (`metrics/e2e/test-server.ts`). PostHog API calls are intercepted via Playwright route mocking — no real PostHog key needed. Session cookies are signed with a pinned test secret (`e2e-test-session-secret-32b`). Test file: `metrics/e2e/dashboard.e2e.ts`. Config: `metrics/playwright.config.ts`.

See [testing.md](./testing.md).

## See also

- [architecture.md](./architecture.md) — where the metrics service sits in the A→B→C design.
- `plugins/shipwright/references/metrics-schema.md` — the `metrics.jsonl` schema the pipeline emits, which feeds these queries.
