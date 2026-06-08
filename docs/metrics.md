# Metrics Dashboard

> Hono service (artifact **B**) that turns Shipwright's pipeline events into analytics. Five read-only JSON endpoints, a session-gated server-rendered dashboard, and a PostHog-shaped `POST /batch/` ingest route — designed over a **backend-agnostic event-store interface** (PostHog · Postgres · SQLite).

## Overview

The metrics service reads pipeline telemetry from an **event store** and exposes it two ways: machine-readable JSON under `/metrics/*` (for tooling and the `/shipwright:metrics` command) and a human-facing `/dashboard`. The goal is that the dashboard and API are identical regardless of which store backs them — see [Backends](#backends). When a writable store is active, a `POST /batch/` ingest route accepts PostHog-shaped events; it is absent (404) otherwise.

Entrypoint: `metrics/src/server.ts` (standalone Bun server, default port **3460**). The app factory `createMetricsApp()` in `metrics/src/api.ts` is what tests drive via `app.request()`.

## Backends

Metrics is designed around a backend-agnostic **`MetricsProvider`** seam: the API expresses query *intent* as typed data and each provider renders it to its store's native query, returning a normalized result. Because every supported backend is an **event store** (events-with-properties + arbitrary aggregation), all metrics return identical results across them.

| Backend | Model | Status |
|---|---|---|
| **PostHog** (HogQL) | hosted event store | **Live today** — the default when `POSTHOG_PERSONAL_API_KEY` + `POSTHOG_PROJECT_ID` are set. |
| **SQLite** (SQL) | local event store | Ingest (`POST /batch/`) **live today**; read-side + local-default mode planned (LDS-1.3). |
| **Postgres** (SQL) | self-hosted event store | Planned (LDS-1.4) — shares the SQLite SQL layer, dialect-parameterized. |

> **Prometheus is intentionally not a backend.** It is a numeric time-series database and cannot store event properties, so it cannot serve event-level delivery analytics (estimation accuracy, complexity distribution, per-feature breakdowns, cycle-time joins). It is the right tool for runtime/operational metrics — a separate concern from this service. See `docs/superpowers/specs/2026-06-08-metrics-backend-interface-design.md`.

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
- **Session cookie** (`vitals_session`) — when `METRICS_REQUIRE_OWNER_ROLE=true` and an accounts client is configured, the caller's role is checked and non-`OWNER` users get `403`.

The **dashboard** is protected by the session cookie middleware; an invalid/absent session redirects to `/auth/login`. In offline mode (`METRICS_OFFLINE=true`), session auth is skipped entirely and `/dashboard` is served as "Offline User". `/health` is always open.

## Environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `POSTHOG_PERSONAL_API_KEY` | ✅ (not offline) | — | PostHog personal API key for queries. Not required when `METRICS_OFFLINE=true`. |
| `POSTHOG_PROJECT_ID` | ✅ (not offline) | — | PostHog project id. Not required when `METRICS_OFFLINE=true`. |
| `METRICS_OFFLINE` | | `false` | When `true`, skips PostHog env gate, injects fixture data, and bypasses dashboard session auth. |
| `METRICS_API_PORT` | | `3460` | Listen port. |
| `METRICS_API_KEYS` | | — | Comma-parsed Bearer API keys for `/metrics/*`. |
| `SESSION_SECRET` | | — | HS256 secret for verifying the `vitals_session` cookie. |
| `METRICS_REQUIRE_OWNER_ROLE` | | `false` | When `true`, gate dashboard/API on `OWNER` role via the accounts client. |
| `METRICS_ACCOUNTS_URL` | | `http://localhost:3457` | Accounts service base URL (role lookups). |
| `METRICS_INTERNAL_API_KEY` | | — | Internal key for the accounts client. |
| `METRICS_DASHBOARD_TOKEN` | | — | Optional dashboard access token. |
| `METRICS_DB_PATH` | | `state/metrics.db` | Path for the local SQLite event store used by `POST /batch/`. Only read when a `localStore` is wired in. Pass `:memory:` for ephemeral use. |
| `GCP_PROJECT_ID` | | — | Optional — enables GCP Secret Manager as an env-absent fallback for secrets. |
| `SHIPWRIGHT_ENV_FILE` | | `~/.shipwright/.env` | Dotenv file loaded at startup (existing vars win). |

## Key Files

| File | Purpose |
|---|---|
| `metrics/src/server.ts` | Process entrypoint — env validation, wiring, `Bun.serve`. |
| `metrics/src/api.ts` | App factory `createMetricsApp()`, route + auth middleware registration, dashboard handler. |
| `metrics/src/queries.ts` | HogQL query builders (summary, trends, features, queue, tokens). |
| `metrics/src/posthog-client.ts` | PostHog client (interface + `Http` impl). |
| `metrics/src/fixtures/posthog-fixtures.ts` | Fixture PostHog client (`createFixturePostHogClient()`) — pre-recorded sample data for every query type; used in offline mode and integration tests. |
| `metrics/src/local-store.ts` | Local SQLite event store (`LocalEventStore` interface + `createLocalEventStore()`). Deduplicates on `insert_id`; used by `POST /batch/`. |
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
