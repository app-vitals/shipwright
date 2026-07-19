# Architecture

> How Shipwright Harness is structured: four sequenced artifacts (plugin → metrics → agent → task-store) plus supporting services and surfaces, all MIT, all local-first.

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

- **Commands** (`commands/`) — `prd`, `plan-session`, `dev-task`, `review`, `patch`, `deploy`, the five-phase test-readiness pipeline (`test-inventory` → `test-design` → `test-migration` → `test-roadmap` → `test-fix`), `metrics`, `research`, `research-docs`, and more.
- **Skills** (`skills/`) — autonomous behaviors including `pull-requests`, `review-staged`, `consolidation-scan`, `consolidation-fix`, `entropy-scan`, `entropy-fix`, `security-scan`, `security-fix`, `agent-admin`, `investigate-cron`, `learning-capture`, `task-store`, `test-readiness`, `test-debt`, `triage-dependabot-pr`, and `triage-dependabot-prs`.
- **Scripts** (`scripts/`) — the task-store adapters, precheck scripts for each cron (`check-docs-freshness.ts`, `check-learn-dream.ts`, etc.), and supporting tooling.
- **References** (`references/`) — schemas and recipes (`metrics-schema.md`, `task-store.md`, `doc-refresh-recipe.md`, `reviews-schema.md`, …).

`dev-task`, `review`, `patch`, and `deploy` are item-addressed executors, not self-discovering
standalone crons: each requires an explicit target (a task id for `dev-task`; an
`org/repo#number` PR for the other three) and does no candidate scanning of its own.
Candidate selection happens once, upstream, in the Shipwright agent's `shipwright-loop`
cron (artifact **C** — see [agent.md](./agent.md)), which is the sole supported driver for
these four phases; it merges candidates from `agent/src`'s per-phase qualification
functions and dispatches the winning item's command with its id/PR embedded directly in the
prompt. A human can still invoke any of the four directly with an explicit target.

The plugin is pure TypeScript with **no server, no database, and no external HTTP in production code** — only `unit` and `integration` test layers apply.

## B — Metrics dashboard

A Hono service that turns pipeline events into analytics. Two sets of read-only JSON endpoints: authenticated `/metrics/*` (summary, trends, features, queue, tokens) and unauthenticated `/public/*` (summary, trends, features, queue), plus session-gated `/dashboard` and public `/public/dashboard`. All served by a backend-agnostic `MetricsProvider` interface. The active backend is selected from env at startup: **fixtures** (offline) or **taskstore** (live task-store + admin APIs). See **[metrics.md](./metrics.md)**.

## C — Shipwright agent

A thin autonomous runner with a Prisma-backed store (PostgreSQL) and four HTTP surfaces: a machine-polled **runtime API** (`/agents/:id/config`, `/agents/:id/crons`), a human-facing **admin CRUD API** (`POST /agents` to create agents; `/agents/:id/...` for envs, crons, tools, tokens, plugins — unified surface with runtime API, separate auth), a server-rendered **admin UI** (`/admin/...` — login, agent list/detail, Slack provisioning, tasks), and a public **read-only task board** (`GET /public/tasks` — unauthenticated, scoped to a configurable repo, no mutations). See **[agent.md](./agent.md)**.

> The Dockerfile `ENTRYPOINT` is `bun run admin/src/main.ts`, the standalone admin service that runs migrations and mounts all admin + runtime routes. The agent process (`agent/src/index.ts`) wires the health server (dedicated port via `startHealthServer`), config/cron sync loops, the chat poll loop, and the Slack Bolt app. For a full agent startup sequence (env validation, config fetch, GitHub auth, mise, plugin install) run `agent/src/entrypoint-main.ts`, which starts the health server in-process before setup and then spawns `index.ts`. Implemented surfaces: the admin CRUD API, the admin UI, and the runtime API (all in `admin/src/` — package `@shipwright/admin`), the Prisma store (`admin/prisma/schema.prisma`), the Slack event handler (`slack.ts`), the cron runtime (`cron-handler.ts`), and the chat poll loop (`chat-poller.ts`, enabled by `SHIPWRIGHT_CHAT_SERVICE_URL` + `SHIPWRIGHT_CHAT_SERVICE_TOKEN`).

## D — Task store service

Postgres-backed task queue, PR tracking, and scoped tokens (`@shipwright/task-store`). The Hono app is composed from injected services by `createTaskStoreApp` (`task-store/src/app.ts`); `/health` is unauthenticated, everything else requires a bearer token.

## MCP Server

A Model Context Protocol (MCP) server that exposes a curated subset of the task-store HTTP API as discoverable MCP tools (`@shipwright/mcp-server`). Tools are generated automatically from the task-store OpenAPI specification — the `generate-mcp-tools` script (`scripts/generate-mcp-tools.ts`) reads `task-store/openapi.json` and emits tool definitions (name, description, JSON-Schema) plus routing metadata (HTTP method, path template, query/path parameters). The allowlist (`mcp-server/src/tool-allowlist.ts`) then filters the generated set down to the agreed public surface, excluding pipeline-internal lifecycle ops (claim, heartbeat, complete, fail, release), destructive ops (delete), and all token-management routes.

