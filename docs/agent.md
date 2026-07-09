# Shipwright Agent

> The Shipwright agent (artifact **C**) is a thin autonomous runner: pick the next ready task → build → ship a PR → forward metrics. It has a Prisma-backed store (PostgreSQL) and four HTTP surfaces — a machine-polled **runtime API**, a human-facing **admin CRUD API**, a server-rendered **admin UI**, and a public **read-only task board**.

## Overview

The agent owns ten first-class Prisma models (`Agent` and its `Env` / `CronJob` / `CronRun` / `Tool` / `Token` / `Plugin` / `Member` children, plus `AgentCronRunModelBreakdown` for per-model token/cost breakdown and `AgentChatTokenUsageDailyByModel` for daily token usage rollups) on a **dedicated database** (`DATABASE_URL_SHIPWRIGHT_ADMIN`). Secrets at rest (env values, Slack/Anthropic keys) are AES-256-GCM encrypted at the service layer; agent API tokens are stored only as SHA-256 hashes.

> The Dockerfile `ENTRYPOINT` is `bun run admin/src/main.ts`, which runs migrations, constructs all services, and mounts all admin + runtime routes. The implemented HTTP surfaces are the admin CRUD API (`admin/src/agents-api.ts`, auth via `api-auth.ts`), the runtime API (`admin/src/api.ts`), the server-rendered admin UI (`admin/src/admin-ui.ts`), the public read-only task board (`GET /public/tasks` — no auth, configurable repo scope), the Prisma store + service classes (all in the `@shipwright/admin` package), the Slack event handler (`slack.ts`), and the cron runtime (`cron-handler.ts`). On startup the runner calls `POST /agents/:id/crons/reconcile` to sync system crons.

## Agent run modes

There are three ways to run the agent process, depending on the deployment context:

| Mode | Entry point | Transport | Use when |
|---|---|---|---|
| Pi / bare-metal | `agent/src/index.ts` | Slack Socket Mode | Running directly on a host with a local `.env` file |
| K8s container | `agent/src/entrypoint-main.ts` | Slack Socket Mode | Deployed via the Dockerfile — validates required vars, fetches config from the admin API, applies env, symlinks `~/.claude`, sets up GitHub auth, runs mise, installs plugins, then spawns `index.ts` |
| Local dev (no Slack) | `task stack` (Docker agent pane) | Chat poll loop → admin Chat UI | Testing Claude locally without a Slack workspace — chat via the admin console's Chat tab (`/admin/chat`) |

`agent/src/index.ts` is the production agent entrypoint in all transport modes — it wires the health server, config sync loop, cron sync loop, chat poll loop, Slack Bolt app, and graceful shutdown.

## Running locally

```bash
export DATABASE_URL_SHIPWRIGHT_ADMIN="postgresql://user:password@localhost:5432/shipwright_admin"

task db:provision          # prisma migrate deploy (idempotent)
task db:migrate            # prisma migrate dev (create a new migration)
```

The schema uses `provider = "postgresql"`. `DATABASE_URL_SHIPWRIGHT_ADMIN` must be a Postgres connection string. Never point this at a shared database.

## HTTP surfaces

### Runtime API (`api.ts`) — machine-polled

Mounted at `/agents/*`. The harness polls this every ~60s. Auth: same admin-key / per-agent-token / session-cookie middleware as the CRUD routes (admin key, per-agent bearer token, or session JWT).

| Method | Path | Description |
|---|---|---|
| GET | `/agents/:id/config` | Agent config bundle: decrypted `env`, `allowedTools`, and installed `plugins` (with derived marketplace). `404` if the agent doesn't exist. |
| GET | `/agents/:id/crons` | Enabled cron jobs for the agent. `404` if the agent doesn't exist. |

### Admin CRUD API (`agents-api.ts`) — human-facing

Mounted at `/agents/*` (unified with the runtime API surface). Auth: **admin key** (`SHIPWRIGHT_ADMIN_API_KEYS` env key with scope `*` → bypasses all checks, sets `isAdmin=true`; scope `<agentId>` → enforces route agentId, sets `isAdmin=false`) **or** a valid **per-agent bearer token** (DB token scoped to its own `:id`, sets `isAdmin=false`) **or** **session cookie** `admin_session` (httpOnly JWT verified with `SHIPWRIGHT_SESSION_SECRET`, sets `isAdmin=true`). Admin key checked first, then DB token path, then cookie. If an `Authorization` header is present but the token is invalid in all paths, the request is rejected immediately (401) — it does not fall through to the cookie path. Absent auth → `401`. Per-agent bearer tokens are scoped to their own `:id` — cross-agent access returns `403`. Routes that require admin access (e.g. agent creation) check `c.get("isAdmin")` and return `403` for scoped bearer tokens.

| Resource | Endpoints |
|---|---|
| Agents | `POST /agents` (admin-only: creates agent, returns `{id, name, slackId, selfHosted, repos, createdAt, updatedAt}` with `201`), `GET /agents/:id` (admin-only: fetches agent record), `GET /agents` (admin-only: lists agents), `PATCH /agents/:id` (admin-only: updates agent fields like `selfHosted` and `repos`; repos validation: each entry must be `org/repo` format), `POST /agents/:id/provision` (admin-only: provisions a managed agent or returns `{skipped: true, reason: "self-hosted"}` for self-hosted agents) |
| Envs | `POST` / `GET` / `PATCH` `/agents/:id/envs`, `DELETE /agents/:id/envs/:key` |
| Crons | `POST` `/agents/:id/crons`, `PATCH` / `DELETE` `/agents/:id/crons/:cronId`, `POST /agents/:id/crons/reconcile`, `POST` / `GET` / `PATCH` `/agents/:id/crons/:cronId/runs/{runId}` |
| Cron Run Stats | `GET /agents/all/cron-runs/stats` (admin-only: returns aggregated token stats across all agents; query params: `from` / `to` (optional ISO datetime); returns `{totals, byAgent, byCron, byModel, byCronModel, daily, byPhase}`) |
| Reconciliation | `POST /agents/reconcile` (admin-only: reconciles K8s Deployments against all managed (non-self-hosted) agents; returns `{recreated: string[], updated: string[], orphans: string[], failed: Array<{agentId, error}>}`) |
| Tools | `POST` / `GET` `/agents/:id/tools`, `PATCH` / `DELETE` `/agents/:id/tools/:toolId` |
| Tokens | `POST` / `GET` `/agents/:id/tokens`, `DELETE /agents/:id/tokens/:tokenId` |
| Chat Tokens | `POST /agents/:id/chat-tokens/daily` (daily upsert: atomically accumulates Slack chat session token usage by `(agentId, date, model)`; body: `{date: YYYY-MM-DD, modelBreakdown: [{model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd}]}`; returns an array of updated daily rows `[{id, agentId, date, model, ...}]`), `GET /agents/chat-tokens/daily/stats` (admin-only: aggregated chat-token daily stats across all agents; query params: `from` / `to` (optional YYYY-MM-DD date strings); returns `{totals, byAgent, byModel, daily}`) |
| Plugins | `POST` / `GET` / `PATCH` `/agents/:id/plugins`, `DELETE /agents/:id/plugins` |

