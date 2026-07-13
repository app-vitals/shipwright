# Observability

> Optional Sentry error/log reporting, wired identically across the admin, metrics, task-store, and agent services via the shared `lib/sentry.ts` helper.

Everything below this line through [Configuration reference](#configuration-reference) covers the **write side**: services reporting their own errors/logs into Sentry via the SDK. See [Read side](#read-side) for the error-patrol skills, which query the Sentry Issues API in the opposite direction — pulling issues *out* of Sentry to drive automated fixes.

## Overview

Every Shipwright service (`admin`, `metrics`, `task-store`, `agent`) can report to Sentry when `SENTRY_DSN` is set in its own environment. Each service reads its own `SENTRY_DSN` — there is no shared/global toggle. When `SENTRY_DSN` is unset (the default), or when `NODE_ENV` is `"test"` (explicitly set via `NODE_ENV=test` prefix in test commands), Sentry is fully inert: no init call, zero telemetry, zero overhead. The test guard prevents test error-path assertions from leaking to production Sentry as real events.

All services share the same init options and scrub hooks via `buildSentryInitOptions()` / `initSentry()` in `lib/sentry.ts`, so behavior is identical regardless of which service reports.

## What is collected

When `SENTRY_DSN` is set, a service reports:

- **Unhandled exceptions and 5xx errors**, with stack traces, after scrubbing (see below).
- **`console.log` / `console.warn` / `console.error` calls**, forwarded as structured Sentry Logs via `consoleLoggingIntegration`.
- **Request path and method** for errors that occur inside an HTTP handler (via `@sentry/hono`'s `sentry()` middleware, or the app's own `onError` hook).
- **Caller identity** (admin or agent token) in error logs from admin, metrics, and task-store, for tracing which token triggered an unhandled error.

## What is never collected

- **Request headers** — `Authorization` and `Cookie` header **values** are unconditionally redacted to `[Filtered]` in every event before it leaves the process, regardless of whether any secret env var is set. (The header keys remain; only the values are scrubbed.)
- **Request bodies** — request/response bodies are never attached to Sentry events.
- **Secret values** — any currently-set value of a secret-shaped env var (`ANTHROPIC_API_KEY`, `GH_TOKEN`, `SHIPWRIGHT_SESSION_SECRET`, etc. — see `SECRET_ENV_VARS` in `lib/sentry.ts` for the full list) is redacted to `[Filtered]` wherever it appears in an event or log, including nested inside longer strings. This scrub runs on both error events (`scrubEvent`) and console-derived logs (`scrubLog`).

## Disabling Sentry

Unset `SENTRY_DSN` (or never set it) for the service in question. This is the default — no other configuration is required to keep a service fully offline from Sentry's perspective. Alternatively, `Sentry` is automatically disabled during test runs (when `NODE_ENV` is `"test"`, explicitly set via `NODE_ENV=test` prefix in test commands like `NODE_ENV=test bun test`) even if `SENTRY_DSN` is present in the environment, preventing test assertions from polluting production Sentry with unintended error events.

## Self-hosted Sentry

`SENTRY_DSN` works with a self-hosted Sentry instance the same way it works with Sentry's SaaS offering — point it at your own instance/project's DSN instead of a sentry.io one. No other configuration changes are needed.

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

- **`error-scan`** (`plugins/shipwright/skills/error-scan/SKILL.md`) — enumerates Sentry projects (`GET /organizations/{org}/projects/`) and unresolved issues (`GET /organizations/{org}/issues/?query=is:unresolved`), tags each issue with its owning service (`GET /organizations/{org}/{project_slug}/tags/service/values/`, falling back to the per-issue tag endpoint), diffs against the local ledger to find new/regressed issues, and writes a report. Makes no code changes.
- **`error-fix`** (`plugins/shipwright/skills/error-fix/SKILL.md`) — for each issue surfaced by error-scan, fetches full issue detail (`GET /organizations/{org}/issues/{issue_id}/`) and the latest event's stack trace (`GET /organizations/{org}/issues/{issue_id}/events/latest/`) to drive root-cause analysis, then queues task-store tasks. Opens no PRs itself.
- **`error-resolve`** (`plugins/shipwright/skills/error-resolve/SKILL.md`) — polls the task store for each gating task's status and, only once a task reaches `deployed` or `done`, marks the corresponding Sentry issue resolved (`PUT /organizations/{org}/issues/{issue_id}/` with `{"status": "resolved"}`). This is the only read-side surface that mutates Sentry state.
- **`check-error-patrol.ts`** (`plugins/shipwright/scripts/check-error-patrol.ts`) — the precheck for the `error-patrol-maintenance` cron. Fetches unresolved issues (`GET /organizations/{org}/issues/?query=is:unresolved`) and compares against the ledger to decide whether the cron has new/regressed work to do. Unlike the three skills above, a missing credential or failed fetch here exits permissively (runs the cron anyway) rather than skipping — an unknown state favors running the check over silently going quiet.

All four share the same ledger at `state/error-patrol-ledger.json` and the same Bearer-token auth pattern; none of them ever log `$SENTRY_AUTH_TOKEN`.

## Configuration reference

See the `SENTRY_DSN` / `SENTRY_ENVIRONMENT` rows under [Observability](./configuration.md#observability) in `docs/configuration.md` for the full per-service env var reference, and the `SENTRY_ORG` / `SENTRY_AUTH_TOKEN` rows under [Plugin Config](./configuration.md#plugin-config) for the read-side credentials.

## See also

- [`docs/configuration.md`](./configuration.md) — full env var reference
- [`lib/sentry.ts`](../lib/sentry.ts) — shared init options, scrub hooks, and secret allowlist
- [`plugins/shipwright/skills/error-scan/SKILL.md`](../plugins/shipwright/skills/error-scan/SKILL.md), [`error-fix/SKILL.md`](../plugins/shipwright/skills/error-fix/SKILL.md), [`error-resolve/SKILL.md`](../plugins/shipwright/skills/error-resolve/SKILL.md) — the read-side skills
