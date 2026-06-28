# Metrics Dashboard

> Hono service (artifact **B**) that turns Shipwright's pipeline events into analytics. Five read-only JSON endpoints served by a backend-agnostic `MetricsProvider`, plus a session-gated server-rendered dashboard. Two modes: **fixtures** (offline), **taskstore** (live task-store + admin APIs).

## Overview

The metrics service exposes pipeline telemetry two ways: machine-readable JSON under `/metrics/*` (for tooling and the `/shipwright:metrics` command) and a human-facing `/dashboard`. All read endpoints are served by a backend-agnostic `MetricsProvider` interface (`metrics/src/metrics-provider.ts`). The active backend is selected at startup by `selectProviderMode()` (`metrics/src/select-provider.ts`) based on env vars, in priority order:

1. `METRICS_OFFLINE=true` → **fixtures** mode: an offline `TaskStoreProvider` over recorded cassettes (`createFixtureTaskStoreProvider()`, `metrics/src/fixtures/task-store-fixtures.ts`); auth bypassed.
2. `METRICS_TASK_STORE_URL` + `METRICS_ADMIN_URL` both `http(s)` → **taskstore** mode: live `TaskStoreProvider` (`metrics/src/providers/task-store-provider.ts`) over an `HttpTaskStoreClient` (`metrics/src/lib/task-store-client.ts`) and an `HttpAdminMetricsClient` (`metrics/src/lib/admin-metrics-client.ts`).

The legacy event-store backends (PostHog, SQLite, Postgres) and the `POST /batch/` ingest endpoint have been removed. The metrics service is now read-only, backed either by fixture data (offline) or by the task-store and admin APIs (live).

Entrypoint: `metrics/src/server.ts` (standalone Bun server, default port **3460**). The app factory `createMetricsApp()` in `metrics/src/api.ts` is what tests drive via `app.request()`.

## Running locally

**Preferred — offline mode** (no credentials needed):

```bash
task api        # or: task ui (same process)
```

Both targets start the metrics server with `METRICS_OFFLINE=true` and serve the dashboard at http://localhost:3460/dashboard. Fixture data is injected automatically; no external services required.

For a full dev environment with Ctrl-C cleanup:

```bash
task dev        # supervisor: starts metrics + kills all children on Ctrl-C
```

**Against the live task-store + admin services (taskstore mode):**

```bash
# Both URLs must be http(s) to select taskstore mode
export METRICS_TASK_STORE_URL=http://localhost:3002
export METRICS_TASK_STORE_TOKEN=<task-store-token>
export METRICS_ADMIN_URL=http://localhost:3000
export METRICS_INTERNAL_API_KEY=<admin-internal-key>

bun metrics/src/server.ts          # serves on :3460 (override with METRICS_API_PORT)
```

In taskstore mode, `server.ts` wires a `TaskStoreProvider` over an `HttpTaskStoreClient` (tasks + PRs) and an `HttpAdminMetricsClient` (token-aggregation stats). Env can also be loaded from a dotenv file (`SHIPWRIGHT_ENV_FILE`, default `~/.shipwright/.env`) — set vars are never overwritten.

## API Endpoints

All metric endpoints are `GET`, return JSON, and accept the same date-window query params: `preset` (`today` | `7d` | `30d` | `90d`) or an explicit `from`/`to` range. `/metrics/trends` additionally accepts `groupBy`.

