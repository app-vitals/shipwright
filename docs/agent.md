# Shipwright Agent

> The Shipwright agent (artifact **C**) is a thin autonomous runner: pick the next ready task → build → ship a PR → forward metrics. It has a Prisma-backed store (PostgreSQL) and four HTTP surfaces — a machine-polled **runtime API**, a human-facing **admin CRUD API**, a server-rendered **admin UI**, and a public **read-only task board**.

## Overview

The agent owns eleven first-class Prisma models (`Agent` and its `Env` / `CronJob` / `CronRun` / `Tool` / `Token` / `Plugin` / `Member` children, plus `AgentCronRunModelBreakdown` for per-model token/cost breakdown, `AgentChatTokenUsageDailyByModel` for daily token usage rollups, and `AgentWorkQueueSnapshot` for the agent's latest ranked work-queue snapshot) on a **dedicated database** (`DATABASE_URL_SHIPWRIGHT_ADMIN`). Secrets at rest (env values, Slack/Anthropic keys) are AES-256-GCM encrypted at the service layer; agent API tokens are stored only as SHA-256 hashes.

> The Dockerfile `ENTRYPOINT` is `bun run admin/src/main.ts`, which runs migrations, constructs all services, and mounts all admin + runtime routes. The implemented HTTP surfaces are the admin CRUD API (`admin/src/agents-api.ts`, auth via `api-auth.ts`), the runtime API (`admin/src/api.ts`), the server-rendered admin UI (`admin/src/admin-ui.ts`), the public read-only task board (`GET /public/tasks` — no auth, configurable repo scope), the Prisma store + service classes (all in the `@shipwright/admin` package), the Slack event handler (`slack.ts`), and the cron runtime (`cron-handler.ts`). On startup the runner calls `POST /agents/:id/crons/reconcile` to sync system crons.

## Agent run modes

There are three ways to run the agent process, depending on the deployment context:

| Mode | Entry point | Transport | Entrypoint behavior | When to use |
|---|---|---|---|---|
| Pi / bare-metal | `agent/src/index.ts` | Slack Socket Mode | Runs directly on the host | Running directly on a host with a local `.env` file |
| K8s container | `agent/src/entrypoint-main.ts` | Slack Socket Mode | Dockerfile `ENTRYPOINT` is `bun run agent/src/entrypoint-main.ts`, which starts the health server in-process on `SHIPWRIGHT_HEALTH_PORT` (default `3459`) before the startup sequence so Kubernetes liveness probes are reachable during init | Deployed via the Dockerfile (validates vars, fetches config, installs plugins, spawns runner) |
| Local dev (no Slack) | `task stack` (Docker agent pane) | Chat poll loop → admin Chat UI | Runs the agent in Docker via the agent pane | Testing Claude locally without a Slack workspace — chat via the admin console's Chat tab (`/admin/chat`) |

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
| Agents | `POST /agents` (admin-only: creates an agent and seeds its AgentTool/AgentPlugin/AgentMember rows — plus `repos`, merged with any request-supplied `repos` — from the resolved Agent Type manifest (`agent-types/<type>/manifest.yaml`) at creation time; optional `type` field defaults to `"coding"`, unknown type returns `400` before any row is created; returns `{id, name, slackId, selfHosted, repos, typeName, createdAt, updatedAt, missingRequiredEnv}` with `201`), `GET /agents/:id` (admin-only: fetches agent record, including `typeName` and `missingRequiredEnv`), `GET /agents` (admin-only: lists agents, including `typeName`), `PATCH /agents/:id` (admin-only: updates agent fields like `selfHosted` and `repos`; repos validation: each entry must be `org/repo` format; `typeName` is not updatable via this route), `POST /agents/:id/provision` (admin-only: provisions a managed agent or returns `{skipped: true, reason: "self-hosted"}` for self-hosted agents) |
| Envs | `POST` / `GET` / `PATCH` `/agents/:id/envs`, `DELETE /agents/:id/envs/:key` |
| Crons | `POST` `/agents/:id/crons`, `PATCH` / `DELETE` `/agents/:id/crons/:cronId`, `POST /agents/:id/crons/reconcile`, `POST` / `GET` / `PATCH` `/agents/:id/crons/:cronId/runs/{runId}` |
| Cron Run Stats | `GET /agents/all/cron-runs/stats` (admin-only: returns aggregated token stats across all agents; query params: `from` / `to` (optional ISO datetime); returns `{totals, byAgent, byCron, byModel, byCronModel, daily, byPhase}`) |
| Reconciliation | `POST /agents/reconcile` (admin-only: reconciles K8s Deployments against all managed (non-self-hosted) agents; returns `{recreated: string[], updated: string[], orphans: string[], failed: Array<{agentId, error}>}`) |
| Tools | `POST` / `GET` `/agents/:id/tools`, `PATCH` / `DELETE` `/agents/:id/tools/:toolId` |
| Tokens | `POST` / `GET` `/agents/:id/tokens`, `DELETE /agents/:id/tokens/:tokenId` |
| Chat Tokens | `POST /agents/:id/chat-tokens/daily` (daily upsert: atomically accumulates Slack chat session token usage by `(agentId, date, model)`; body: `{date: YYYY-MM-DD, modelBreakdown: [{model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd}]}`; returns an array of updated daily rows `[{id, agentId, date, model, ...}]`), `GET /agents/chat-tokens/daily/stats` (admin-only: aggregated chat-token daily stats across all agents; query params: `from` / `to` (optional YYYY-MM-DD date strings); returns `{totals, byAgent, byModel, daily}`) |
| Plugins | `POST` / `GET` / `PATCH` `/agents/:id/plugins`, `DELETE /agents/:id/plugins` |
| Work Queue | `POST /agents/:id/work-queue` (pushes/upserts the agent's ranked work-queue snapshot, overwriting any prior snapshot; body: `{computedAt, items}`), `GET /agents/:id/work-queue` (fetches the latest snapshot; `404` if none pushed yet) |

Token creation returns the **raw token once** at creation; only its SHA-256 hash is persisted, so validation is an O(1) hash-index lookup.

### Admin chat UI (`admin-ui-pages.ts`, `http-chat-client.ts`) — authenticated

Mounted at `/admin/chat*`. **Admin-only** — requires session cookie or bearer token (same auth as admin CRUD API). When `chatClient` is present in `AdminUIDeps`, renders an agent thread browser with thread list, thread detail, and message creation. When `chatClient` is absent, all routes render in degraded mode (notice + empty state). Gracefully handles missing or unavailable chat service.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/admin/chat` | admin | List threads for a selected agent. Query params: `agentId` (optional, pre-selects an agent from the dropdown), `q` (optional, filters threads by title substring). Renders agent selector, search box, and thread list. When no agent is selected, shows empty state prompt. Returns `text/html`. |
| GET | `/admin/chat/:agentId/threads/:threadId` | admin | View a single thread with its messages. Renders thread title, thread-level aggregated token/cost stats in the header (total input/output tokens and USD cost), message history with message bubbles (role-labeled, color-coded by role, markdown-rendered for assistant messages), per-message token/cost badges on assistant messages with token data. Errored replies (where `errorKind` is set) show an error badge and, if the error is recoverable (`cancelled`, `incomplete`, or `stalled`), a Retry button that resends the original user message. When the last user message in the thread is still unreplied, renders a live status bubble (CFB-2.3, stable DOM id `live-status-bubble`) with two independently-refreshing layers: a client-side 1s elapsed ticker (`now - createdAt`, zero network dependency — the "never go silent" guarantee) and a milestone label sourced from `progressPhase` (via `PROGRESS_LABELS`, `@shipwright/lib/progress-phases`) refreshed off the existing `messages.json` poll (adaptive 2s while pending / 10s idle). If `progressSeq` hasn't advanced for `STALL_WARN_AFTER_MS` (2 min), the bubble gets a pulsing `chat-stall-indicator` warning state; `ABSOLUTE_MAX_MS` (65 min, mirroring the agent's claim-TTL) is the hard stop. Rename form, delete button, and a send form. Client-side JavaScript handles message sending, retry clicks, and polling for real-time updates (`/admin/chat/:agentId/threads/:threadId/messages.json`, which supports `?since=<messageId>` and returns server-rendered `bubbleHtml` so polled bubbles are byte-identical to reloaded ones). A sidebar pane lists all threads for the agent; on mobile (≤640px) it collapses into a CSS-only off-canvas drawer (hamburger toggle, scrim, Escape-to-close) and stats/rename/delete move out of the collapsed header. Returns `text/html`. |
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
| GET | `/public/tasks` | none | Render the public task list filtered to `SHIPWRIGHT_ADMIN_PUBLIC_REPO`. Query params: `source` (optional, filters by task source). Returns `text/html`. Mutation methods (POST/PUT/DELETE) return `404` (no routes registered). |

**Configuration:**

- `SHIPWRIGHT_ADMIN_PUBLIC_REPO` (optional) — repository slug (format: `org/repo`) scoped for the public board. When set, the board queries and displays tasks for this repo only. When unset, the board renders in degraded mode.

### Dev auto-login (`admin-ui.ts`) — local convenience

Mounted at `/admin/dev-login`. **DEFAULT-DENY:** only registered (and only returns a session) when `devAuthEnabled=true` is injected into `createAdminUIApp()`. The flag is pre-computed from `isDevAuthAllowed()` in `dev-auth-guard.ts`, which hard-blocks the route when `NODE_ENV=production` regardless of the `ADMIN_DEV_AUTH` env var. When disabled, `GET /admin/dev-login` returns `404`. When enabled, it mints an `admin_session` JWT cookie (userId `"dev"`, email `"dev@localhost"`) and redirects to `/admin/agents` — no Google OAuth required.

### PWA shell (`admin-ui.ts`, `pwa.ts`) — installable web app

The admin console is an installable Progressive Web App (PWA). All authenticated `/admin/*` pages automatically include a manifest link and a service worker registration in their `<head>` (via `renderPwaHeadTags()`, gated on `appBaseUrl` starting with `https://` — home-lab operators on plain HTTP see the PWA head tags omitted). The manifest scope is always `/admin/`. The start URL defaults to `/admin/chat` but can be customized per page — when a user triggers "Add to Home Screen," the manifest link's `href` is rewritten client-side to include `?start=<current pathname>`, so the installed shortcut launches back to the page the user was on rather than always to chat (PWA-1.1). Invalid, malicious, or non-navigable start URLs are sanitized to the default. Caching is deliberately austere: only the offline fallback page and the app icons are ever precached; no HTML documents, no JSON routes, no authenticated content. A cached page on a shared or stolen phone is a data leak, so the `shouldCachePwaRequest()` predicate and the precache list are the security boundary.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/admin/manifest.webmanifest` | none | Web app manifest (JSON). Served unauthenticated — browsers fetch it with `credentials:omit`, so authentication would silently break install. Accepts optional `?start=` query parameter to customize the manifest's start URL to the current page (PWA-1.1); malformed, malicious, or non-navigable values are rejected and the default is used. Returns the standard `WebAppManifest` object with app name, icons, scope (`/admin/`), start URL (customized per page or `/admin/chat` by default), theme/background colors synced from `brand/tokens.json`, and display mode (`standalone`). |
| GET | `/admin/sw.js` | none | Service worker JavaScript. Served unauthenticated with `Cache-Control: no-cache` (browsers must revalidate on every load so version bumps take effect). The script is generated by `buildServiceWorkerBody()` and includes the cache name (which embeds the app version), the precache list (offline page + icons), and handlers for `install`, `activate`, `fetch`, `push`, and `notificationclick` events. Fetch handler only serves cached responses for GET requests to URLs in the precache list; everything else passes through to the network. Push handler receives Web Push notifications (JSON payload with `title`, `body`, `url`) and displays them via the Notification API; notificationclick handler focuses or opens the target URL. |
| GET | `/admin/offline.html` | none | Offline fallback page (HTML). Served unauthenticated. A minimal, self-contained page (no external resources, no admin-ui-layout dependency) that renders when the network is unavailable and the user is viewing a cached document. Styled with inline CSS using design tokens from `brand/tokens.json`. |
| GET | `/admin/icons/:filename` | none | PWA icon PNG. Served unauthenticated with `Cache-Control: public, max-age=86400` (86,400 seconds = 24 hours). Filenames are validated against the hardcoded set `PWA_ICONS` (from `admin/src/pwa.ts`): `icon-192.png`, `icon-512.png` (both "any" purpose), `icon-maskable-192.png`, `icon-maskable-512.png` (masked icons confined to ~40% safe zone), `apple-touch-icon.png` (180x180, opaque background for iOS), and `favicon-32.png` (favicon-sized). Unknown filenames return `404`. Reads from the committed PNG files in `admin/pwa-assets/icons/` (populated by `scripts/build-pwa-icons.ts` one-time from the shipwright logo). |
| POST | `/admin/push/notify` | bearer token (`SHIPWRIGHT_ADMIN_PUSH_WEBHOOK_TOKEN`) | Web Push notification trigger — called by the chat service when an agent posts a reply. Request body: `{threadId, agentId, title?: string \| null, preview?: string \| null}`. Response: `{ok: true, delivered, pruned}`, where `delivered` is the count of successfully-sent pushes and `pruned` is the count of stale subscriptions removed after the push provider reported them gone (404/410). Returns `503` if Web Push is disabled (VAPID keys not configured), `SHIPWRIGHT_ADMIN_PUSH_WEBHOOK_TOKEN` is unset, or the push service is otherwise unavailable. Returns `401` if the bearer token is configured but does not match. Returns `400` if body is malformed or missing required fields. Notification content policy is governed by `SHIPWRIGHT_ADMIN_PUSH_MAX_DETAIL` (operator ceiling) and the user's subscription-level opt-in preference (effective level = min of both). |

**Configuration:**

- `SHIPWRIGHT_ADMIN_APP_BASE_URL` (required) — the full HTTPS base URL of the admin console (e.g. `https://admin.example.com`). When this does not start with `https://`, the PWA head tags are omitted from rendered pages, so install prompts and service worker registration are unavailable (home-lab operators on plain HTTP still get a fully functional admin UI, just not the PWA shell).
- **Web Push** (optional, requires all three): `SHIPWRIGHT_ADMIN_VAPID_PUBLIC_KEY`, `SHIPWRIGHT_ADMIN_VAPID_PRIVATE_KEY`, `SHIPWRIGHT_ADMIN_VAPID_SUBJECT` — enable Web Push notifications. When any is missing, the push routes degrade gracefully (push webhook returns 503, chat page renders no toggle). Also set `SHIPWRIGHT_ADMIN_PUSH_WEBHOOK_TOKEN` (the shared bearer token the chat service presents) and optionally `SHIPWRIGHT_ADMIN_PUSH_MAX_DETAIL` (operator hard ceiling on notification detail level; defaults to `"title"`). See [`configuration.md`](./configuration.md#metrics--admin--chat--task-store-services) for full details on these env vars.

### Chatting with a local agent

There is no HTTP chat endpoint on the agent. Chat flows through the chat service: the admin console's Chat tab (`/admin/chat`) posts user messages to the chat service, and the agent's chat poll loop (`chat-poller.ts`) claims them, runs them through Claude, and posts replies. `task stack` wires all of this up locally, including seeded dev tokens.

## Data model

| Model | Owns | Notable fields |
|---|---|---|
| `Agent` | The runner identity | `name`, `slackId` (unique), `selfHosted` (boolean; when true, agent manages its own workload and skips K8s provisioning), `repos` (array of `org/repo` strings; agent's accessible repositories), `reviewAuthorAllowlist` (array of author identifiers — GitHub login strings of authors whose pull requests this agent may review; when empty, all authenticated users are allowed. Synced live via `reviewAuthorAllowlistRef` and enforced in `check-review.ts` to filter PR review candidates (AAL-2.2) — same requested-reviewer exception as the `allow_self_review` policy (RRR-1.1, extended to the allowlist by RRA-1.1): when the agent is explicitly listed as a requested reviewer on a PR, the allowlist check is bypassed for that PR too. This is a deliberate, accepted loosening of the allowlist's access boundary (confirmed with the team), not an oversight — for an already-allowlisted author the bypass has no observable effect, so its only meaningful effect is for non-allowlisted authors: any collaborator with repo write access can trigger an agent review by explicitly requesting one via GitHub's "Request a reviewer" action, even on their own PR. Managed via `POST /admin/agents/:id/review-author-allowlist/{add,delete}` UI routes; exposed on the admin API: queryable via `GET /agents/:id`, settable via `PATCH /agents/:id`. This is the sole allowlist column — the legacy `authorAllowlist` column was removed in DBR-2.4.), `patchAuthorAllowlist` (array of author identifiers — GitHub login strings of authors whose pull requests this agent will also treat as patch candidates. **DBR-1.3:** synced live via `agent/src/patch-author-allowlist-ref.ts`, mirroring `reviewAuthorAllowlistRef`. **DBR-1.4:** enforcement is active — `check-patch.ts` adds PRs authored by these logins to the patch candidate pool, merged with self-authored PRs and deduplicated by (repo, PR number). Unlike `reviewAuthorAllowlist`, this is an ADDITIVE SOURCE rather than a fail-open FILTER: an empty allowlist means self-authored-only, not "allow everyone". Independent of `reviewAuthorAllowlist`. Queryable via `GET /agents/:id`, settable via `PATCH /agents/:id`.), `restrictSlackToMembers` (boolean; when true, restricts Slack message access to only users configured in the agent's `AgentMember` rows; when false, all Slack users may message the agent; defaults to false. Synced live via `agentSlackMembershipRef` (alongside the resolved `memberEmails` array) so Slack message handlers see membership-restriction changes take effect on the very next message-handling call without agent restart — mirrors the `reviewAuthorAllowlistRef` pattern for GitHub review filtering), `typeName` (string, defaults to `"coding"`; identifies the agent's task type — read-only via the API today, not yet settable at creation), `slackBotToken` / `anthropicApiKey` (AES-256-GCM encrypted). |
| `AgentEnv` | Key/value env store | `key`, `value` (encrypted); unique per `[agentId, key]`. |
| `AgentCronJob` | Scheduled prompts | `schedule` (cron expr), `prompt`, `channel` **xor** `user`, `silent`, `enabled`, `preCheck`, `name`/`system` (system-cron key), `createdAt`, `updatedAt`, `parentCronId` (nullable, self-referential FK; a parent cron can have child "phase" crons, used for pipeline orchestration in LPC-1.2+; LPC-1.3 adds structural filtering — crons with non-null `parentCronId` are unconditionally excluded from independent scheduling, replacing the prior name-based fallback), `phases` (relation to child phase crons). |
| `AgentCronRun` | Cron execution history | `cronId` (foreign key to `AgentCronJob`), `agentId` (denormalized for queries), `startedAt`, `completedAt` (nullable), `skipped`, `skipReason` (nullable — on a `[silent]`-marker dispatch, populated from the dispatched command's own `[skip-reason:text]` marker when present (DBV-1.1, e.g. `deploy:deferred:bundle-incomplete:{HEAD_BRANCH}` from deploy.md's Step 2b bundle-completeness gate, or `patch:deferred:no-op-at-dispatch:{pr}` from patch.md's Step 3d when no patch work was found at dispatch time), falling back to the generic `"command:no-work"` literal when the command didn't tag a specific reason — see `agent/src/markers.ts` and `agent/src/loop-orchestrator.ts`), `outcome` (nullable), `error` (nullable), `itemType` (nullable, work item type this run was dispatched against: `"task"` or `"pr"`), `itemId` (nullable, work item id this run was dispatched against, e.g. `"WLS-2.2"` or `"acme/x#123"`; both null when the tick had no dispatch), `sessionId` (nullable, Claude session id this cron run corresponds to), `phaseId` (nullable, foreign key to the specific phase cron this run was dispatched by; distinct from `cronId` which points at the orchestrator cron; used to track which phase of a parent-loop orchestration (LPC-1.1+) this run belonged to; replaces the legacy `phase` string column). Summary row for a cron execution; per-model token and cost breakdown is stored in child `AgentCronRunModelBreakdown` rows. |
| `AgentCronRunModelBreakdown` | Per-model token breakdown | Child of `AgentCronRun`; unique per `[cronRunId, model]`. Fields: `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd`. Populated when a single cron run spans multiple models — e.g., when an agent tool spawns a sub-task that uses a different model. Used by `AgentCronRunStatsService.queryByModel()` to construct accurate per-model aggregates. |
| `AgentChatTokenUsageDailyByModel` | Daily chat token rollup per agent per model | `agentId`, `date` (YYYY-MM-DD), `model` (e.g. `"claude-sonnet-4-5"`), `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd`; unique per `[agentId, date, model]`. Accumulated atomically via INSERT ... ON CONFLICT ... DO UPDATE (no read-modify-write). Totals and byAgent aggregations are computed by summing across models. |
| `AgentTool` | Allowed tool patterns | `pattern` (e.g. `Read`, `Bash`), `enabled`, `createdAt`; unique per `[agentId, pattern]`. |
| `AgentToken` | Scoped API tokens | `token` (SHA-256 hash), `label`, `revokedAt`. |
| `AgentPlugin` | Installed Claude Code plugins | `name` (package), `version` (null = latest), `enabled`, `createdAt`, `updatedAt`; unique per `[agentId, name]`. |
| `AgentMember` | Authorized human members | `id`, `agentId`, `email`, `createdAt`; unique per `[agentId, email]`. Managed by `AgentMemberService` (list by agent/email, check existence, add, remove). |
| `AgentWorkQueueSnapshot` | Latest ranked work-queue snapshot | `agentId` (unique — one row per agent), `computedAt`, `items` (JSON `RankedWorkItem[]`). Upserted by `POST /agents/:id/work-queue`; overwrites any prior snapshot — there is no history, only the latest state. |
| `PushSubscription` | Browser Web Push subscriptions (RFC 8291) | `id` (CUID), `userEmail`, `endpoint` (RFC 8291 push service endpoint, unique per user device), `p256dh` (user agent's public key, base64url), `auth` (user agent's auth secret, base64url), `detailOptIn` (user's notification detail preference: `"generic"` / `"title"` / `"preview"`, defaults to `"generic"`), `createdAt`, `updatedAt`. No agent foreign key — subscriptions are user-scoped and agent-agnostic; targeting is done via `ChatThreadWatch`. Indexed on `userEmail` for fast lookup during notification dispatch. |
| `ChatThreadWatch` | User subscription to chat thread replies | `id` (CUID), `userEmail`, `threadId`, `agentId`, `createdAt`, `updatedAt`; unique per `[userEmail, threadId]`. Upserted whenever a user sends a message (via the admin console). Enables precise notification targeting: when the agent replies, the `ChatThreadWatch` table identifies which user(s) to notify, then `PushSubscription` supplies their device endpoint(s). Indexed on `threadId` for fast lookup of all watchers when dispatching a reply notification. |

All child models cascade-delete with their `Agent` (including `AgentCronRun` via `AgentCronJob`). `PushSubscription` and `ChatThreadWatch` are not tied to agents and do not cascade with agent deletion.

## Key Files

Per-file reference table for `admin/src` and `agent/src` — see [agent-key-files.md](./agent-key-files.md).

## Testing

Unit + integration + smoke layers (`bun test --filter agent`). DB integration tests run against a real Postgres database (set via `DATABASE_URL_ADMIN_TEST`), provisioning the schema via `prisma migrate deploy` per suite — **no Prisma mocking**. Smoke tests drive the Hono apps via `app.request()`, except `health.smoke.test.ts` which boots the bare-`Bun.serve()` health server (`agent/src/health.ts`, no Hono app factory) and drives it via real `fetch()` to `localhost`. See [testing.md](./testing.md).

## See also

- [architecture.md](./architecture.md) — the A→B→C→D artifact design.
- [agent-key-files.md](./agent-key-files.md) — per-file reference table for admin/src and agent/src.
- [agent-ops.md](./agent-ops.md) — tool management/narrowing, default system crons, environment variables, and baked marketplaces.
- `CLAUDE.md` → "Database env vars" — the per-service `DATABASE_URL_*` convention.
