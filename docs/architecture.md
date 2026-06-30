# Architecture

> How Shipwright Harness is structured: four sequenced artifacts (plugin → metrics → agent → task-store) plus supporting surfaces, all MIT, all local-first.

## Overview

Shipwright Harness is the open-source autonomous delivery system in your own environment. It ships as four artifacts, built and sequenced **A → B → C → D**, each independently runnable and depending on **no external platform service**:

| Phase | Artifact | Directory | What it is |
|---|---|---|---|
| **A** | **Plugin** (the system) | `plugins/shipwright/` | The Claude Code plugin users `/plugin install` — commands, skills, agents, scripts for the full delivery loop. Repo-agnostic. |
| **B** | **Metrics dashboard** | `metrics/` | Hono service: backend-agnostic `MetricsProvider` JSON endpoints + a server-rendered dashboard. Two modes: fixtures (offline), taskstore (live task-store + admin APIs). |
| **C** | **Shipwright agent** | `agent/` + `admin/` | Hono service + Prisma store (in `@shipwright/admin`); a thin autonomous runner: pick next ready task → build → ship PR → forward metrics. |
| **D** | **Task store service** | `task-store/` | Postgres-backed task queue, PR tracking, and scoped tokens. Prisma schema defines `Task`, `PullRequest`, and `TaskToken` models; re-exported as `@shipwright/task-store` for use by plugin scripts and agent services. Replaces the JSON file fallback. |

The hard architectural rule: **no new coupling.** The plugin stays repo-agnostic; the metrics service and the agent each stand alone. Everything runs offline by default (fixtures / injected doubles / scratch queue); live external calls happen only when an env var explicitly enables them.

## A — Plugin

The plugin drives the delivery loop: **spec → plan → execute → review → deploy**. It is repo-agnostic — it runs its commands against *any* repository, and this repo is both its source and a codebase it ships against.

Key surfaces (see `plugins/shipwright/README.md` and `plugins/shipwright/CLAUDE.md` for the full command/skill catalog):

- **Commands** (`commands/`) — `prd`, `plan-session`, `dev-task`, `review`, `patch`, `deploy`, the five-phase test-readiness pipeline (`test-inventory` → `test-design` → `test-migration` → `test-roadmap` → `test-publish`), `metrics`, `research`, `research-docs`, and more.
- **Skills** (`skills/`) — autonomous behaviors including `ship-loop` (drains the task queue one pipeline step per call) and `shipwright-brand`.
- **Scripts** (`scripts/`) — the task-store adapters, `check-dev-task.ts`, and supporting tooling.
- **References** (`references/`) — schemas and recipes (`metrics-schema.md`, `task-store.md`, `doc-refresh-recipe.md`, `reviews-schema.md`, …).

The plugin is pure TypeScript with **no server, no database, and no external HTTP in production code** — only `unit` and `integration` test layers apply.

## B — Metrics dashboard

A Hono service that turns pipeline events into analytics. Two sets of read-only JSON endpoints: authenticated `/metrics/*` (summary, trends, features, queue, tokens) and unauthenticated `/public/*` (summary, trends, features, queue), plus session-gated `/dashboard` and public `/public/dashboard`. All served by a backend-agnostic `MetricsProvider` interface. The active backend is selected from env at startup: **fixtures** (offline) or **taskstore** (live task-store + admin APIs). See **[metrics.md](./metrics.md)**.

## C — Shipwright agent

A thin autonomous runner with a Prisma-backed store (PostgreSQL) and four HTTP surfaces: a machine-polled **runtime API** (`/agents/:id/config`, `/agents/:id/crons`), a human-facing **admin CRUD API** (`POST /agents` to create agents; `/agents/:id/...` for envs, crons, tools, tokens, plugins — unified surface with runtime API, separate auth), a server-rendered **admin UI** (`/admin/...` — login, agent list/detail, Slack provisioning, tasks), and a public **read-only task board** (`GET /public/tasks` — unauthenticated, scoped to a configurable repo, no mutations). See **[agent.md](./agent.md)**.