Token creation returns the **raw token once** at creation; only its SHA-256 hash is persisted, so validation is an O(1) hash-index lookup.

### Admin chat UI (`admin-ui-pages.ts`, `http-chat-client.ts`) — authenticated

Mounted at `/admin/chat*`. **Admin-only** — requires session cookie or bearer token (same auth as admin CRUD API). When `chatClient` is present in `AdminUIDeps`, renders an agent thread browser with thread list, thread detail, and message creation. When `chatClient` is absent, all routes render in degraded mode (notice + empty state). Gracefully handles missing or unavailable chat service.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/admin/chat` | admin | List threads for a selected agent. Query params: `agentId` (optional, pre-selects an agent from the dropdown), `q` (optional, filters threads by title substring). Renders agent selector, search box, and thread list. When no agent is selected, shows empty state prompt. Returns `text/html`. |
| GET | `/admin/chat/:agentId/threads/:threadId` | admin | View a single thread with its messages. Renders thread title, thread-level aggregated token/cost stats in the header (total input/output tokens and USD cost), message history with message bubbles (role-labeled, color-coded by role, markdown-rendered for assistant messages), per-message token/cost badges on assistant messages with token data, rename form, delete button, and a send form. Client-side JavaScript handles message sending and polling for real-time updates (`/admin/chat/:agentId/threads/:threadId/messages.json`). A sidebar pane lists all threads for the agent. Returns `text/html`. |
| POST | `/admin/chat/:agentId/threads` | admin | Create a new thread for an agent. Body: form-encoded `title` (optional string). On success, redirects to the thread detail page (302). On chat-service error, redirects back to the agent's thread list (302). |
| POST | `/admin/chat/:agentId/threads/:threadId/rename` | admin | Rename a thread. Body: form-encoded `title` (required string; empty title is a no-op redirect). On success or error, redirects back to the thread detail page (302). |
| POST | `/admin/chat/:agentId/threads/:threadId/delete` | admin | Delete a thread. On success or error, redirects to the agent's thread list (302). Errors are silently swallowed (UX: no error banner). |
| GET | `/admin/chat/:agentId/threads/:threadId/messages.json` | admin | JSON API: list messages in a thread for client-side polling. Returns `{ messages: ChatMessage[] }` (200) or `{ messages: [] }` (200 when chat service absent/unavailable). |
| POST | `/admin/chat/:agentId/threads/:threadId/messages/upload` | admin | JSON API: add a message with optional file attachment. Body: `multipart/form-data` with `body` (optional string) and `file` (optional file). Validates attachment size (≤10 MB) and MIME type (images, PDFs, JSON, text, SVG). Returns `{ message: ChatMessage }` (201) on success; on validation error returns `{ error: string }` (400/413/415). Enables client-side send + file upload + optimistic UI + polling loop. |
| POST | `/admin/chat/:agentId/threads/:threadId/messages` | admin | Form POST: add a message (with optional attachment). Body: `multipart/form-data` with `body` (optional string), `role` (optional, defaults to "user"), and `file` (optional file). Validates attachment size and MIME type. Redirects on success or failure (no JSON). Legacy form-based endpoint; the `/upload` route is preferred for client-side UX. |
| GET | `/admin/chat/:agentId/threads/:threadId/messages/:id/attachment` | admin | Stream an ephemeral file attachment. No auth after message existence check. Returns the file bytes with `Content-Disposition: attachment`. **Drops the stored bytes immediately after serving** — attachments are not retained long-term; the agent is expected to pull them into its workspace via this endpoint. Returns `404` if message not found or has no attachment. |

**Degraded mode:** When `chatClient` is not configured (env var unset or connection fails), all chat routes render a notice (`SHIPWRIGHT_CHAT_SERVICE_URL` and `SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN` required) and no table/messages. The routes remain accessible and return `200` — callers are not redirected or rejected.

**Configuration:**

- `SHIPWRIGHT_CHAT_SERVICE_URL` (optional) — base URL of the chat service (e.g. `http://chat:3000`). Required alongside `SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN` for the admin UI to access threads and messages.
- `SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN` (optional) — bearer token for admin-side chat service access. Required alongside `SHIPWRIGHT_CHAT_SERVICE_URL`. Used to list/fetch threads and messages (read operations).

### Public read-only task board (`admin-ui.ts`) — unauthenticated

