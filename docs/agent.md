# Shipwright Agent

> The Shipwright agent (artifact **C**) is a thin autonomous runner: pick the next ready task → build → ship a PR → forward metrics. It has a Prisma-backed store (SQLite locally, PostgreSQL in production) and three HTTP surfaces — a machine-polled **runtime API**, a human-facing **admin CRUD API**, and a server-rendered **admin UI**.

## Overview

The agent owns six first-class Prisma models (`Agent` and its `Env` / `CronJob` / `Tool` / `Token` / `Plugin` children) on a **dedicated database** (`DATABASE_URL_AGENT`). Secrets at rest (env values, Slack/Anthropic keys) are AES-256-GCM encrypted at the service layer; agent API tokens are stored only as SHA-256 hashes.

> The top-level runner (`agent/src/index.ts`) is currently a Phase-C placeholder (`export {}`). The implemented surfaces are the admin CRUD API (`admin-api.ts`), the runtime API (`api.ts`), the server-rendered admin UI (`admin-ui.ts`), and the Prisma store + service classes. On startup the runner is expected to call `POST /admin/api/agents/:id/crons/reconcile` to sync system crons.

## Running locally

```bash
export DATABASE_URL_AGENT="file:./agent/dev.db"   # SQLite for local dev; postgres URL for prod

task db:provision          # prisma migrate deploy (idempotent)
task db:migrate            # prisma migrate dev (create a new migration)
```

The schema declares `provider = "sqlite"` for local portability — swap to `postgresql` and regenerate migrations to deploy against real Postgres. Each Prisma service reads its **own** `DATABASE_URL_*`; never point this at a shared database.

## HTTP surfaces

### Runtime API (`api.ts`) — machine-polled

Mounted at `/agents/*`. The harness polls this every ~60s. Auth: **Bearer token** matching `SHIPWRIGHT_INTERNAL_API_KEY` (any mismatch → `401`).

| Method | Path | Description |
|---|---|---|
| GET | `/agents/:id/config` | Agent config bundle: decrypted `env`, `allowedTools`, and installed `plugins` (with derived marketplace). `404` if the agent doesn't exist. |
| GET | `/agents/:id/crons` | Enabled cron jobs for the agent. `404` if the agent doesn't exist. |

### Admin CRUD API (`admin-api.ts`) — human-facing

Mounted at `/admin/api/*`. Auth: **session cookie** `admin_session` (httpOnly JWT verified with `SHIPWRIGHT_SESSION_SECRET`; absent/invalid → `401`).

| Resource | Endpoints |
|---|---|
| Envs | `POST` / `GET` / `PATCH` `/admin/api/agents/:id/envs`, `DELETE /admin/api/agents/:id/envs/:key` |
| Crons | `POST` / `GET` `/admin/api/agents/:id/crons`, `PATCH` / `DELETE` `/admin/api/agents/:id/crons/:cronId`, `POST /admin/api/agents/:id/crons/reconcile` |
| Tools | `POST` / `GET` `/admin/api/agents/:id/tools`, `PATCH` / `DELETE` `/admin/api/agents/:id/tools/:toolId` |
| Tokens | `POST` / `GET` `/admin/api/agents/:id/tokens`, `DELETE /admin/api/agents/:id/tokens/:tokenId` |
| Plugins | `POST` / `GET` / `PATCH` `/admin/api/agents/:id/plugins`, `DELETE /admin/api/agents/:id/plugins` |

Token creation returns the **raw token once** at creation; only its SHA-256 hash is persisted, so validation is an O(1) hash-index lookup.

## Data model

| Model | Owns | Notable fields |
|---|---|---|
| `Agent` | The runner identity | `name`, `slackId` (unique), `slackBotToken` / `anthropicApiKey` (AES-256-GCM encrypted). |
| `AgentEnv` | Key/value env store | `key`, `value` (encrypted); unique per `[agentId, key]`. |
| `AgentCronJob` | Scheduled prompts | `schedule` (cron expr), `prompt`, `channel` **xor** `user`, `silent`, `enabled`, `preCheck`, `name`/`system` (system-cron key). |
| `AgentTool` | Allowed tool patterns | `pattern` (e.g. `Read`, `Bash`), `enabled`; unique per `[agentId, pattern]`. |
| `AgentToken` | Scoped API tokens | `token` (SHA-256 hash), `label`, `revokedAt`. |
| `AgentPlugin` | Installed Claude Code plugins | `name` (package), `version` (null = latest), `enabled`; unique per `[agentId, name]`. |

