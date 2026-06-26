# Shipwright Agent

> The Shipwright agent (artifact **C**) is a thin autonomous runner: pick the next ready task → build → ship a PR → forward metrics. It has a Prisma-backed store (PostgreSQL) and three HTTP surfaces — a machine-polled **runtime API**, a human-facing **admin CRUD API**, and a server-rendered **admin UI**.

## Overview

The agent owns eight first-class Prisma models (`Agent` and its `Env` / `CronJob` / `CronRun` / `Tool` / `Token` / `Plugin` / `Member` children) on a **dedicated database** (`DATABASE_URL_SHIPWRIGHT_ADMIN`). Secrets at rest (env values, Slack/Anthropic keys) are AES-256-GCM encrypted at the service layer; agent API tokens are stored only as SHA-256 hashes.

> The Dockerfile `ENTRYPOINT` is `bun run admin/src/main.ts`, which runs migrations, constructs all services, and mounts all admin + runtime routes. The implemented HTTP surfaces are the admin CRUD API (`admin/src/agents-api.ts`, auth via `api-auth.ts`), the runtime API (`admin/src/api.ts`), the server-rendered admin UI (`admin/src/admin-ui.ts`), the Prisma store + service classes (all in the `@shipwright/admin` package), the Slack event handler (`slack.ts`), and the cron runtime (`cron-handler.ts`). On startup the runner calls `POST /agents/:id/crons/reconcile` to sync system crons. A dev-only `POST /chat` transport (`chat.ts`) is available when `SHIPWRIGHT_DEV_CHAT=true`; it is never registered in production (enforced by `chat-guard.ts`).

## Agent run modes

There are three ways to run the agent process, depending on the deployment context:

| Mode | Entry point | Transport | Use when |
|---|---|---|---|
| Pi / bare-metal | `agent/src/index.ts` | Slack Socket Mode | Running directly on a host with a local `.env` file |
| K8s container | `agent/src/entrypoint-main.ts` | Slack Socket Mode | Deployed via the Dockerfile — validates required vars, fetches config from the admin API, applies env, symlinks `~/.claude`, sets up GitHub auth, runs mise, installs plugins, then spawns `index.ts` |
| Local dev (no Slack) | `agent/scripts/run-agent.ts --agent-id <id>` | HTTP `POST /chat` | Testing Claude locally without a Slack workspace; requires `SHIPWRIGHT_DEV_CHAT=true` |

`agent/src/index.ts` is the production agent entrypoint in all transport modes — it wires the health server, config sync loop, cron sync loop, Slack Bolt app, and graceful shutdown. `agent/src/run-agent.ts` is the minimal dev-only HTTP server; it is not used in production.

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
| Reconciliation | `POST /agents/reconcile` (admin-only: reconciles K8s Deployments against all managed (non-self-hosted) agents; returns `{recreated: string[], updated: string[], orphans: string[], failed: Array<{agentId, error}>}`) |
| Tools | `POST` / `GET` `/agents/:id/tools`, `PATCH` / `DELETE` `/agents/:id/tools/:toolId` |
| Tokens | `POST` / `GET` `/agents/:id/tokens`, `DELETE /agents/:id/tokens/:tokenId` |
| Plugins | `POST` / `GET` / `PATCH` `/agents/:id/plugins`, `DELETE /agents/:id/plugins` |

Token creation returns the **raw token once** at creation; only its SHA-256 hash is persisted, so validation is an O(1) hash-index lookup.

### Dev auto-login (`admin-ui.ts`) — local convenience

Mounted at `/admin/dev-login`. **DEFAULT-DENY:** only registered (and only returns a session) when `devAuthEnabled=true` is injected into `createAdminUIApp()`. The flag is pre-computed from `isDevAuthAllowed()` in `dev-auth-guard.ts`, which hard-blocks the route when `NODE_ENV=production` regardless of the `ADMIN_DEV_AUTH` env var. When disabled, `GET /admin/dev-login` returns `404`. When enabled, it mints an `admin_session` JWT cookie (userId `"dev"`, email `"dev@localhost"`) and redirects to `/admin/agents` — no Google OAuth required.

### Dev chat transport (`chat.ts`) — local convenience