Mounted at `/public/tasks`. **No authentication required** — renders a read-only task list scoped to a configurable repository. When `SHIPWRIGHT_ADMIN_PUBLIC_REPO` is set, fetches tasks for that repo from the task-store and displays them in a static HTML page with no mutation controls (create/edit/status-change disabled). When the config is absent or task-store access fails, the page renders in degraded mode (empty table + warning notice). The endpoint is always registered and always accessible; it gracefully degrades when prerequisites are missing.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/public/tasks` | none | Render the public task list filtered to `SHIPWRIGHT_ADMIN_PUBLIC_REPO`. Query params: none. Returns `text/html`. Mutation methods (POST/PUT/DELETE) return `404` (no routes registered). |

**Configuration:**

- `SHIPWRIGHT_ADMIN_PUBLIC_REPO` (optional) — repository slug (format: `org/repo`) scoped for the public board. When set, the board queries and displays tasks for this repo only. When unset, the board renders in degraded mode.

### Dev auto-login (`admin-ui.ts`) — local convenience

Mounted at `/admin/dev-login`. **DEFAULT-DENY:** only registered (and only returns a session) when `devAuthEnabled=true` is injected into `createAdminUIApp()`. The flag is pre-computed from `isDevAuthAllowed()` in `dev-auth-guard.ts`, which hard-blocks the route when `NODE_ENV=production` regardless of the `ADMIN_DEV_AUTH` env var. When disabled, `GET /admin/dev-login` returns `404`. When enabled, it mints an `admin_session` JWT cookie (userId `"dev"`, email `"dev@localhost"`) and redirects to `/admin/agents` — no Google OAuth required.

### Chatting with a local agent

There is no HTTP chat endpoint on the agent. Chat flows through the chat service: the admin console's Chat tab (`/admin/chat`) posts user messages to the chat service, and the agent's chat poll loop (`chat-poller.ts`) claims them, runs them through Claude, and posts replies. `task stack` wires all of this up locally, including seeded dev tokens.

## Data model

| Model | Owns | Notable fields |
|---|---|---|
| `Agent` | The runner identity | `name`, `slackId` (unique), `selfHosted` (boolean; when true, agent manages its own workload and skips K8s provisioning), `repos` (array of `org/repo` strings; agent's accessible repositories), `slackBotToken` / `anthropicApiKey` (AES-256-GCM encrypted). |
| `AgentEnv` | Key/value env store | `key`, `value` (encrypted); unique per `[agentId, key]`. |
| `AgentCronJob` | Scheduled prompts | `schedule` (cron expr), `prompt`, `channel` **xor** `user`, `silent`, `enabled`, `preCheck`, `name`/`system` (system-cron key). |
| `AgentCronRun` | Cron execution history | `cronId` (foreign key to `AgentCronJob`), `agentId` (denormalized for queries), `startedAt`, `completedAt` (nullable), `skipped`, `skipReason` (nullable), `outcome` (nullable), `error` (nullable), `phase` (nullable, pipeline phase this run served: `"dev-task"`, `"review"`, `"patch"`, `"deploy"`; null for legacy five-job crons). Summary row for a cron execution; per-model token and cost breakdown is stored in child `AgentCronRunModelBreakdown` rows. |
| `AgentCronRunModelBreakdown` | Per-model token breakdown | Child of `AgentCronRun`; unique per `[cronRunId, model]`. Fields: `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd`. Populated when a single cron run spans multiple models — e.g., when an agent tool spawns a sub-task that uses a different model. Used by `AgentCronRunStatsService.queryByModel()` to construct accurate per-model aggregates. |
| `AgentChatTokenUsageDailyByModel` | Daily chat token rollup per agent per model | `agentId`, `date` (YYYY-MM-DD), `model` (e.g. `"claude-sonnet-4-5"`), `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd`; unique per `[agentId, date, model]`. Accumulated atomically via INSERT ... ON CONFLICT ... DO UPDATE (no read-modify-write). Totals and byAgent aggregations are computed by summing across models. |
| `AgentTool` | Allowed tool patterns | `pattern` (e.g. `Read`, `Bash`), `enabled`; unique per `[agentId, pattern]`. |
| `AgentToken` | Scoped API tokens | `token` (SHA-256 hash), `label`, `revokedAt`. |
| `AgentPlugin` | Installed Claude Code plugins | `name` (package), `version` (null = latest), `enabled`; unique per `[agentId, name]`. |
| `AgentMember` | Authorized human members | `email`; unique per `[agentId, email]`. |

All child models cascade-delete with their `Agent` (including `AgentCronRun` via `AgentCronJob`).

## Default system crons

Every new agent is seeded with eleven system crons (the canonical definitions live in [`admin/src/system-crons.ts`](../admin/src/system-crons.ts) and are reconciled onto each agent at startup via `POST /agents/:id/crons/reconcile`). Two are **enabled by default**; the rest are opt-in (toggle in the admin UI or via `PATCH /agents/:id/crons/:cronId`). All run `silent` (they post to Slack only on a result worth surfacing, or on error), and most carry a `preCheck` script whose stdout becomes the actual prompt — so a cron only spends a Claude turn when there is real work ready.

| Cron | Schedule (cron expr) | Default | What it does |
|---|---|---|---|
| `shipwright-dev-task` | `0,30 * * * *` (min 0, 30) | **on** | Picks the next ready task, builds it with tests, opens a PR. |
| `shipwright-review-patch` | `10,40 * * * *` (min 10, 40) | **on** | Reviews open PRs (excluding drafts and Dependabot PRs) and patches the ones failing CI or review. |
| `shipwright-review` | `15,45 * * * *` (min 15, 45) | off | Review-only pass over open PRs (excluding drafts and Dependabot PRs). |
| `shipwright-patch` | `5,35 * * * *` (min 5, 35) | off | Fixes failing CI and unresolved review findings. |
| `shipwright-deploy` | `20,50 * * * *` (min 20, 50) | off | Merges approved PRs and deploys them. |
| `shipwright-loop` | `* * * * *` (every minute) | off | Internal: dispatches enabled pipeline phases (dev-task, review, patch, deploy) in a single multi-step drain-until-dry run. Orchestrates phase toggling and claim/retry logic; requires explicit enablement alongside per-phase cron toggling. Placeholder implementation — full orchestration is pending WL-3.3. |
| `shipwright-test-readiness` | `0 6 * * *` (daily, 06:00) | off | Runs the full test-readiness audit (`--full --publish`). |
| `shipwright-docs-freshness` | `0 7 * * *` (daily, 07:00) | off | Refreshes docs that drifted from the code (`research-docs --auto`). |
| `learn-dream` | `0 3 * * *` (daily, 03:00) | off | Mines the last day of merged PRs for durable learnings. |
| `dependabot-triage` | `0 8 * * *` (daily, 08:00) | off | Reviews and triages open Dependabot PRs. |
| `entropy-patrol-maintenance` | `0 4 * * 1` (weekly, Mon 04:00) | off | Scans for code entropy and fixes what's PR-worthy. |

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL_SHIPWRIGHT_ADMIN` | ✅ | Dedicated Postgres datasource for the admin service (e.g. `postgresql://user:pass@host:5432/db`). |
| `SHIPWRIGHT_AGENT_ID` | ✅ (entrypoint) | The agent's ID in the Shipwright platform. Also settable via `--agent-id` CLI flag. |
| `SHIPWRIGHT_API_URL` | ✅ (entrypoint) | Base URL of the Shipwright API used to fetch agent config at startup. Also settable via `--api-url`. |
| `SHIPWRIGHT_AGENT_API_KEY` | ✅ (entrypoint) | Bearer token for the config fetch at startup (`/agents/:id/config` and `/agents/:id/crons`). Also settable via `--api-key`. The value must be registered in `SHIPWRIGHT_ADMIN_API_KEYS` on the server with scope `<agentId>` (or `*` for admin bypass) — an agent key not listed there will receive a 401 at startup. |
| `AGENT_HOME` | entrypoint | Persistent storage root (default: `/data/agent-home`). Mount a PVC here in Kubernetes so mise caches, workspace files, and `~/.claude` survive pod restarts. |
| `PORT` | server | Port for the admin service (`admin/src/main.ts`). Default: `3000`. |
| `SHIPWRIGHT_HEALTH_PORT` | server | Dedicated health server port for K8s liveness probes (default: `3459`). Started in-process by `entrypoint-main.ts` before startup. |
| `SHIPWRIGHT_SESSION_SECRET` | admin API | Secret for verifying the `admin_session` JWT cookie. |
| `SHIPWRIGHT_ADMIN_API_KEYS` | admin API | Comma-separated `name:token:scope` tuples for env-based bearer auth on `/agents/*`. Scope `*` → admin (bypasses per-agent checks); scope `<agentId>` → restricted to that agent's routes. Optional — absent means env key auth is disabled and only DB tokens and session cookies are accepted. Example: `bodhi:sk_bodhi_abc:*,svc:sk_svc_xyz:agent-id-123`. |
| `GOOGLE_CLIENT_ID` | admin UI (OAuth) | Google OAuth 2.0 client ID. Required for the admin login flow. |
| `GOOGLE_CLIENT_SECRET` | admin UI (OAuth) | Google OAuth 2.0 client secret. Required for the admin login flow. |
| `SHIPWRIGHT_ADMIN_ALLOWED_EMAILS` | admin UI (OAuth) | Comma-separated list of Google email addresses permitted to log in to the admin UI. |
| `SHIPWRIGHT_ADMIN_APP_BASE_URL` | admin UI (OAuth) | Public base URL of the server (e.g. `https://shipwright.example.com`). Used to construct the OAuth redirect URI. Defaults to `http://localhost:{PORT}`. |
| `SHIPWRIGHT_ENCRYPTION_KEY` | secrets at rest | 64-char hex (32 bytes) for AES-256-GCM. **If unset, secrets are stored in plain text** (logged warning) — set it in any real deployment. |
| `GH_APP_ID` | GitHub App auth | GitHub App ID (integer as string). Required when using the App auth path. |
| `GH_APP_PRIVATE_KEY` | GitHub App auth | PEM private key for the GitHub App (newlines may be `\n`-escaped). Required when using the App auth path. |
| `GH_APP_INSTALLATION_ID` | GitHub App auth | Installation ID for the target org/repo. Required when using the App auth path. |
| `GH_TOKEN` | GitHub PAT auth | Personal Access Token for the legacy `gh auth setup-git` path. Used only if the App env vars are absent. |
| `ADMIN_DEV_AUTH` | dev only | Set to `"true"` to enable `GET /admin/dev-login` (bypasses Google OAuth, mints a dev session). Hard-blocked when `NODE_ENV=production` by `dev-auth-guard.ts`. |