| Method | Path | Description |
|---|---|---|
| GET | `/metrics/summary` | Headline totals + average cycle time over the window. |
| GET | `/metrics/trends` | Time-series trends; supports `groupBy`. |
| GET | `/metrics/features` | Per-feature task / CI / review breakdown. |
| GET | `/metrics/queue` | Shipwright v3 queue metrics: funnel counts, block rate, avg cycle time (days), avg review findings. |
| GET | `/metrics/tokens` | Token usage — totals, by agent, by session type, by agent + session type, by agent + cron, by agent + model, and trends; each group includes a `cost` field (USD). |
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
| `METRICS_TASK_STORE_URL` | ✅ (taskstore mode) | — | Shipwright task-store base URL (`http(s)://…`). With `METRICS_ADMIN_URL` also set to http(s), selects taskstore mode. |
| `METRICS_TASK_STORE_TOKEN` | | — | Bearer token for the task-store service (taskstore mode). |
| `METRICS_OFFLINE` | | `false` | When `true`, injects fixture (cassette-backed) data and bypasses dashboard session auth. |
| `METRICS_BASE_PATH` | | — | URL path prefix the app is mounted at (e.g. `/sw`). All routes including `/dashboard` and `/metrics/*` are served under this prefix. |
| `METRICS_API_PORT` | | `3460` | Listen port. |
| `METRICS_API_KEYS` | | — | Comma-parsed Bearer API keys for `/metrics/*`. |
| `SHIPWRIGHT_SESSION_SECRET` | | — | HS256 secret for verifying the `admin_session` cookie. |
| `METRICS_REQUIRE_OWNER_ROLE` | | `false` | When `true`, gate dashboard/API on `OWNER` role via the accounts client. |
| `METRICS_ADMIN_URL` | ✅ (taskstore mode) | `http://localhost:3000` | Shipwright admin service base URL (agent name lookups + token-aggregation stats). With `METRICS_TASK_STORE_URL` also set to http(s), selects taskstore mode. |
| `METRICS_INTERNAL_API_KEY` | | — | Internal key for the accounts client. |
| `METRICS_DASHBOARD_TOKEN` | | — | Optional dashboard access token. |
| `METRICS_DASHBOARD_DEV_AUTH` | | `false` | Bypasses `/dashboard` and `/metrics/*` auth for local dev (no login flow in `task stack`). Must not be enabled in production. |
| `GCP_PROJECT_ID` | | — | Optional — enables GCP Secret Manager as an env-absent fallback for secrets. |
| `SHIPWRIGHT_ENV_FILE` | | `~/.shipwright/.env` | Dotenv file loaded at startup (existing vars win). |

## Key Files

| File | Purpose |
|---|---|
| `metrics/src/server.ts` | Process entrypoint — env validation, provider selection, wiring, `Bun.serve`. |
| `metrics/src/api.ts` | App factory `createMetricsApp()`, route + auth middleware registration, dashboard handler. |
| `metrics/src/metrics-provider.ts` | `MetricsProvider` interface + `MetricQuery` / `MetricTable` types — the backend-agnostic read seam. |
| `metrics/src/select-provider.ts` | Pure env-to-mode selector (`selectProviderMode()`) — maps env vars to `"fixtures" \| "taskstore"`. |
| `metrics/src/providers/task-store-provider.ts` | `TaskStoreProvider` — implements `MetricsProvider` over a `TaskStoreClient` (tasks + PRs) and an `AdminMetricsClient` (token stats); the live read backend for taskstore mode. |
| `metrics/src/lib/task-store-client.ts` | `TaskStoreClient` interface + `HttpTaskStoreClient` impl (and `TaskStoreClientError`) — reads tasks + PRs from the task-store HTTP API. |
| `metrics/src/lib/admin-metrics-client.ts` | `AdminMetricsClient` interface + `HttpAdminMetricsClient` impl (and `AdminMetricsClientError`) — reads token-aggregation stats from the admin service. |
| `metrics/src/providers/task-store-recorded.ts` | `RecordedTaskStoreClient` + `RecordedAdminMetricsClient` — replay cassette data offline; back the fixtures provider and integration tests. |
| `metrics/src/fixtures/task-store-fixtures.ts` | `createFixtureTaskStoreProvider()` — offline `TaskStoreProvider` over recorded cassettes with a fixed clock; used in offline mode and integration tests. |
| `metrics/src/cache.ts` | In-process query-result cache. |
| `metrics/src/secrets.ts` | Secrets resolution: env-first, optional GCP Secret Manager fallback. |
| `metrics/src/dashboard/` | Server-rendered dashboard (`dashboard-page.ts`, `app.js`, `styles.css`, `index.html`). |
| `metrics/src/lib/` | Shared closure: accounts client, api-auth, session middleware, env, errors, clock. |

## Testing

Unit + integration + smoke layers (`bun test --filter metrics`). Integration tests inject `RecordedTaskStoreClient` + `RecordedAdminMetricsClient` doubles (from `metrics/src/providers/task-store-recorded.ts`) over canned cassettes and a fixed clock — pre-recorded sample results, no network calls; smoke tests drive the Hono app via `app.request()`. The suite stays fully offline with no external service URLs configured.

E2E layer (`task e2e` → `cd metrics && bunx playwright test`): Playwright Chromium headless tests against a real running Bun server (`metrics/e2e/test-server.ts`). Task-store and admin API calls are intercepted via Playwright route mocking — no real services needed. Session cookies are signed with a pinned test secret (`e2e-test-session-secret-32b`). Test file: `metrics/e2e/dashboard.e2e.ts`. Config: `metrics/playwright.config.ts`.

See [testing.md](./testing.md).

## See also

- [architecture.md](./architecture.md) — where the metrics service sits in the A→B→C→D design.
- `plugins/shipwright/references/metrics-schema.md` — the `metrics.jsonl` schema the pipeline emits, which feeds these queries.
