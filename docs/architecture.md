# Architecture

> How Shipwright Harness is structured: three sequenced artifacts (plugin → metrics → agent) plus supporting surfaces, all MIT, all local-first.

## Overview

Shipwright Harness is the open-source autonomous delivery agent for [Claude Code](https://www.anthropic.com/claude-code). It ships as three artifacts, built and sequenced **A → B → C**, each independently runnable and depending on **no external platform service**:

| Phase | Artifact | Directory | What it is |
|---|---|---|---|
| **A** | **Plugin** (the system) | `plugins/shipwright/` | The Claude Code plugin users `/plugin install` — commands, skills, agents, scripts for the full delivery loop. Repo-agnostic. |
| **B** | **Metrics dashboard** | `metrics/` | Hono service: backend-agnostic `MetricsProvider` JSON endpoints + a server-rendered dashboard. Four modes: fixtures (offline), posthog (live), postgres (Postgres event store), sqlite (default — local SQLite store + `POST /batch/` ingest). |
| **C** | **Shipwright agent** | `agent/` + `admin/` | Hono service + Prisma store (in `@shipwright/admin`); a thin autonomous runner: pick next ready task → build → ship PR → forward metrics. |

The hard architectural rule: **no new coupling.** The plugin stays repo-agnostic; the metrics service and the agent each stand alone. Everything runs offline by default (fixtures / injected doubles / scratch queue); live external calls happen only when an env var explicitly enables them.

## A — Plugin

The plugin drives the delivery loop: **spec → plan → execute → review → deploy**. It is repo-agnostic — it runs its commands against *any* repository, and this repo is both its source and a codebase it ships against.

Key surfaces (see `plugins/shipwright/README.md` and `plugins/shipwright/CLAUDE.md` for the full command/skill catalog):

- **Commands** (`commands/`) — `brainstorm`, `plan-session`, `dev-task`, `review`, `patch`, `deploy`, the five-phase test-readiness pipeline (`test-inventory` → `test-design` → `test-migration` → `test-roadmap` → `test-publish`), `metrics`, `research`, `research-docs`, and more.
- **Skills** (`skills/`) — autonomous behaviors including `ship-loop` (drains the task queue one pipeline step per call) and `shipwright-brand`.
- **Scripts** (`scripts/`) — the task-store adapters, `check-dev-task.ts`, and supporting tooling.
- **References** (`references/`) — schemas and recipes (`metrics-schema.md`, `task-store.md`, `doc-refresh-recipe.md`, `reviews-schema.md`, …).

The plugin is pure TypeScript with **no server, no database, and no external HTTP in production code** — only `unit` and `integration` test layers apply.

## B — Metrics dashboard

A Hono service that turns pipeline events into analytics. Five read-only JSON endpoints (`/metrics/summary|trends|features|queue|tokens`) plus a session-gated `/dashboard`, all served by a backend-agnostic `MetricsProvider` interface. The active backend is selected from env at startup: **fixtures** (offline), **posthog** (live PostHog queries), **postgres** (Postgres event store via `METRICS_DATABASE_URL`), or **sqlite** (local SQLite store — the default when no PostHog keys are configured). In sqlite and postgres modes, `POST /batch/` ingest is active. See **[metrics.md](./metrics.md)**.

## C — Shipwright agent

A thin autonomous runner with a Prisma-backed store (SQLite locally, PostgreSQL in production) and four HTTP surfaces: a machine-polled **runtime API** (`/agents/:id/config`, `/agents/:id/crons`), a human-facing **admin CRUD API** (`/admin/api/agents/:id/...` for envs, crons, tools, tokens, plugins), a server-rendered **admin UI** (`/admin/...` — login, agent list/detail, Slack provisioning), and a dev-only **chat transport** (`POST /chat` — unauthenticated, gated by `SHIPWRIGHT_DEV_CHAT=true`, never active in production). See **[agent.md](./agent.md)**.

> The Dockerfile `ENTRYPOINT` is `bun run agent/src/run-agent.ts`, which composes and starts all HTTP surfaces directly. For a full startup sequence (env validation, config fetch, GitHub auth, mise, plugin install) run `agent/src/entrypoint-main.ts`, which completes setup and then spawns `run-agent.ts`. Implemented surfaces: the admin CRUD API, the admin UI, and the runtime API (all in `admin/src/` — package `@shipwright/admin`), the Prisma store (`admin/prisma/schema.prisma`), the Slack event handler (`slack.ts`), the cron runtime (`cron-handler.ts`), and the dev-only chat transport (`chat.ts`, gated by `SHIPWRIGHT_DEV_CHAT=true`).

## Supporting surfaces

| Surface | Directory | Notes |
|---|---|---|
| Marketing site | `site/` | Astro + Tailwind (**shipwright-harness.com**). **Not** a Bun workspace; Playwright smoke tests (`*.spec.ts`). |
| Brand system | `brand/` | Locked design system (`BRAND.md`, `tokens.json`) + CSS build + lint, consumed by `site/`. |
| Local state | `state/` | Git-ignored JSON task-store fallback + cached review state (only written when the GitHub backend isn't active). |

## Workspace layout

The repo is a Bun-workspaces monorepo with **go-task** (`Taskfile.yml`) as the single local entrypoint. Four workspaces — `plugins/shipwright`, `metrics`, `agent`, `admin` — are wired into the root `package.json`. The `site/` is intentionally excluded from the root `bun test` scan (its Playwright `*.spec.ts` files would crash Bun's runner).

```
shipwright/
├── plugins/shipwright/   A — the plugin (commands, skills, agents, scripts)
├── metrics/              B — provider-agnostic Hono service (sqlite default / posthog / postgres / fixtures)
├── agent/                C — Shipwright agent runtime (entrypoint, cron, Slack, GitHub auth)
├── admin/                C — Admin service: CRUD API, admin UI, Prisma store (@shipwright/admin)
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
- `CLAUDE.md` — contributor conventions and the pre-public scrub rule.