> The Dockerfile `ENTRYPOINT` is `bun run admin/src/main.ts`, the standalone admin service that runs migrations and mounts all admin + runtime routes. The agent process (`agent/src/run-agent.ts`) is now a minimal server: dev `/chat` transport only (health check and `/agents/*` proxy were removed in UNI-1.3; health runs on a dedicated port via `startHealthServer`). For a full agent startup sequence (env validation, config fetch, GitHub auth, mise, plugin install) run `agent/src/entrypoint-main.ts`, which starts the health server in-process before setup and then spawns `run-agent.ts`. Implemented surfaces: the admin CRUD API, the admin UI, and the runtime API (all in `admin/src/` — package `@shipwright/admin`), the Prisma store (`admin/prisma/schema.prisma`), the Slack event handler (`slack.ts`), the cron runtime (`cron-handler.ts`), and the dev-only chat transport (`chat.ts`, gated by `SHIPWRIGHT_DEV_CHAT=true`).

## D — Task store service

Postgres-backed task queue, PR tracking, and scoped tokens (`@shipwright/task-store`). The Hono app is composed from injected services by `createTaskStoreApp` (`task-store/src/app.ts`); `/health` and the `/docs/:id` capability URL are unauthenticated, everything else requires a bearer token.

### Ephemeral document store (`/docs`)

A small in-memory HTML store for short-lived, regenerable artifacts (one-pagers, reports, rendered plans) shared via capability URL. The `render-plan.ts` script uses this endpoint to upload rendered HTML and return a shareable URL to callers.

**API:**

- `POST /docs` — bearer auth; body is the raw HTML string; returns `201 { id, url, expiresIn }`.
- `GET /docs/:id` — **no auth** (the unguessable id is the credential); serves the HTML as `text/html; charset=utf-8`; `404` on miss or expiry.

**Configuration:**

- `SHIPWRIGHT_TASK_STORE_DOC_TTL_SECONDS` (default `3600`) — TTL for documents in seconds; expiry is driven by an injected `Clock`.
- `SHIPWRIGHT_TASK_STORE_PUBLIC_URL` (optional) — public base URL for capability URLs. When unset, the request origin is used. For example, `https://shipwright.example.com` produces capability URLs like `https://shipwright.example.com/docs/id-123`.

**Clients:**

- `render-plan.ts` (plugin script) — uploads rendered planning HTML when `SHIPWRIGHT_TASK_STORE_URL` and `SHIPWRIGHT_TASK_STORE_TOKEN` are set; falls back to writing a local temp file on upload failure.

> ⚠️ **Single-replica caveat.** Storage is process-local (a plain `Map` in `task-store/src/doc-store.ts`) — a document POSTed to one replica is **not** visible from another, and all documents are lost on restart. Acceptable for the ephemeral MVP; it requires a single replica or sticky routing, and is flagged for a future durable backend (object storage / DB-backed blob).

## Supporting surfaces

| Surface | Directory | Notes |
|---|---|---|
| Marketing site | `site/` | Astro + Tailwind (**shipwrightharness.com**). **Not** a Bun workspace; Playwright smoke tests (`*.spec.ts`). |
| Brand system | `brand/` | Locked design system (`BRAND.md`, `tokens.json`) + CSS build + lint, consumed by `site/`. |
| Local state | `state/` | Git-ignored JSON fallback (local-only, used when neither the Postgres task-store service nor GitHub/Jira backend is available) + cached review state. |

## Workspace layout

The repo is a Bun-workspaces monorepo with **go-task** (`Taskfile.yml`) as the single local entrypoint. Five workspaces — `plugins/shipwright`, `metrics`, `agent`, `admin`, `task-store` — are wired into the root `package.json`. The `site/` is intentionally excluded from the root `bun test` scan (its Playwright `*.spec.ts` files would crash Bun's runner).

```
shipwright/
├── plugins/shipwright/   A — the plugin (commands, skills, agents, scripts)
├── metrics/              B — provider-agnostic Hono service (fixtures / taskstore)
├── agent/                C — Shipwright agent runtime (entrypoint, cron, Slack, GitHub auth)
├── admin/                C — Admin service: CRUD API, admin UI, Prisma store (@shipwright/admin)
├── task-store/           D — Task queue service: Postgres + Prisma, exports @shipwright/task-store
├── site/                 marketing site (Astro, separate toolchain)
├── brand/                locked design system
├── state/                local task-store / review-cache fallback
├── docs/                 this documentation
└── Taskfile.yml          single local entrypoint (task setup / ci / test / …)
```

## See also

- **[testing.md](./testing.md)** — the four-layer test architecture and isolation contract.
- **[metrics.md](./metrics.md)** — metrics service API and dashboard.
- **[agent.md](./agent.md)** — Shipwright agent runtime + admin APIs and data model.
- **[configuration.md](./configuration.md)** — all configuration options: plugin env vars, agent env vars, and policy fields.
- `CLAUDE.md` — contributor conventions and the pre-public scrub rule.