For the current tool-by-tool reference (name, description, HTTP method, path, parameters, body) — kept in sync automatically as tools are added or removed — see the generated **[mcp-tools.md](./mcp-tools.md)**. Regenerate it with `bun run generate:mcp-docs` after any change to the OpenAPI spec or the allowlist.

**Transport:**

The server is transport-agnostic and supports two entry points:

- **Stdio** (`mcp-server/src/serve.ts`) — launches the server over stdin/stdout, the standard transport for MCP clients like Claude Code.
- **HTTP** (`mcp-server/src/main.ts`) — serves the MCP protocol over Streamable HTTP via `Bun.serve()`. The HTTP transport is mounted on the Hono app at POST/GET/DELETE `/mcp`, supporting session-based stateful MCP (each `initialize` request generates a unique session ID; follow-up requests use the `mcp-session-id` header to route to the same transport instance). This enables remote MCP clients (e.g. Claude Desktop custom connectors, external applications) to communicate with the server without stdio.

**Tool execution:**

The server proxies tool calls to the task-store HTTP API; `SHIPWRIGHT_TASK_STORE_URL` and `SHIPWRIGHT_TASK_STORE_TOKEN` env vars are resolved at startup. Tools use bearer auth; the token is injected into all downstream requests.

**Discovery:**

The Hono app (`mcp-server/src/index.ts`) also exposes a lightweight `GET /mcp/tools` endpoint for humans to inspect the tool catalog without speaking the MCP protocol.

## Chat Service

Postgres-backed service for web chat conversations (`chat/`). Owns three Prisma models (`ChatToken`, `Thread`, `Message`) on a **dedicated database** (`DATABASE_URL_SHIPWRIGHT_CHAT`). The Hono app is composed from injected services by `createChatServiceApp` (`chat/src/app.ts`); `/health` is unauthenticated, all other routes require a valid bearer token (scoped to agents via `agentId`). Provides `/tokens/*` (admin token create/list/revoke/update), `/threads/*` (thread CRUD), and `/threads/:threadId/messages/*` (message CRUD + attachment streaming) endpoints.

**Ephemeral attachments:** Messages may carry file attachments (stored as binary `attachmentBytes` in Postgres, up to 10 MB). Attachments are **not** persisted long-term — the agent is expected to stream them via `GET /:id/attachment` (which returns the bytes and immediately clears them from the database). This pattern avoids disk bloat while supporting the agent's workflow of pulling files into its workspace. Attachment validation (size and MIME type) is performed in the admin upload route before the message reaches the chat service.

## Supporting surfaces

| Surface | Directory | Notes |
|---|---|---|
| Marketing site | `site/` | Astro + Tailwind (**shipwrightharness.com**). **Not** a Bun workspace; Playwright smoke tests (`*.spec.ts`). |
| Brand system | `brand/` | Locked design system (`BRAND.md`, `tokens.json`) + CSS build + lint, consumed by `site/`. |
| Local state | `state/` | Git-ignored JSON fallback (local-only, used when the Postgres task-store service is unavailable) + cached review state. |

## Workspace layout

The repo is a Bun-workspaces monorepo with **go-task** (`Taskfile.yml`) as the single local entrypoint. Eight workspaces — `lib`, `plugins/shipwright`, `metrics`, `agent`, `admin`, `task-store`, `chat`, `mcp-server` — are wired into the root `package.json`. The `site/` is intentionally excluded from the root `bun test` scan (its Playwright `*.spec.ts` files would crash Bun's runner).

```
shipwright/
├── lib/                  shared utilities: admin-types, org-repo, pricing, sentry, web helpers (@shipwright/lib)
├── plugins/shipwright/   A — the plugin (commands, skills, agents, scripts)
├── metrics/              B — provider-agnostic Hono service (fixtures / taskstore)
├── agent/                C — Shipwright agent runtime (entrypoint, cron, Slack, GitHub auth)
├── admin/                C — Admin service: CRUD API, admin UI, Prisma store (@shipwright/admin)
├── task-store/           D — Task queue service: Postgres + Prisma, exports @shipwright/task-store
├── mcp-server/           D — MCP server: exposes task-store API as Model Context Protocol tools (generated from OpenAPI spec)
├── chat/                 Chat service: web conversation threads, Postgres + Prisma
├── site/                 marketing site (Astro, separate toolchain)
├── brand/                locked design system
├── state/                local task-store / review-cache fallback
├── docs/                 this documentation
└── Taskfile.yml          single local entrypoint (task setup / ci / test / …)
```

## See also

- **[testing.md](./testing.md)** — the five-layer test architecture and isolation contract.
- **[metrics.md](./metrics.md)** — metrics service API and dashboard.
- **[agent.md](./agent.md)** — Shipwright agent runtime + admin APIs and data model.
- **[mcp-tools.md](./mcp-tools.md)** — generated MCP server tool reference (name, method, path, params, body).
- **[configuration.md](./configuration.md)** — all configuration options: plugin env vars, agent env vars, and policy fields.
- `CLAUDE.md` — contributor conventions and the pre-public scrub rule.