## Baked marketplaces (derived images)

A derived Docker image can ship additional Claude Code plugin marketplaces that are automatically registered at agent boot — no env var, no DB entry required. Marketplace availability is an **image property**; plugin selection remains in the AgentPlugin table as usual.

**Convention root:** `/opt/shipwright/marketplaces/`

Place one subdirectory per marketplace under the convention root. Each subdirectory must contain `.claude-plugin/marketplace.json` (the standard marketplace manifest). The harness calls `claude plugin marketplace add <dir>` for every discovered directory **before** registering the built-in shipwright marketplace, so derived-image plugins resolve correctly.

```
/opt/shipwright/marketplaces/
  my-org-plugins/
    .claude-plugin/
      marketplace.json   ← required; triggers discovery
      plugin.json        ← optional plugin metadata
    plugins/
      ...
```

Directories that do not contain `.claude-plugin/marketplace.json` are silently skipped. The registration call is idempotent and non-fatal — a missing directory or a non-zero exit from `claude` is logged as a warning and startup continues.

The constant `BAKED_MARKETPLACES_ROOT` and function `discoverBakedMarketplaces()` in `agent/src/setup.ts` implement this behavior.

## Key Files

| File | Purpose |
|---|---|
| `admin/src/main.ts` | Standalone admin service entrypoint — runs `prisma migrate deploy`, constructs all services, and mounts health + runtime API + admin CRUD API + admin UI. Dockerfile `ENTRYPOINT`. Exports helper functions `runMigrations()`, `buildProvisioner()`, and `resolveTaskStoreBaseUrl()` to enable unit testing of env-driven configuration logic in isolation from `Bun.serve()` and real Prisma connections; the full `startServer()` integration is exercised via deployed environments and service integration tests. |
| `admin/src/api.ts` | Runtime API factory `createAgentRuntimeApp()` (OpenAPIHono app with OAS 2.1 route definitions; DI for services). |
| `admin/src/agents-api.ts` | Admin CRUD factory `createAdminApp()`. |
| `admin/src/api-auth.ts` | Combined admin auth middleware (`createAdminAuthMiddleware()`) and env-key parser (`parseAdminApiKeys()`) — bearer check order: env API keys (scope enforcement), then DB token via `agentTokenService`; bearer path does not fall through to session cookie on failure. |
| `admin/src/openapi-schemas.ts` | Zod schemas for the admin and runtime APIs — entity types (Agent, AgentCronJob, AgentTool, AgentToken, AgentPlugin), request bodies, runtime response shapes (AgentConfigResponse, RuntimeError), and common error shapes (Error, Ok). Imported by route migrations (OAS-2.1, OAS-2.2); `z` imported from `@hono/zod-openapi` for `.openapi()` metadata support. |
| `admin/src/admin-ui.ts` | Admin UI factory `createAdminUIApp()` — server-rendered Hono app (login, agent list/detail, Slack provisioning, tasks, chat threads) with POST mutation routes for repos (add/delete), cron jobs, tools, tokens (create/toggle/delete/revoke), tasks (release), threads, and messages (including multipart file uploads). Includes `POST /admin/agents` (admin-only: creates self-hosted agent), `GET /admin/agents/new` (admin-only: new local agent form). Message routes: `POST .../messages/upload` (multipart form; body + optional file; validates attachment size ≤10 MB and MIME type; returns JSON for client-side error handling) and `POST .../messages` (legacy form POST; redirects on completion). Cron job display includes execution history (last run timestamp, outcome, today's run count). Accepts `devAuthEnabled`, `fetchTaskStoreTasks`, `releaseTask`, `taskStoreBaseUrl`, `taskStoreProvisioningClient`, `chatClient` in `AdminUIDeps`; when `devAuthEnabled=true`, registers `GET /admin/dev-login` (dev auto-login). When `fetchTaskStoreTasks` is provided, `GET /admin/tasks` queries tasks; without it, the page renders in degraded mode. When `taskStoreBaseUrl` is provided, the token creation success banner renders a copy-paste env block with `SHIPWRIGHT_TASK_STORE_URL` and `SHIPWRIGHT_TASK_STORE_TOKEN`. When `taskStoreProvisioningClient` is provided, the Slack wizard provisioning route (`POST /admin/provision/xapp-token`) mints a per-agent task-store token during agent setup, mirroring the K8s provisioning path. When `chatClient` is provided, `GET /admin/chat*` routes access threads and messages; without it, chat routes render in degraded mode. Each cron row links to a per-cron run log via `GET /admin/agents/:id/crons/:cronId/runs`, which lists recent executions (outcome, start time, duration, token usage, per-model cost breakdown) sourced from `agentCronRunService.list()`. |
| `admin/src/dev-auth-guard.ts` | `isDevAuthAllowed(env)` — pure predicate over an injected env object (`DevAuthGuardEnv`). Returns `true` only when `ADMIN_DEV_AUTH=true` and `NODE_ENV !== "production"`. Mirrors the `chat-guard.ts` safety pattern. |
| `admin/src/admin-ui-pages.ts` | Page rendering functions (`renderLoginPage`, `renderAgentsPage`, `renderNewLocalAgentPage`, `renderAgentDetailPage`, `renderProvision*`, `renderTasksPage`, `renderPrsPage`, `renderPrDetailPage`, `renderTokensPage`, `renderCronRunsPage`, `renderChatPage`, `renderChatThreadPage`). `renderCronRunsPage` renders the per-cron run log (outcome badge, start time, duration, token usage, cost, per-model cost breakdown) and shares the cron-outcome styling helper with the agent detail page's cron rows. `renderChatPage` renders the thread browser (agent selector, search box, thread list with ID/title/created/view link; gracefully degrades when chat service absent). `renderChatThreadPage` renders a thread detail page with a scrollable message area, sidebar thread list pane, rename form, delete button, and floating send form. Messages render as styled bubbles: user messages on the right with indigo background, assistant messages on the left with green background and markdown support (bold text, inline code), system messages centered with yellow background, and error states (when `errorKind` is set) with red error badges (rate-limited, timeout, upstream). Assistant messages with token data display per-message token/cost badges showing input tokens, output tokens, and USD cost. Thread-level aggregated stats (total input/output tokens and total cost) render in the thread header. Attachment metadata is shown as an inline badge (📎 filename) when a message carries an attachment (read-only display; no re-download — attachments are ephemeral and dropped after the agent fetches them). The reply form includes an "Attach file" button that opens a file picker (accepts images, PDFs, JSON, text files, and SVG); selected files display a filename preview below the input. Client-side JavaScript handles form submission (multipart upload via the `/messages/upload` endpoint), optimistic message bubble insertion, a "thinking…" indicator during polling, and server polling (3-second intervals, 90-second timeout). Accepts `threads: ChatThread[] | null` and optional `stats?: ThreadStats | null` for thread-level stats. Gracefully degrades when chat service absent. Exports `AgentDetail` interface (agent detail with `selfHosted` boolean flag), `TaskItem` interface for typing tasks displayed on the admin UI, `PrListItem` interface for PR data displayed on PR list/detail pages, `CronRunItem` interface for cron run rows on the run-log page, and `AgentOption` interface (for the agent selector dropdown). `renderTokensPage` accepts optional `agents` (agent list for the create-token dropdown), `selectedAgentId` (pre-selects an agent), and `taskStoreBaseUrl` (renders env block in success banner). |
| `admin/src/http-chat-client.ts` | Typed HTTP client for admin-side chat service access. Exports `ChatClient` interface (for DI), `HttpChatClient` (production implementation using global fetch), `NoopChatClient` (no-op fallback), type definitions (`ChatThread`, `ChatMessage` with optional `errorKind` and `attachmentFilename`/`attachmentSize` fields; `tokens` field holds a `MessageTokens` object with `input_tokens`, `output_tokens`, and optional cache breakdown fields (or null); `costUsd` field for per-message USD cost; `MessageTokens` interface for token usage by model and cache type; `ThreadStats` interface with `messageCount`, `totalInputTokens`, `totalOutputTokens`, and `totalCostUsd` for thread-level aggregations; `MessageAttachment` for file uploads; `ListThreadsResult`, `ListMessagesResult`, `CreateThreadOptions`, `UpdateThreadOptions`), and list option interfaces. `ChatClient` interface includes `getThreadStats(threadId): Promise<ThreadStats>` to fetch aggregated token/cost stats for a thread. `createMessage()` accepts an optional `attachment` parameter (object with `filename`, `size`, `bytes`). Used by the `/admin/chat*` routes to list threads, fetch threads and messages, create/update/delete threads, create messages, fetch thread stats, and upload file attachments. Smoke tests mock at the `ChatClient` interface level. |
| `admin/src/admin-ui-styles.ts` | Shared CSS helpers (`baseStyles`, `escapeHtml`, `renderAdminToolbar`). |
| `admin/src/google-auth-client.ts` | `GoogleAuthClient` interface + `HttpGoogleAuthClient` — typed Google OAuth2 token exchange and user profile lookup; injected into the admin UI for testability. |
| `admin/src/slack-provisioning-client.ts` | `SlackProvisioningClient` interface + `HttpSlackProvisioningClient` — drives Slack app management (creation, deletion, OAuth flow). `createAppManifest()` returns `appId`, `oauthRedirectUrl`, `clientId`, `clientSecret`, and `signingSecret` from the `apps.manifest.create` response. `deleteApp(xoxpToken, appId)` calls `apps.manifest.delete` to permanently delete a provisioned Slack app. `exchangeOAuthCode()` exchanges the Slack OAuth callback code for a bot token via `oauth.v2.access`. Also exports `buildAgentManifest(appName, redirectUri?)` — constructs per-agent Slack app manifests via the Manifest API shape — and `AGENT_BOT_SCOPES` — the canonical bot scope list used by both provisioning and sync-manifest OAuth flows. |
| `admin/src/task-store-provisioning-client.ts` | `TaskStoreProvisioningClient` interface + `HttpTaskStoreProvisioningClient` + `NoopTaskStoreProvisioningClient` — mints/revokes per-agent task-store API tokens during agent provisioning. HTTP implementation calls task-store `POST /tokens` and `DELETE /tokens/:id` with admin auth; noop returns empty strings when provisioning is disabled. Integrated into two provisioning paths: (1) `KubernetesAgentProvisioner`: when `config.taskStore` is set, `provision()` mints a token, stores it in the agent Secret (key `task-store-token`), and injects it into the Deployment; on rollback, revokes the token. (2) Slack wizard provisioning (`admin-ui.ts` → `POST /admin/provision/xapp-token`): when `taskStoreProvisioningClient` is injected into `AdminUIDeps`, mints a token during agent setup (idempotent, gated on existing `SHIPWRIGHT_TASK_STORE_TOKEN` env check), and patches it into the agent's env alongside `SHIPWRIGHT_TASK_STORE_URL`. |
| `admin/src/chat-service-provisioning-client.ts` | `ChatServiceProvisioningClient` interface + `HttpChatServiceProvisioningClient` + `NoopChatServiceProvisioningClient` — mints/revokes per-agent chat-service API tokens during agent provisioning. HTTP implementation calls chat-service `POST /tokens` and `DELETE /tokens/:id` with admin auth; noop returns empty strings when provisioning is disabled. Integrated into `KubernetesAgentProvisioner`: when `config.chatService` is set, `provision()` mints a token (labeled `agent:<agentId>`, optionally tagged with `agentId`), stores it in the agent Secret (key `chat-service-token`), and injects it into the Deployment; on rollback, revokes the token. |
| `admin/src/attachment-validation.ts` | Pure, side-effect-free attachment validation (`validateAttachment()`) — checks file size (max 10 MB), MIME type (allowlist: images, PDFs, JSON, text, SVG), and filename. Returns a discriminated result: on failure carries a clear error message and HTTP status (413 too-large, 415 unsupported-type); on success carries validated filename and size. Used by the message upload endpoint (`/admin/chat/.../messages/upload`) to reject invalid files before they reach the chat service. Exports constants: `MAX_ATTACHMENT_BYTES`, `ALLOWED_MIME_PREFIXES`, `ALLOWED_MIME_EXACT`. Unit-tested with both boundary and disallowed-type cases. |
| `admin/src/agent-provisioner.ts` | `AgentProvisioner` interface + `KubernetesAgentProvisioner` (real K8s provisioning via `HttpKubernetesClient`) + `NoopAgentProvisioner` (DB-only). K8s provisioner creates per-agent PVC (persistent home directory), Secret (credentials), and Deployment (agent container). Calls `agent-manifest.ts` to build Deployment specs. On `provision()`: creates PVC + PersistentVolumeClaim → mints Secret with agent token + optional task-store token + optional chat-service token → builds and creates Deployment; on failure, rolls back Secret (best-effort) and revokes task-store and chat-service tokens. On `deprovision()`: deletes Deployment, Secret, and PVC (a deliberate full agent deletion also removes storage so deleted agents do not leak indefinitely). Reconciles orphaned K8s resources via `reconcile()`. |
| `admin/src/agent-manifest.ts` | Pure Kubernetes manifest builders: `buildAgentDeploymentManifest()` (Deployment spec), `buildAgentPvcManifest()` (PersistentVolumeClaim), `buildAgentSecretManifest()` (Secret). Injects env vars for agent identity, voice (when enabled), task-store (when `taskStoreUrl` is set), and chat-service (when `chatServiceUrl` is set) into the Deployment. Internal helpers `taskStoreEnvEntries()` and `chatServiceEnvEntries()` build the task-store env pairs (`SHIPWRIGHT_TASK_STORE_TOKEN` from Secret, `SHIPWRIGHT_TASK_STORE_URL` as a plain value) and chat-service env pairs (`SHIPWRIGHT_CHAT_SERVICE_TOKEN` from Secret, `SHIPWRIGHT_CHAT_SERVICE_URL` as a plain value), positioned after task-store vars and before voice vars. |
| `admin/src/agent-envs.ts` | Env service — encrypted key/value store + config bundle assembly. |
| `admin/src/agent-cron-jobs.ts` | Cron service + system-cron reconciliation. Provides `list()` for basic cron jobs and `listWithRunSummary()` for crons enriched with execution history (last run time/outcome, today's run count). |
| `admin/src/agent-tools.ts` | Tool service — manages allowed tool patterns per agent. |
| `admin/src/agent-tokens.ts` | Token service — manages scoped API tokens per agent (raw token returned once at creation; only SHA-256 hash persisted). |
| `admin/src/agent-plugins.ts` | Plugin service — manages installed Claude Code plugins per agent. Exports `AgentPluginService` with methods `add(agentId, name, version?)` (upserts a plugin, re-enabling if previously removed), `list(agentId)` (returns all plugins ordered by createdAt), `remove(agentId, pluginId)` (deletes by ID, throws `NotFoundError` if not found or belongs to different agent), and `removeByName(agentId, name)` (deletes by name). Throws `NotFoundError` when the plugin doesn't exist or belongs to a different agent. Covered by integration tests via a real Postgres DB. |
| `agent/src/index.ts` | Production agent startup entrypoint — boots in sequence: console monkeypatch (via `buildLogPrefix()`, tags logs with agent ID when set) + Sentry init (no-op when `SENTRY_DSN` unset) → agent home + mise + plugins → config sync (60s) → reconcileSystemCrons → health server (injected with optional `sentryClient`) → cron sync loop (60s) → chat poll loop (5s, when `SHIPWRIGHT_CHAT_SERVICE_URL` and `SHIPWRIGHT_CHAT_SERVICE_TOKEN` are configured) → Slack Bolt Socket Mode app (wired with `HttpChatTokenReporter` when `SHIPWRIGHT_API_URL`, `SHIPWRIGHT_AGENT_API_KEY`, and `SHIPWRIGHT_AGENT_ID` are configured; `NoopChatTokenReporter` otherwise) → graceful SIGTERM/SIGINT shutdown. |
| `agent/src/entrypoint-main.ts` | Production CLI entry point — wires real deps and calls `runEntrypoint()`. Starts the health server in-process on `SHIPWRIGHT_HEALTH_PORT` (default `3459`) before the startup sequence so K8s liveness probes are reachable during init, then runs the full startup sequence and spawns `index.ts`. |
| `agent/src/entrypoint.ts` | Container startup sequence (`runEntrypoint()`) — dependency-injected for testability. Validates vars, fetches config, applies env, symlinks `~/.claude`, runs GitHub auth + mise + plugin install, then spawns the server. |
| `agent/src/cli-args.ts` | CLI argument parsing (`parseCliArgs()`) — `--agent-id`, `--api-url`, `--api-key` flags with env var fallbacks. Pure, no I/O. |
| `agent/src/chat-poller.ts` | Chat poll loop: `createChatPoller(opts)` — polls the chat service for pending messages, claims and runs them through Claude with per-thread session continuity, and posts replies. Exports `ChatPoller` (interface with `start()`, `stop()`, `pollOnce()`), `ChatRunner` (message handler), and `ChatPollerOptions` (config with optional `workspaceDir` for attachment handling). Session persistence is handled internally by the injected `ChatRunner` (a `createRunClaude` instance wired to a dedicated `chatSessions` store) — `ChatPollerOptions` does not expose a `sessions` field. When `workspaceDir` is set and a claimed message carries an attachment, the poller calls `client.getAttachment()` to fetch the ephemeral bytes, writes them to `<workspaceDir>/uploads/{messageId}-{filename}`, and injects a note into the Claude prompt. Integrates with `HttpChatServiceClient` to claim messages, fetch attachments, and reply. Started in Step 6b of agent startup when `SHIPWRIGHT_CHAT_SERVICE_URL` and `SHIPWRIGHT_CHAT_SERVICE_TOKEN` are configured. |
| `agent/src/http-chat-service-client.ts` | Typed HTTP client for the Shipwright chat service REST API. Exports `ChatServiceClient` (interface for DI), `HttpChatServiceClient` (production implementation with injectable `fetchFn`), `ChatServiceClientError` (typed error with `statusCode`), and type definitions (`Thread`, `Message` with optional `attachmentFilename`, `ReplyResult`, `ListThreadsOptions`, `ListThreadsResult`). `ChatServiceClient` interface exposes `getAttachment(threadId, messageId): Promise<Uint8Array | null>` to stream an ephemeral file attachment (404 if not found or already dropped). Used by `createChatPoller()` to list threads, claim messages, fetch attachments, and post replies. |
| `agent/src/setup.ts` | Workspace bootstrapping — directory scaffolding, identity-file seeding, plugin installation, and mise startup. Safe to call on every agent startup (idempotent). |
| `admin/src/crypto.ts` / `token-crypto.ts` | AES-256-GCM + token hashing helpers. |
| `admin/src/system-crons.ts` | System-cron definitions reconciled onto each agent. |
| `agent/src/github-app-auth.ts` | `GitHubTokenManager` — installation-token cache + proactive 30-min background refresh; `getBotIdentity()` and `fetchBotIdentity()` for git author config and bot identity resolution (testable with injected `fetchFn`). |
| `agent/src/github-token-store.ts` | Atomic file-based token store (`writeToken` / `readToken` / `resolveTokenPath`) used by the credential helper. |
| `agent/src/setup-github-auth.ts` | `setupGitHubAuth()` — wires GitHub auth on agent startup: App path (token manager + credential helper + git identity) or PAT path (`gh auth setup-git`). |
| `agent/scripts/bin/git-credential-shipwright.sh` | Git credential helper that reads the token file written by the App auth path. |
| `agent/src/shipwright-config-client.ts` | `ShipwrightConfigClient` (DI interface) + `RecordedShipwrightConfigClient` (cassette-backed test double). The HTTP implementation was consolidated into `HttpShipwrightRuntimeClient` (`shipwright-runtime-client.ts`) — wire that via `getAgentConfigBundle()` as the `configClient` adapter in `entrypoint-main.ts`. |
| `agent/src/shipwright-runtime-client.ts` | Unified runtime client for the three agent-facing Shipwright API methods. Exports `ShipwrightClientError` (typed error with `statusCode`), `ShipwrightRuntimeClient` (DI interface: `getAgentConfigBundle()`, `listAgentCronJobs()`, `reconcileSystemCrons()`), and `HttpShipwrightRuntimeClient` (typed HTTP implementation via `openapi-fetch`). |
| `agent/src/cron-handler.ts` | Cron runtime: `handleCronRequest()` — runs a cron prompt through Claude and posts the result to Slack. Supports `preCheck` scripts, `silent` suppression, channel vs. DM delivery, and `onPost`/`onSession` callbacks. Fire-and-forget reporting via `CronRunReporter` (when configured) using a two-step interface: `createRun()` at start (POST), `completeRun()` / `skipRun()` at completion (PATCH). |
| `agent/src/loop-cron-classifier.ts` | Pure cron dispatch helpers (zero I/O, mirrors `work-selector.ts` pattern): `classifyCronJobsForScheduling(jobs)` → `ScheduledCronJob[]` (decides which jobs get an independent node-cron schedule and with which `dispatch` kind: `"loop"` for the shipwright-loop job, or `"generic"` for standalone crons); when shipwright-loop is enabled, pipeline phase jobs (dev-task, review, patch, review-patch, deploy) are loop-config-only and excluded from independent scheduling; `resolveLoopPhaseToggles(jobs)` → `LoopPhaseToggles` (resolver for the loop orchestrator's phase-enable flags — looks up dev-task, review, patch, deploy by job name, ignores review-patch); `handleLoopCronRequest(jobs)` → placeholder handler (logs current toggles, full drain-until-dry orchestration is WL-3.3). Exports types `CronJobLike` (minimal job view, decoupled from Prisma), `CronDispatchKind` (dispatch classification), `ScheduledCronJob<T>` (job+dispatch pair), `LoopPhaseToggles` (four-phase toggle state). Unit-testable; used by `agent/src/index.ts` cron-sync loop to classify and schedule jobs. |
| `agent/src/cron-run-reporter.ts` | Cron run reporter: `CronRunReporter` interface with three methods (`createRun()`, `completeRun()`, `skipRun()`) + `HttpCronRunReporter` (sends requests to the admin API) and `NoopCronRunReporter` (test/default no-op). Injected into `handleCronRequest()`; `createRun()` is called at run start and returns a `runId`, then `completeRun()` or `skipRun()` is called at completion with token usage, cost, outcome metadata, and optional per-model breakdown (`modelBreakdown?: ModelBreakdownEntry[]` — array of `{model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd?}`). Breakdown data is upserted into `AgentCronRunModelBreakdown` and used by stats queries to compute accurate per-model token aggregates. |
| `agent/src/chat-token-reporter.ts` | Chat token reporter: `ChatTokenReporter` interface (async `recordSession(usage?, totalCostUsd?, modelUsage?)` method, where `modelUsage` is `Record<string, ModelUsageEntry>` with camelCase fields per the Claude CLI's `modelUsage` map) + `HttpChatTokenReporter` (POSTs per-session Slack chat token usage to `POST /agents/:id/chat-tokens/daily`) and `NoopChatTokenReporter` (test/default no-op). Injected into Slack event handler; called at each Slack session completion (DM, mention, reaction) to report token usage broken down by model: accumulated input/output/cache token counts per model and total USD cost (pre-computed by the Claude CLI). Helper `formatDailyDate(date, timeZone?)` formats dates as YYYY-MM-DD in a given IANA timezone (agent timezone when unspecified). Fire-and-forget design: swallows POST errors as warnings to `console`. |
| `agent/src/slack.ts` | Slack event handler: `createSlackApp()` — Bolt-based Socket Mode app handling DMs, `app_mention`, `reaction_added`, file attachments, and voice transcription. Processes response markers (`[silent]`, `[upload:path]`, `[speak:text]`, `[react:emoji]`, `[plan:url]`) via `dispatchMarkers()` — strips them from the posted message and executes side effects (uploads, emoji reactions, speech synthesis, plan links). Accepts injected `ChatTokenReporter` (default `NoopChatTokenReporter`) and calls it at session completion. |
| `agent/src/health.ts` | Health server: `startHealthServer(port, summarize?, cronDeps?, clock?, graceMs?, sentryClient?)` — K8s liveness probe server. `GET /health` returns `{ ok: true, slack: "connected"\|"disconnected" }` (200) or `{ ok: false, slack: "disconnected" }` (500) when the Slack socket has been continuously down longer than `graceMs` (default 90 s). `GET /stats` returns an `AnalyticsSummary` when a `summarize` function is injected (404 otherwise). `POST /cron` dispatches cron prompts via `cron-handler.ts`; when `sentryClient` is injected, unhandled cron handler errors are captured via `Sentry.captureException()` before the 500 response (ValidationError is not captured — it's an expected typed outcome). Exports `slackState`, `markSlackConnected()`, and `markSlackDisconnected(clock)` for Slack socket lifecycle wiring. |
| `agent/src/log-prefix.ts` | Console log prefix builder: `buildLogPrefix(agentId, timestamp)` — constructs log prefixes for console output. When `agentId` is set/non-empty, returns `[timestamp] [agent:agentId]`; when unset/empty, returns `[timestamp]` only. Used by the `index.ts` console monkeypatch to tag logs with the agent ID for attribution in multi-agent aggregated log views. Unit-tested for edge cases (undefined, empty string, normal ID). |
| `admin/prisma/schema.prisma` | The ten-model schema (`DATABASE_URL_SHIPWRIGHT_ADMIN`). |

## Testing

Unit + integration + smoke layers (`bun test --filter agent`). DB integration tests run against a real Postgres database (set via `DATABASE_URL_ADMIN_TEST`), provisioning the schema via `prisma migrate deploy` per suite — **no Prisma mocking**. Smoke tests drive the Hono apps via `app.request()`. See [testing.md](./testing.md).

## See also

- [architecture.md](./architecture.md) — the A→B→C→D artifact design.
- `CLAUDE.md` → "Database env vars" — the per-service `DATABASE_URL_*` convention.
