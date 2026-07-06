# Observability

> Optional Sentry error/log reporting, wired identically across the admin, metrics, task-store, and agent services via the shared `lib/sentry.ts` helper.

## Overview

Every Shipwright service (`admin`, `metrics`, `task-store`, `agent`) can report to Sentry when `SENTRY_DSN` is set in its own environment. Each service reads its own `SENTRY_DSN` — there is no shared/global toggle. When `SENTRY_DSN` is unset (the default), Sentry is fully inert: no init call, zero telemetry, zero overhead.

All services share the same init options and scrub hooks via `buildSentryInitOptions()` / `initSentry()` in `lib/sentry.ts`, so behavior is identical regardless of which service reports.

## What is collected

When `SENTRY_DSN` is set, a service reports:

- **Unhandled exceptions and 5xx errors**, with stack traces, after scrubbing (see below).
- **`console.log` / `console.warn` / `console.error` calls**, forwarded as structured Sentry Logs via `consoleLoggingIntegration`.
- **Request path and method** for errors that occur inside an HTTP handler (via `@sentry/hono`'s `sentry()` middleware, or the app's own `onError` hook).

## What is never collected

- **Request headers** — `Authorization` and `Cookie` headers are unconditionally stripped from every event before it leaves the process, regardless of whether any secret env var is set.
- **Request bodies** — request/response bodies are never attached to Sentry events.
- **Secret values** — any currently-set value of a secret-shaped env var (`ANTHROPIC_API_KEY`, `GH_TOKEN`, `SHIPWRIGHT_SESSION_SECRET`, etc. — see `SECRET_ENV_VARS` in `lib/sentry.ts` for the full list) is redacted to `[Filtered]` wherever it appears in an event or log, including nested inside longer strings. This scrub runs on both error events (`scrubEvent`) and console-derived logs (`scrubLog`).

## Disabling Sentry

Unset `SENTRY_DSN` (or never set it) for the service in question. This is the default — no other configuration is required to keep a service fully offline from Sentry's perspective.

## Self-hosted Sentry

`SENTRY_DSN` works with a self-hosted Sentry instance the same way it works with Sentry's SaaS offering — point it at your own instance/project's DSN instead of a sentry.io one. No other configuration changes are needed.

## Configuration reference

See the `SENTRY_DSN` / `SENTRY_ENVIRONMENT` rows under [Observability](./configuration.md#observability) in `docs/configuration.md` for the full per-service env var reference.

## See also

- [`docs/configuration.md`](./configuration.md) — full env var reference
- [`lib/sentry.ts`](../lib/sentry.ts) — shared init options, scrub hooks, and secret allowlist
