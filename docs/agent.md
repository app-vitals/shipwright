# Shipwright Agent

> The Shipwright agent (artifact **C**) is a thin autonomous runner: pick the next ready task → build → ship a PR → forward metrics. It has a Prisma-backed store (PostgreSQL) and four HTTP surfaces — a machine-polled **runtime API**, a human-facing **admin CRUD API**, a server-rendered **admin UI**, and a public **read-only task board**.

## Overview

The agent owns sixteen first-class Prisma models (`Agent` and its `Env` / `CronJob` / `CronRun` / `Tool` / `Token` / `Plugin` / `Member` children, plus `AgentCronRunModelBreakdown` for per-model token/cost breakdown, `AgentChatTokenUsageDailyByModel` for daily token usage rollups, `AgentWorkQueueSnapshot` for the agent's latest ranked work-queue snapshot, `PushSubscription` / `ChatThreadWatch` for Web Push targeting, and `SessionFollow` / `UserNotificationPrefs` / `SessionAlertState` for user session follow preferences and notification state) on a **dedicated database** (`DATABASE_URL_SHIPWRIGHT_ADMIN`). Secrets at rest (env values, Slack/Anthropic keys) are AES-256-GCM encrypted at the service layer; agent API tokens are stored only as SHA-256 hashes.

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

> The browser-facing surfaces (admin chat UI, sessions list UI, session alert sweeper, public
> read-only task board, dev auto-login, PWA shell, and chatting with a local agent) are split
> out to [`docs/agent-web-ui.md`](./agent-web-ui.md) to keep this file under the docs
> size-governance threshold.

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
| Agents | `GET /agents/:id` (admin-only: fetches agent record, including `typeName` and `missingRequiredEnv`), `GET /agents` (admin-only: lists agents, including `typeName`), `PATCH /agents/:id` (admin-only: updates agent fields like `selfHosted` and `repos`; repos validation: each entry must be `org/repo` format; `typeName` is not updatable via this route), `POST /agents/:id/provision` (admin-only: provisions a managed agent or returns `{skipped: true, reason: "self-hosted"}` for self-hosted agents) |
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

## Data model

| Model | Owns | Notable fields |
|---|---|---|
| `Agent` | The runner identity | `name`, `slackId` (unique), `selfHosted` (boolean; when true, agent manages its own workload and skips K8s provisioning), `repos` (array of `org/repo` strings; agent's accessible repositories), `reviewAuthorAllowlist` (array of author identifiers — GitHub login strings of authors whose pull requests this agent may review; when empty, all authenticated users are allowed. Synced live via `reviewAuthorAllowlistRef` and enforced in `check-review.ts` to filter PR review candidates (AAL-2.2) — same requested-reviewer exception as the `allow_self_review` policy (RRR-1.1, extended to the allowlist by RRA-1.1): when the agent is explicitly listed as a requested reviewer on a PR, the allowlist check is bypassed for that PR too. This is a deliberate, accepted loosening of the allowlist's access boundary (confirmed with the team), not an oversight — for an already-allowlisted author the bypass has no observable effect, so its only meaningful effect is for non-allowlisted authors: any collaborator with repo write access can trigger an agent review by explicitly requesting one via GitHub's "Request a reviewer" action, even on their own PR. Managed via `POST /admin/agents/:id/review-author-allowlist/{add,delete}` UI routes; exposed on the admin API: queryable via `GET /agents/:id`, settable via `PATCH /agents/:id`. This is the sole allowlist column — the legacy `authorAllowlist` column was removed in DBR-2.4.), `patchAuthorAllowlist` (array of author identifiers — GitHub login strings of authors whose pull requests this agent will also treat as patch candidates. **DBR-1.3:** synced live via `agent/src/patch-author-allowlist-ref.ts`, mirroring `reviewAuthorAllowlistRef`. **DBR-1.4:** enforcement is active — `check-patch.ts` adds PRs authored by these logins to the patch candidate pool, merged with self-authored PRs and deduplicated by (repo, PR number). Unlike `reviewAuthorAllowlist`, this is an ADDITIVE SOURCE rather than a fail-open FILTER: an empty allowlist means self-authored-only, not "allow everyone". Independent of `reviewAuthorAllowlist`. Queryable via `GET /agents/:id`, settable via `PATCH /agents/:id`.), `restrictSlackToMembers` (boolean; when true, restricts Slack message access to only users configured in the agent's `AgentMember` rows; when false, all Slack users may message the agent; defaults to false. Synced live via `agentSlackMembershipRef` (alongside the resolved `memberEmails` array) so Slack message handlers see membership-restriction changes take effect on the very next message-handling call without agent restart — mirrors the `reviewAuthorAllowlistRef` pattern for GitHub review filtering), `typeName` (string, defaults to `"coding"`; identifies the agent's task type — read-only via the API today, not yet settable at creation), `trialExpiresAt` / `trialExpiryWarnedAt` (nullable DateTime fields; **ATE-1.1:** `trialExpiresAt` is settable via `PATCH /agents/:id`, while `trialExpiryWarnedAt` is written internally by ATE-2.1's warning check and read-only via the API), `slackBotToken` / `anthropicApiKey` (AES-256-GCM encrypted). |
| `AgentEnv` | Key/value env store | `key`, `value` (encrypted); unique per `[agentId, key]`. |
| `AgentCronJob` | Scheduled prompts | `schedule` (cron expr), `prompt`, `channel` **xor** `user`, `silent`, `enabled`, `preCheck`, `name`/`system` (system-cron key), `createdAt`, `updatedAt`, `parentCronId` (nullable, self-referential FK; a parent cron can have child "phase" crons, used for pipeline orchestration in LPC-1.2+; LPC-1.3 adds structural filtering — crons with non-null `parentCronId` are unconditionally excluded from independent scheduling, replacing the prior name-based fallback), `phases` (relation to child phase crons). |
| `AgentCronRun` | Cron execution history | `cronId` (foreign key to `AgentCronJob`), `agentId` (denormalized for queries), `startedAt`, `completedAt` (nullable), `skipped`, `skipReason` (nullable — on a `[silent]`-marker dispatch, populated from the dispatched command's own `[skip-reason:text]` marker when present (DBV-1.1, e.g. `deploy:deferred:bundle-incomplete:{HEAD_BRANCH}` from deploy.md's Step 2b bundle-completeness gate, or `patch:deferred:no-op-at-dispatch:{pr}` from patch.md's Step 3d when no patch work was found at dispatch time), falling back to the generic `"command:no-work"` literal when the command didn't tag a specific reason — see `agent/src/markers.ts` and `agent/src/loop-orchestrator.ts`), `outcome` (nullable), `error` (nullable), `itemType` (nullable, work item type this run was dispatched against: `"task"` or `"pr"`), `itemId` (nullable, work item id this run was dispatched against, e.g. `"WLS-2.2"` or `"acme/x#123"`; both null when the tick had no dispatch), `sessionId` (nullable, Claude session id this cron run corresponds to), `lastHeartbeatAt` (nullable, most recent debounced progress-push (`recordProgress()`) timestamp, sourced from the agent's injected Clock; lets the admin UI show a "last checked in" signal — and a best-effort in-progress duration — for a run that stalls or crashes before reaching `completedAt`; CRH-1.1), `phaseId` (nullable, foreign key to the specific phase cron this run was dispatched by; distinct from `cronId` which points at the orchestrator cron; used to track which phase of a parent-loop orchestration (LPC-1.1+) this run belonged to; replaces the legacy `phase` string column). Summary row for a cron execution; per-model token and cost breakdown is stored in child `AgentCronRunModelBreakdown` rows. |
| `AgentCronRunModelBreakdown` | Per-model token breakdown | Child of `AgentCronRun`; unique per `[cronRunId, model]`. Fields: `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd`. Populated when a single cron run spans multiple models — e.g., when an agent tool spawns a sub-task that uses a different model. Used by `AgentCronRunStatsService.queryByModel()` to construct accurate per-model aggregates. |
| `AgentChatTokenUsageDailyByModel` | Daily chat token rollup per agent per model | `agentId`, `date` (YYYY-MM-DD), `model` (e.g. `"claude-sonnet-4-5"`), `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd`; unique per `[agentId, date, model]`. Accumulated atomically via INSERT ... ON CONFLICT ... DO UPDATE (no read-modify-write). Totals and byAgent aggregations are computed by summing across models. |
| `AgentTool` | Allowed tool patterns | `pattern` (e.g. `Read`, `Bash`), `enabled`, `createdAt`; unique per `[agentId, pattern]`. |
| `AgentToken` | Scoped API tokens | `token` (SHA-256 hash), `label`, `revokedAt`. |
| `AgentPlugin` | Installed Claude Code plugins | `name` (package), `version` (null = latest), `enabled`, `createdAt`, `updatedAt`; unique per `[agentId, name]`. |
| `AgentMember` | Authorized human members | `id`, `agentId`, `email`, `createdAt`; unique per `[agentId, email]`. Managed by `AgentMemberService` (list by agent/email, check existence, add, remove). |
| `AgentWorkQueueSnapshot` | Latest ranked work-queue snapshot | `agentId` (unique — one row per agent), `computedAt`, `items` (JSON `RankedWorkItem[]`). Upserted by `POST /agents/:id/work-queue`; overwrites any prior snapshot — there is no history, only the latest state. |
| `PushSubscription` | Browser Web Push subscriptions (RFC 8291) | `id` (CUID), `userEmail`, `endpoint` (RFC 8291 push service endpoint, unique per user device), `p256dh` (user agent's public key, base64url), `auth` (user agent's auth secret, base64url), `detailOptIn` (user's notification detail preference: `"generic"` / `"title"` / `"preview"`, defaults to `"generic"`), `createdAt`, `updatedAt`. No agent foreign key — subscriptions are user-scoped and agent-agnostic; targeting is done via `ChatThreadWatch`. Indexed on `userEmail` for fast lookup during notification dispatch. |
| `ChatThreadWatch` | User subscription to chat thread replies | `id` (CUID), `userEmail`, `threadId`, `agentId`, `createdAt`, `updatedAt`; unique per `[userEmail, threadId]`. Upserted whenever a user sends a message (via the admin console). Enables precise notification targeting: when the agent replies, the `ChatThreadWatch` table identifies which user(s) to notify, then `PushSubscription` supplies their device endpoint(s). Indexed on `threadId` for fast lookup of all watchers when dispatching a reply notification. |
| `SessionFollow` | User session follow tracking | `id` (CUID), `userEmail`, `sessionSlug`, `muted` (boolean, defaults to false; allows a user to follow a session while suppressing alerts), `createdAt`, `updatedAt`; unique per `[userEmail, sessionSlug]`. The `muted` flag allows idempotent follow behavior — re-following a muted session un-mutes it. Deletion removes the session from the user's follow list entirely. |
| `UserNotificationPrefs` | User notification preferences | `userEmail` (primary key, one row per user), `autoFollowSessions` (boolean, defaults to true; controls whether sessions *visible to* the user — any session in an agent or repo they can see, not only ones they started — are auto-followed by the session-alert sweeper), `reminderHourLocal` (integer in [0, 23], defaults to 9; local time hour for reminder notifications), `autoFollowSince` (nullable datetime, stamped when the user explicitly turns auto-follow on; the sweeper skips auto-following sessions that were already waiting before it, so opting in doesn't backfill the pre-existing backlog — null means the user never explicitly opted in and has no boundary), `createdAt`, `updatedAt`. |
| `SessionAlertState` | Session alert cooldown tracking | `id` (CUID), `userEmail`, `sessionSlug`, `lastAlertedAt` (nullable datetime, tracks when a user was last alerted about this session), `createdAt`, `updatedAt`; unique per `[userEmail, sessionSlug]`. Used by reminder jobs to avoid re-alerting the same user/session pair within a cooldown window. |

All child models cascade-delete with their `Agent` (including `AgentCronRun` via `AgentCronJob`). `PushSubscription`, `ChatThreadWatch`, `SessionFollow`, `UserNotificationPrefs`, and `SessionAlertState` are not tied to agents and do not cascade with agent deletion.

## Key Files

Per-file reference table for `admin/src` and `agent/src` — see [agent-key-files.md](./agent-key-files.md).

## Testing

Unit + integration + smoke layers (`bun test --filter agent`). DB integration tests run against a real Postgres database (set via `DATABASE_URL_ADMIN_TEST`), provisioning the schema via `prisma migrate deploy` per suite — **no Prisma mocking**. Smoke tests drive the Hono apps via `app.request()`, except `health.smoke.test.ts` which boots the bare-`Bun.serve()` health server (`agent/src/health.ts`, no Hono app factory) and drives it via real `fetch()` to `localhost`. See [testing.md](./testing.md).

## See also

- [architecture.md](./architecture.md) — the A→B→C→D artifact design.
- [agent-web-ui.md](./agent-web-ui.md) — the agent's browser-facing surfaces: admin chat UI, sessions list UI, session alert sweeper, public task board, dev auto-login, and PWA shell.
- [agent-key-files.md](./agent-key-files.md) — per-file reference table for admin/src and agent/src.
- [agent-ops.md](./agent-ops.md) — tool management/narrowing, default system crons, environment variables, and baked marketplaces.
- `CLAUDE.md` → "Database env vars" — the per-service `DATABASE_URL_*` convention.