All child models cascade-delete with their `Agent`.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL_AGENT` | ✅ | Dedicated Prisma datasource (`file:./...` SQLite or a Postgres URL). |
| `SHIPWRIGHT_INTERNAL_API_KEY` | runtime API | Bearer token for `/agents/*`. |
| `SHIPWRIGHT_SESSION_SECRET` | admin API | Secret for verifying the `admin_session` JWT cookie. |
| `SHIPWRIGHT_ENCRYPTION_KEY` | secrets at rest | 64-char hex (32 bytes) for AES-256-GCM. **If unset, secrets are stored in plain text** (logged warning) — set it in any real deployment. |
| `GH_APP_ID` | GitHub App auth | GitHub App ID (integer as string). Required when using the App auth path. |
| `GH_APP_PRIVATE_KEY` | GitHub App auth | PEM private key for the GitHub App (newlines may be `\n`-escaped). Required when using the App auth path. |
| `GH_APP_INSTALLATION_ID` | GitHub App auth | Installation ID for the target org/repo. Required when using the App auth path. |
| `GH_TOKEN` | GitHub PAT auth | Personal Access Token for the legacy `gh auth setup-git` path. Used only if the App env vars are absent. |

## Key Files

| File | Purpose |
|---|---|
| `agent/src/api.ts` | Runtime API factory `createAgentRuntimeApp()` (DI for services). |
| `agent/src/admin-api.ts` | Admin CRUD factory `createAdminApp()` + session-auth middleware. |
| `agent/src/admin-ui.ts` | Admin UI factory `createAdminUIApp()` — server-rendered Hono app (login, agent list/detail, Slack provisioning). |
| `agent/src/admin-ui-pages.ts` | Page rendering functions (`renderLoginPage`, `renderAgentsPage`, `renderAgentDetailPage`, `renderProvision*`). |
| `agent/src/admin-ui-styles.ts` | Shared CSS helpers (`baseStyles`, `escapeHtml`, `renderAdminToolbar`). |
| `agent/src/slack-provisioning-client.ts` | `SlackProvisioningClient` interface + `HttpSlackProvisioningClient` — drives the one-time Slack app creation flow. |
| `agent/src/agent-envs.ts` | Env service — encrypted key/value store + config bundle assembly. |
| `agent/src/agent-cron-jobs.ts` | Cron service + system-cron reconciliation. |
| `agent/src/agent-tools.ts` / `agent-tokens.ts` / `agent-plugins.ts` | Per-resource service classes. |
| `agent/src/crypto.ts` / `token-crypto.ts` | AES-256-GCM + token hashing helpers. |
| `agent/src/system-crons.ts` | System-cron definitions reconciled onto each agent. |
| `agent/src/github-app-auth.ts` | `GitHubTokenManager` — installation-token cache + proactive 30-min background refresh; `getBotIdentity()` for git author config. |
| `agent/src/github-token-store.ts` | Atomic file-based token store (`writeToken` / `readToken` / `resolveTokenPath`) used by the credential helper. |
| `agent/src/setup-github-auth.ts` | `setupGitHubAuth()` — wires GitHub auth on agent startup: App path (token manager + credential helper + git identity) or PAT path (`gh auth setup-git`). |
| `agent/scripts/bin/git-credential-shipwright.sh` | Git credential helper that reads the token file written by the App auth path. |
| `agent/prisma/schema.prisma` | The six-model schema (`DATABASE_URL_AGENT`). |

## Testing

Unit + integration + smoke layers (`bun test --filter agent`). DB integration tests run against a real scratch SQLite database (`DATABASE_URL_AGENT="file:./test.db"`), provisioning the schema via `prisma migrate deploy` per suite — **no Prisma mocking**. Smoke tests drive the Hono apps via `app.request()`. See [testing.md](./testing.md).

## See also

- [architecture.md](./architecture.md) — the A→B→C artifact design.
- `CLAUDE.md` → "Database env vars" — the per-service `DATABASE_URL_*` convention.