Mounted at `/chat`. **DEFAULT-DENY:** only registered when `SHIPWRIGHT_DEV_CHAT=true` at server startup. When the env var is absent or false, `POST /chat` returns `404`. This endpoint is **unauthenticated** and must never be enabled in production — `chat-guard.ts` enforces this by exiting with an error if `SHIPWRIGHT_DEV_CHAT=true` and `NODE_ENV=production`.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/chat` | none | Send a message to the Claude runner. Body: `{ message: string, session?: string }`. Returns `{ result: string, sessionId?: string }`. Successive calls with the same `session` resume the same conversation. |

**TUI client (`scripts/chat.ts`):** A terminal REPL that drives this endpoint. Start the agent with `SHIPWRIGHT_DEV_CHAT=true`, then in a second terminal:

```bash
bun scripts/chat.ts
# or point at a non-default port:
AGENT_URL=http://localhost:3000 bun scripts/chat.ts
```

Each REPL session generates a single `session` UUID so successive messages resume the same Claude conversation. Ctrl-D exits cleanly.

## Data model

| Model | Owns | Notable fields |
|---|---|---|
| `Agent` | The runner identity | `name`, `slackId` (unique), `selfHosted` (boolean; when true, agent manages its own workload and skips K8s provisioning), `repos` (array of `org/repo` strings; agent's accessible repositories), `slackBotToken` / `anthropicApiKey` (AES-256-GCM encrypted). |
| `AgentEnv` | Key/value env store | `key`, `value` (encrypted); unique per `[agentId, key]`. |
| `AgentCronJob` | Scheduled prompts | `schedule` (cron expr), `prompt`, `channel` **xor** `user`, `silent`, `enabled`, `preCheck`, `name`/`system` (system-cron key). |
| `AgentCronRun` | Cron execution history | `cronId` (foreign key to `AgentCronJob`), `agentId` (denormalized for queries), `startedAt`, `completedAt` (nullable), `skipped`, `skipReason` (nullable), `outcome` (nullable), `error` (nullable), `inputTokens` (nullable), `outputTokens` (nullable), `cacheReadTokens` (nullable), `cacheCreationTokens` (nullable), `costUsd` (nullable), `model` (nullable). |
| `AgentTool` | Allowed tool patterns | `pattern` (e.g. `Read`, `Bash`), `enabled`; unique per `[agentId, pattern]`. |
| `AgentToken` | Scoped API tokens | `token` (SHA-256 hash), `label`, `revokedAt`. |
| `AgentPlugin` | Installed Claude Code plugins | `name` (package), `version` (null = latest), `enabled`; unique per `[agentId, name]`. |
| `AgentMember` | Authorized human members | `email`; unique per `[agentId, email]`. |

All child models cascade-delete with their `Agent` (including `AgentCronRun` via `AgentCronJob`).

## Default system crons

Every new agent is seeded with ten system crons (the canonical definitions live in [`admin/src/system-crons.ts`](../admin/src/system-crons.ts) and are reconciled onto each agent at startup via `POST /agents/:id/crons/reconcile`). Two are **enabled by default**; the rest are opt-in (toggle in the admin UI or via `PATCH /agents/:id/crons/:cronId`). All run `silent` (they post to Slack only on a result worth surfacing, or on error), and most carry a `preCheck` script whose stdout becomes the actual prompt — so a cron only spends a Claude turn when there is real work ready.

| Cron | Schedule (cron expr) | Default | What it does |
|---|---|---|---|
| `shipwright-dev-task` | `*/30 * * * *` (every 30 min) | **on** | Picks the next ready task, builds it with tests, opens a PR. |
| `shipwright-review-patch` | `*/30 * * * *` (every 30 min) | **on** | Reviews open PRs and patches the ones failing CI or review. |
| `shipwright-review` | `*/30 * * * *` (every 30 min) | off | Review-only pass over open PRs. |
| `shipwright-patch` | `*/30 * * * *` (every 30 min) | off | Fixes failing CI and unresolved review findings. |
| `shipwright-deploy` | `*/30 * * * *` (every 30 min) | off | Merges approved PRs and deploys them. |
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
| `AGENT_HOME` | entrypoint | Persistent storage root (default: `~/.shipwright-agent`). Mount a PVC here in Kubernetes so mise caches, workspace files, and `~/.claude` survive pod restarts. |
| `PORT` | server | Chat server port (default: `3000`). Only used when `SHIPWRIGHT_DEV_CHAT=true`; also the port for the admin service (`admin/src/main.ts`). |
| `SHIPWRIGHT_HEALTH_PORT` | server | Dedicated health server port for K8s liveness probes (default: `3459`). Used by both `entrypoint-main.ts` (in-process, before startup) and `run-agent.ts` (started by `startServer()`). |
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
| `SHIPWRIGHT_DEV_CHAT` | dev only | Set to `"true"` to enable the unauthenticated `POST /chat` endpoint (local dev convenience). Must **not** be set in production (`NODE_ENV=production`). |
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
| `admin/src/main.ts` | Standalone admin service entrypoint — runs `prisma migrate deploy`, constructs all services, and mounts health + runtime API + admin CRUD API + admin UI. Dockerfile `ENTRYPOINT`. |
| `admin/src/api.ts` | Runtime API factory `createAgentRuntimeApp()` (OpenAPIHono app with OAS 2.1 route definitions; DI for services). |
| `admin/src/agents-api.ts` | Admin CRUD factory `createAdminApp()`. |
| `admin/src/api-auth.ts` | Combined admin auth middleware (`createAdminAuthMiddleware()`) and env-key parser (`parseAdminApiKeys()`) — bearer check order: env API keys (scope enforcement), then DB token via `agentTokenService`; bearer path does not fall through to session cookie on failure. |
| `admin/src/openapi-schemas.ts` | Zod schemas for the admin and runtime APIs — entity types (Agent, AgentCronJob, AgentTool, AgentToken, AgentPlugin), request bodies, runtime response shapes (AgentConfigResponse, RuntimeError), and common error shapes (Error, Ok). Imported by route migrations (OAS-2.1, OAS-2.2); `z` imported from `@hono/zod-openapi` for `.openapi()` metadata support. |
| `admin/src/admin-ui.ts` | Admin UI factory `createAdminUIApp()` — server-rendered Hono app (login, agent list/detail, Slack provisioning, tasks) with POST mutation routes for repos (add/delete), cron jobs, tools, tokens (create/toggle/delete/revoke), and tasks (release). Cron job display includes execution history (last run timestamp, outcome, today's run count). Accepts `devAuthEnabled`, `fetchTaskStoreTasks`, `releaseTask`, `taskStoreBaseUrl` in `AdminUIDeps`; when `devAuthEnabled=true`, registers `GET /admin/dev-login` (dev auto-login). When `fetchTaskStoreTasks` is provided, `GET /admin/tasks` queries tasks; without it, the page renders in degraded mode. When `taskStoreBaseUrl` is provided, the token creation success banner renders a copy-paste env block with `SHIPWRIGHT_TASK_STORE_URL` and `SHIPWRIGHT_TASK_STORE_TOKEN`. |
| `admin/src/dev-auth-guard.ts` | `isDevAuthAllowed(env)` — pure predicate over an injected env object (`DevAuthGuardEnv`). Returns `true` only when `ADMIN_DEV_AUTH=true` and `NODE_ENV !== "production"`. Mirrors the `chat-guard.ts` safety pattern. |
| `admin/src/admin-ui-pages.ts` | Page rendering functions (`renderLoginPage`, `renderAgentsPage`, `renderAgentDetailPage`, `renderProvision*`, `renderTasksPage`, `renderPrsPage`, `renderPrDetailPage`, `renderTokensPage`). Exports `AgentDetail` interface (agent detail with `selfHosted` boolean flag), `TaskItem` interface for typing tasks displayed on the admin UI, and `PrListItem` interface for PR data displayed on PR list/detail pages. `renderTokensPage` accepts optional `agents` (agent list for the create-token dropdown), `selectedAgentId` (pre-selects an agent), and `taskStoreBaseUrl` (renders env block in success banner). |
| `admin/src/admin-ui-styles.ts` | Shared CSS helpers (`baseStyles`, `escapeHtml`, `renderAdminToolbar`). |
| `admin/src/google-auth-client.ts` | `GoogleAuthClient` interface + `HttpGoogleAuthClient` — typed Google OAuth2 token exchange and user profile lookup; injected into the admin UI for testability. |
| `admin/src/slack-provisioning-client.ts` | `SlackProvisioningClient` interface + `HttpSlackProvisioningClient` — drives the one-time Slack app creation and OAuth flow. `createAppManifest()` returns `appId`, `oauthRedirectUrl`, `clientId`, `clientSecret`, and `signingSecret` from the `apps.manifest.create` response. `exchangeOAuthCode()` exchanges the Slack OAuth callback code for a bot token via `oauth.v2.access`. Also exports `buildAgentManifest(appName, redirectUri?)` — constructs per-agent Slack app manifests via the Manifest API shape — and `AGENT_BOT_SCOPES` — the canonical bot scope list used by both provisioning and sync-manifest OAuth flows. |
| `admin/src/task-store-provisioning-client.ts` | `TaskStoreProvisioningClient` interface + `HttpTaskStoreProvisioningClient` + `NoopTaskStoreProvisioningClient` — mints/revokes per-agent task-store API tokens during agent provisioning. HTTP implementation calls task-store `POST /tokens` and `DELETE /tokens/:id` with admin auth; noop returns empty strings when provisioning is disabled. Integrated into `KubernetesAgentProvisioner`: when `config.taskStore` is set, `provision()` mints a token, stores it in the agent Secret (key `task-store-token`), and injects it into the Deployment; on rollback, revokes the token. |
| `admin/src/agent-provisioner.ts` | `AgentProvisioner` interface + `KubernetesAgentProvisioner` (real K8s provisioning via `HttpKubernetesClient`) + `NoopAgentProvisioner` (DB-only). K8s provisioner creates per-agent PVC (persistent home directory), Secret (credentials), and Deployment (agent container). Calls `agent-manifest.ts` to build Deployment specs. On `provision()`: creates PVC + PersistentVolumeClaim → mints Secret with agent token + optional task-store token → builds and creates Deployment; on failure, rolls back Secret (best-effort) and revokes task-store token. On `deprovision()`: deletes Deployment and Secret (PVC retained for data safety). Reconciles orphaned K8s resources via `reconcile()`. |
| `admin/src/agent-manifest.ts` | Pure Kubernetes manifest builders: `buildAgentDeploymentManifest()` (Deployment spec), `buildAgentPvcManifest()` (PersistentVolumeClaim), `buildAgentSecretManifest()` (Secret). Injects env vars for agent identity, voice (when enabled), and task-store (when `taskStoreUrl` is set) into the Deployment. Exports `taskStoreEnvEntries()` to build task-store env pairs (`SHIPWRIGHT_TASK_STORE_TOKEN` from Secret, `SHIPWRIGHT_TASK_STORE_URL` as a plain value), positioned after `AGENT_HOME` and before voice vars. |
| `admin/src/agent-envs.ts` | Env service — encrypted key/value store + config bundle assembly. |
| `admin/src/agent-cron-jobs.ts` | Cron service + system-cron reconciliation. Provides `list()` for basic cron jobs and `listWithRunSummary()` for crons enriched with execution history (last run time/outcome, today's run count). |
| `admin/src/agent-tools.ts` / `agent-tokens.ts` / `agent-plugins.ts` | Per-resource service classes. |
| `agent/src/index.ts` | Production agent startup entrypoint — boots in seven steps: agent home + mise + plugins → config sync (60s) → reconcileSystemCrons → health server → cron sync loop (60s) → Slack Bolt Socket Mode app → graceful SIGTERM/SIGINT shutdown. |
| `agent/src/entrypoint-main.ts` | Production CLI entry point — wires real deps and calls `runEntrypoint()`. Starts the health server in-process on `SHIPWRIGHT_HEALTH_PORT` (default `3459`) before the startup sequence so K8s liveness probes are reachable during init, then runs the full startup sequence and spawns `run-agent.ts`. |
| `agent/src/entrypoint.ts` | Container startup sequence (`runEntrypoint()`) — dependency-injected for testability. Validates vars, fetches config, applies env, symlinks `~/.claude`, runs GitHub auth + mise + plugin install, then spawns the server. |
| `agent/src/cli-args.ts` | CLI argument parsing (`parseCliArgs()`) — `--agent-id`, `--api-url`, `--api-key` flags with env var fallbacks. Pure, no I/O. |
| `agent/src/run-agent.ts` | Minimal agent server — dev `/chat` transport only (UNI-1.3: health check and `/agents/*` proxy were removed). `createComposedApp(deps: ComposedAppDeps)` accepts optional `devChat` / `chatRunner` deps to register `POST /chat` (DEFAULT-DENY). `startServer()` starts the dedicated health server on `SHIPWRIGHT_HEALTH_PORT` (default `3459`) and, when `SHIPWRIGHT_DEV_CHAT=true`, binds the chat server on `PORT` (default `3000`). |
| `agent/src/chat.ts` | Dev-only chat transport: `createChatApp(deps)` — thin Hono sub-app exposing `POST /chat`. Maps opaque caller `session` keys to internal runner session keys for conversation continuity. |
| `agent/src/chat-guard.ts` | Doctor/CI guard: `devChatGuardViolation(env)` — pure predicate that returns a violation reason string when `SHIPWRIGHT_DEV_CHAT=true` and `NODE_ENV=production`, otherwise `null`. Executable as a CLI script. |
| `agent/src/shipwright-config-client.ts` | `ShipwrightConfigClient` interface + `HttpShipwrightConfigClient` (real HTTP) + `RecordedShipwrightConfigClient` (cassette double for tests). |
| `agent/src/setup.ts` | Workspace bootstrapping — directory scaffolding, identity-file seeding, plugin installation, and mise startup. Safe to call on every agent startup (idempotent). |
| `admin/src/crypto.ts` / `token-crypto.ts` | AES-256-GCM + token hashing helpers. |
| `admin/src/system-crons.ts` | System-cron definitions reconciled onto each agent. |
| `agent/src/github-app-auth.ts` | `GitHubTokenManager` — installation-token cache + proactive 30-min background refresh; `getBotIdentity()` for git author config. |
| `agent/src/github-token-store.ts` | Atomic file-based token store (`writeToken` / `readToken` / `resolveTokenPath`) used by the credential helper. |
| `agent/src/setup-github-auth.ts` | `setupGitHubAuth()` — wires GitHub auth on agent startup: App path (token manager + credential helper + git identity) or PAT path (`gh auth setup-git`). |
| `agent/scripts/bin/git-credential-shipwright.sh` | Git credential helper that reads the token file written by the App auth path. |
| `agent/scripts/entrypoint.ts` | Container entrypoint: validates env, fetches config, wires symlinks + GitHub auth, dynamic-imports `index.ts`. |
| `agent/scripts/run-agent.ts` | Local dev launcher: fetches config, sets env, spawns the agent process. Takes `--agent-id`, `--dry-run`. |
| `agent/scripts/cli-args.ts` | Pure CLI helpers: `getArg(name, argv)` and `hasFlag(name, argv)` for `--name=value` and `--name value` forms. |
| `scripts/chat.ts` | TUI REPL client for the dev `/chat` endpoint. Pure functions (`buildChatRequest`, `formatAgentResponse`, `fetchChatResponse`, `formatFetchError`) exported for unit testing; `runRepl()` drives the stdin/stdout loop. Requires `SHIPWRIGHT_DEV_CHAT=true` on the agent. |
| `agent/src/shipwright-config-client.ts` | `ShipwrightConfigClient` interface + `HttpShipwrightConfigClient` — calls `GET /agents/:id/config` with Bearer auth. |
| `agent/src/entrypoint-startup.ts` | Extracted startup logic (`runStartup(agentId, deps)`) — DI-injected for integration testing without real network or filesystem side effects. |
| `agent/src/cron-handler.ts` | Cron runtime: `handleCronRequest()` — runs a cron prompt through Claude and posts the result to Slack. Supports `preCheck` scripts, `silent` suppression, channel vs. DM delivery, and `onPost`/`onSession` callbacks. Fire-and-forget reporting via `CronRunReporter` (when configured) to `POST /agents/:id/crons/:cronId/runs`. |
| `agent/src/cron-run-reporter.ts` | Cron run reporter: `CronRunReporter` interface + `HttpCronRunReporter` (POSTs run outcomes to the admin API) and `NoopCronRunReporter` (test/default no-op). Reporter is injected into `handleCronRequest()` and called after every cron execution (skipped or posted) with metadata: `cronId`, `agentId`, `startedAt`, `completedAt`, `skipped`, `skipReason`, `outcome`, and optional `error`. |
| `agent/src/slack.ts` | Slack event handler: `createSlackApp()` — Bolt-based Socket Mode app handling DMs, `app_mention`, `reaction_added`, file attachments, and voice transcription. |
| `agent/src/health.ts` | Health server: `startHealthServer(port, summarize?, cronDeps?, clock?, graceMs?)` — K8s liveness probe server. `GET /health` returns `{ ok: true, slack: "connected"\|"disconnected" }` (200) or `{ ok: false, slack: "disconnected" }` (500) when the Slack socket has been continuously down longer than `graceMs` (default 90 s). `GET /stats` returns an `AnalyticsSummary` when a `summarize` function is injected (404 otherwise). `POST /cron` dispatches cron prompts via `cron-handler.ts`. Exports `slackState`, `markSlackConnected()`, and `markSlackDisconnected(clock)` for Slack socket lifecycle wiring. |
| `admin/prisma/schema.prisma` | The eight-model schema (`DATABASE_URL_SHIPWRIGHT_ADMIN`). |

## Testing

Unit + integration + smoke layers (`bun test --filter agent`). DB integration tests run against a real Postgres database (set via `DATABASE_URL_ADMIN_TEST`), provisioning the schema via `prisma migrate deploy` per suite — **no Prisma mocking**. Smoke tests drive the Hono apps via `app.request()`. See [testing.md](./testing.md).

## See also

- [architecture.md](./architecture.md) — the A→B→C→D artifact design.
- `CLAUDE.md` → "Database env vars" — the per-service `DATABASE_URL_*` convention.
