# Configuration

> Single authoritative reference for all Shipwright configuration options, organized by scope: [Plugin Config](#plugin-config), [Agent Config](#agent-config), and [Policy Config](#policy-config).

## Precedence

When the same option can be set multiple ways, resolution order is:

```
env var  >  built-in default
```

**Env vars are the only configuration path.** All Shipwright configuration is supplied via env vars — injected by the admin service for managed agents, or set in the local environment for direct plugin use.

---

## Plugin Config

Configuration for the Shipwright Claude Code plugin (`plugins/shipwright/`). These options control workspace discovery, task-store backend, and GitHub CLI integration.

### Env vars

| Name | Type | Default | Description |
|---|---|---|---|
| `SHIPWRIGHT_REPOS_DIR` | `string` | `<workspace>/repos` | Fallback repos directory for plugin scripts when workspace discovery finds no `repos/` dir. |
| `SHIPWRIGHT_REPO_DIR` | `string` | `$HOME/src` | Where the plugin commands (`dev-task`, `patch`, `deploy`) look for repo clones. The provisioner injects `<AGENT_HOME>/workspace/repos` for managed agents so clones live on the PVC. |
| `SHIPWRIGHT_WORKTREE_DIR` | `string` | `$HOME/worktrees` | Where the plugin commands create git worktrees. The provisioner injects `<AGENT_HOME>/workspace/worktrees` for managed agents — `$HOME` is ephemeral overlay storage in the agent container, and worktrees there can trigger pod eviction. |
| `GH_CMD` | `string` | `gh` | Override the `gh` CLI executable. Useful in environments where `gh` is installed to a non-default path. |
| `AGENT_HOME` | `string` | `/data/agent-home` | Persistent storage root for workspace files, mise caches, and `~/.claude`. Set in the agent container; also used by plugin scripts for workspace discovery. |
| `WORKSPACE_PATH` | `string` | — | Direct workspace path override. Takes precedence over `AGENT_HOME`-based discovery when set. |
| `SHIPWRIGHT_TASK_STORE_URL` | `string` | — | Base URL of the Shipwright task-store HTTP service — the only task-store backend. Required (alongside `SHIPWRIGHT_TASK_STORE_TOKEN`) for `dev-task`, `review`, `patch`, `deploy`, and the `task-store` skill to function. |
| `SHIPWRIGHT_TASK_STORE_TOKEN` | `string` | — | Bearer token for task-store API access. See the [Metrics & Admin & Chat & Task-Store services](#metrics--admin--chat--task-store-services) table below for how it's minted and injected for managed agents. Env-var-only (secret). |

---

## Agent Config

Configuration for the Shipwright agent runtime (`agent/` and `admin/`). All options are env vars — there is no file-based fallback for agent config. Secrets must be supplied as env vars and are never stored in config files.

### Claude / Anthropic

| Name | Type | Default | Description |
|---|---|---|---|
| `ANTHROPIC_MODEL` | `string` | `claude-sonnet-4-6` | Claude model used for each agent invocation. |
| `ANTHROPIC_FALLBACK_MODEL` | `string` | — | Fallback model if the primary is unavailable. |
| `ANTHROPIC_EFFORT_LEVEL` | `string` | — | Effort/thinking level passed to Claude (e.g. `extended`, `auto`, `none`). |
| `ANTHROPIC_API_KEY` | `string` | — | Anthropic API key. Env-var-only (secret). |
| `CLAUDE_CODE_OAUTH_TOKEN` | `string` | — | Claude Code OAuth token (alternative to `ANTHROPIC_API_KEY`). Env-var-only (secret). |

### Slack

All Slack vars are env-var-only (secrets). The agent does not function as a Slack bot without them.

| Name | Type | Default | Description |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | `string` | required for Slack | Slack bot user OAuth token (`xoxb-...`). |
| `SLACK_APP_TOKEN` | `string` | required for Slack | Slack app-level token for Socket Mode (`xapp-...`). |
| `SLACK_SIGNING_SECRET` | `string` | required for Slack | Used to verify incoming Slack request signatures. |
| `SLACK_ADMIN_TOKEN` | `string` | — | Optional admin-level token for privileged Slack operations. |
| `SLACK_ALERT_CHANNEL` | `string` | — | Slack channel ID to post system alerts (e.g. startup errors). |
| `SLACK_OWNER_USER` | `string` | — | Slack user ID of the agent owner, used for DM fallback. |

### GitHub

Provide either the GitHub App vars (recommended) or `GH_TOKEN` (PAT). App auth is used when the App env vars are present; `GH_TOKEN` is the fallback.

| Name | Type | Default | Description |
|---|---|---|---|
| `GH_APP_ID` | `string` | required for App auth | GitHub App ID (integer as string). Env-var-only (secret). |
| `GH_APP_INSTALLATION_ID` | `string` | required for App auth | Installation ID for the target org/repo. Env-var-only (secret). |
| `GH_APP_PRIVATE_KEY` | `string` | required for App auth | PEM private key for the GitHub App (newlines may be `\n`-escaped). Env-var-only (secret). |
| `GH_TOKEN` | `string` | — | Personal Access Token. Used only when GitHub App vars are absent. Env-var-only (secret). |

### Shipwright platform

| Name | Type | Default | Description |
|---|---|---|---|
| `SHIPWRIGHT_API_URL` | `string` | — | Base URL of the Shipwright admin service, used by the agent entrypoint to fetch config at startup. |
| `SHIPWRIGHT_AGENT_ID` | `string` | — | The agent's ID in the Shipwright platform. Also settable via `--agent-id` CLI flag. |
| `SHIPWRIGHT_AGENT_API_KEY` | `string` | — | Bearer token for the config fetch at startup (`/agents/:id/config` and `/agents/:id/crons`). Also settable via `--api-key`. |

### Server

| Name | Type | Default | Description |
|---|---|---|---|
| `PORT` | `number` | `3000` | Hono server port. Applies to the admin service (`admin/src/main.ts`). |
| `SHIPWRIGHT_HEALTH_PORT` | `number` | `3459` | Dedicated health server port for K8s liveness probes. Started in-process by `entrypoint-main.ts` before the startup sequence so the probe is always reachable during init. |
| `NODE_ENV` | `string` | — | Runtime environment. Set to `production` to enforce production-safety guards (blocks `ADMIN_DEV_AUTH`). |
| `SENTRY_DSN` | `string` | — | Sentry error reporting DSN for the agent (`agent/src/index.ts`). When set, the agent initializes Sentry (`initSentry`) and reports unhandled cron handler errors via `Sentry.captureException` before the existing `console.error` and 500 response. When unset, Sentry is fully inert (no init call, zero telemetry). Unlike other Shipwright services, the agent is **not chart-provisioned** — it's provisioned per-tenant by `KubernetesAgentProvisioner` — so operators set `SENTRY_DSN` directly in the agent's own env, the same way `ANTHROPIC_API_KEY` is set. **This must be present at pod startup** — `initSentry` and the health server's `Sentry` wiring are evaluated once at module load, before the 60-second config-sync loop runs; delivering `SENTRY_DSN` via the agent config bundle instead of a pod env var leaves Sentry inactive for the pod's lifetime with no warning, and requires a pod restart to take effect. Env-var-only (secret). |
| `SENTRY_ENVIRONMENT` | `string` | — | Sentry environment tag for the agent. Defaults to `NODE_ENV` if unset, then `production`. Passed as the `environment` field in Sentry init options. Optional alongside `SENTRY_DSN`. |

### Metrics & Admin & Chat & Task-Store services

| Name | Type | Default | Description |
|---|---|---|---|
| `DATABASE_URL_SHIPWRIGHT_ADMIN` | `string` | required | Postgres connection string for the admin service schema (e.g. `postgresql://user:pass@host:5432/db`). |
| `DATABASE_URL_SHIPWRIGHT_CHAT` | `string` | required | Postgres connection string for the chat service schema. **Must be a separate database** from the admin and task-store services — the schema forbids sharing. |
| `SHIPWRIGHT_CHAT_AGENTS_URL` | `string` | — | Base URL of the Shipwright agents service, used by the chat service to resolve agent token scopes. When set alongside `SHIPWRIGHT_CHAT_AGENTS_API_KEY`, the chat service calls this URL to fetch the repos an agent token may access. Optional — when unset, agent tokens default to empty repo lists and scope resolution is disabled. |
| `SHIPWRIGHT_CHAT_AGENTS_API_KEY` | `string` | — | Bearer token for the chat service to call the agents service. Required alongside `SHIPWRIGHT_CHAT_AGENTS_URL` to enable scope resolution. Env-var-only (secret). |
| `SHIPWRIGHT_CHAT_SERVICE_URL` | `string` | — | Base URL of the Shipwright chat service (e.g. `http://chat:3000` or `https://chat.example.com`). When set alongside `SHIPWRIGHT_CHAT_SERVICE_TOKEN`, the agent starts the chat poll loop in Step 6b to poll for pending messages and reply. Optional — omit to disable the chat poll loop. |
| `SHIPWRIGHT_CHAT_SERVICE_TOKEN` | `string` | — | Bearer token for the agent to call the chat service. Required alongside `SHIPWRIGHT_CHAT_SERVICE_URL` to enable the chat poll loop. The chat service validates this token; tokens are scoped to their agent ID. Env-var-only (secret). When `SHIPWRIGHT_K8S_PROVISIONING=enabled`, this token is minted per-agent by the admin provisioner and stored in the agent Secret (key `chat-service-token`); injected into the agent Deployment via this env var. |
| `SHIPWRIGHT_CHAT_POLL_INTERVAL_MS` | `number` | `5000` | Poll interval in milliseconds for the chat poll loop (Step 6b). The agent claims one unclaimed message per thread per poll cycle and runs it through Claude. Only read when `SHIPWRIGHT_CHAT_SERVICE_URL` and `SHIPWRIGHT_CHAT_SERVICE_TOKEN` are configured. |
| `SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN` | `string` | — | Bearer token for admin-side chat-service token minting. Required (alongside `SHIPWRIGHT_CHAT_SERVICE_URL`) to enable per-agent provisioning on `POST /agents`. The admin service uses this token to call chat-service `POST /tokens` and `DELETE /tokens/:id` during agent lifecycle (mint on provision, revoke on rollback). Env-var-only (secret). |
| `DATABASE_URL_SHIPWRIGHT_TASK_STORE` | `string` | required | Postgres connection string for the task-store service. **Must be a separate database** from the admin and chat services — the schema forbids sharing. Read by `@shipwright/task-store` and `@shipwright/agent`. |
| `SHIPWRIGHT_TASK_STORE_URL` | `string` | — | Base URL of the Shipwright task-store service (e.g. `http://task-store:3000` or `https://tasks.example.com`). When set alongside `SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN`, the admin service wires per-agent tokens during provisioning and injects the URL + token into agent Deployment env vars (`SHIPWRIGHT_TASK_STORE_URL`, `SHIPWRIGHT_TASK_STORE_TOKEN`). Agents use these to authenticate with the task-store API when claiming tasks or updating status. |
| `SHIPWRIGHT_TASK_STORE_PUBLIC_URL` | `string` | — | Externally-reachable base URL of the task-store advertised in the admin mint-token success page's copy-paste env block (printed as `SHIPWRIGHT_TASK_STORE_URL`). Set this to the public route a local/laptop agent can resolve — e.g. `https://<host>/task-store` when the chart's `taskStore.expose.enabled` is on. The admin service's own in-cluster task-store calls (token minting + task CRUD) always use the internal `SHIPWRIGHT_TASK_STORE_URL`; only the displayed value changes. When unset, the env block falls back to `SHIPWRIGHT_TASK_STORE_URL` (current behavior). Set via the chart value `admin.taskStorePublicUrl`. |
| `SHIPWRIGHT_TASK_STORE_TOKEN` | `string` | — | Bearer token for task-store API access. Minted per-agent by the admin provisioner and stored in the agent Secret (key `task-store-token`); injected into the agent Deployment via `SHIPWRIGHT_TASK_STORE_TOKEN` env var. Used by agents to claim tasks, update status, and query the task queue, and by plugin scripts (e.g. `render-plan.ts`) to upload documents. Env-var-only (secret). *(planned — agent-side client wiring not yet implemented; tokens are minted and stored but not yet used by agents)* |
| `SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN` | `string` | — | Bearer token for admin-side task-store token minting. Required (alongside `SHIPWRIGHT_TASK_STORE_URL`) to enable per-agent provisioning on `POST /agents`. The admin service uses this token to call task-store `POST /tokens` and `DELETE /tokens/:id` during agent lifecycle (mint on provision, revoke on rollback). Env-var-only (secret). |
| `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS` | `number` | `900000` | Milliseconds a PR review/patch/deploy claim remains valid without a heartbeat. When an agent's last heartbeat exceeds this TTL, the claim will be abandoned and the PR record eligible for re-claiming by another agent. Task claims (`/shipwright:dev-task`) use `SHIPWRIGHT_TASK_STORE_TASK_CLAIM_TTL_MS` instead — implementation work commonly runs longer than a review pass. |
| `SHIPWRIGHT_TASK_STORE_TASK_CLAIM_TTL_MS` | `number` | `1800000` | Milliseconds an agent's task claim (`/shipwright:dev-task`) remains valid without a heartbeat. When an agent's last heartbeat exceeds this TTL, the claim will be abandoned and the task eligible for re-claiming by another agent. Set higher than `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS` because dev-task implementation work has wider duration variance than review. |
| `SHIPWRIGHT_TASK_STORE_DOC_TTL_SECONDS` | `number` | `3600` | Time-to-live, in seconds, for ephemeral HTML documents stored via `POST /docs` and served from the `GET /docs/:id` capability URL. After this window the document is evicted and the GET returns `404`. Storage is in-memory and **process-local** — a single replica or sticky routing is assumed (see [architecture.md](architecture.md#ephemeral-document-store-docs)). Invalid / non-positive values fall back to the default. |
| `SHIPWRIGHT_TASK_STORE_AGENTS_URL` | `string` | — | Base URL of the Shipwright agents service. When set alongside `SHIPWRIGHT_TASK_STORE_AGENTS_API_KEY`, the task-store service uses it to resolve agent tokens to their scoped repos. Without both vars, the scope resolver is disabled and agent tokens default to empty repo lists. Optional — not required when agents do not need repo-scoping. |
| `SHIPWRIGHT_TASK_STORE_AGENTS_API_KEY` | `string` | — | Bearer token for the task-store service to call the agents service. Required alongside `SHIPWRIGHT_TASK_STORE_AGENTS_URL` to enable scope resolution. Used by the task-store's `createScopeResolver()` to fetch agent repos. Follows the `SHIPWRIGHT_TASK_STORE_*` naming convention to avoid collision with the `agent-admin` skill's `SHIPWRIGHT_AGENT_API_KEY`. Env-var-only (secret). |
| `SENTRY_DSN` | `string` | — | Sentry error reporting DSN for the task-store, metrics, and admin services. When set, these services initialize Sentry and mount error-capture middleware that reports 5xx and unhandled exceptions. When unset, Sentry is disabled (zero telemetry overhead). The same DSN is also used by the Hono middleware (`@sentry/hono`) to initialize Sentry with scrubbing hooks that redact secrets and environment-specific tags. Env-var-only (secret). Each service reads its own `SENTRY_DSN` from its own env — see also the agent's `SENTRY_DSN` row under [Agent Config](#agent-config). |
| `SENTRY_ENVIRONMENT` | `string` | — | Sentry environment tag for the task-store, metrics, and admin services. Defaults to `NODE_ENV` if unset, then `production`. Passed as the `environment` field in Sentry init options. Optional alongside `SENTRY_DSN`. |
| `SHIPWRIGHT_SESSION_SECRET` | `string` | — | HS256 secret for the `admin_session` cookie. The admin service signs it on Google-OAuth login; the metrics service verifies it to reuse the same session (the two must share the value). |
| `SHIPWRIGHT_ENCRYPTION_KEY` | `string` | — | 64-char hex (32 bytes) for AES-256-GCM encryption of secrets at rest. **If unset, secrets are stored in plain text** — always set this in any real deployment. |
| `SHIPWRIGHT_ADMIN_ALLOWED_EMAILS` | `string` | — | Comma-separated list of Google email addresses permitted to log in to the admin UI. |
| `SHIPWRIGHT_ADMIN_APP_BASE_URL` | `string` | `http://localhost:{PORT}` | Public base URL of the admin service, used to construct the Google OAuth redirect URI. |
| `SHIPWRIGHT_ADMIN_PUBLIC_REPO` | `string` | — | Repository slug (format: `org/repo`) scoped for the public read-only task board. When set, `GET /public/tasks` displays tasks for this repo only, unauthenticated. When unset, the board renders in degraded mode (empty table + warning). Optional — omit to disable the public board. |
| `SHIPWRIGHT_ADMIN_TZ` | `string` | `America/Los_Angeles` | IANA timezone name (e.g. `America/New_York`) for date/time display in the admin UI. When unset, defaults to `America/Los_Angeles`. |
| `METRICS_DASHBOARD_URL` | `string` | `/dashboard` | URL for the "Metrics" toolbar link in the admin UI. Defaults to `/dashboard` (same-host relative path, suitable when the ingress routes `/dashboard` to the metrics service on the same public hostname). Set to an absolute URL when the metrics service runs on a different host or port (e.g. in local dev: `http://localhost:3460/dashboard`). |
| `METRICS_ADMIN_APP_URL` | `string` | `""` | The reverse of `METRICS_DASHBOARD_URL`: base URL of the admin console for the metrics **dashboard** toolbar's Agents/Tasks/PRs links. Defaults to empty (same-host relative links, suitable for single-host ingress). Set to an absolute URL when the admin console runs on a different origin than the metrics dashboard (e.g. in local `task stack`: `http://localhost:3001`), otherwise those links 404 on the metrics origin. Distinct from the server-to-server `METRICS_ADMIN_URL`. |
| `GOOGLE_CLIENT_ID` | `string` | — | Google OAuth 2.0 client ID. Required for the admin UI login flow. |
| `GOOGLE_CLIENT_SECRET` | `string` | — | Google OAuth 2.0 client secret. Required for the admin UI login flow. |

### Agent provisioning (admin service)

Controls how the admin service provisions the Kubernetes workload backing each agent on `POST /agents` (and tears it down on `DELETE /agents/:id`). When provisioning is disabled (the default), create/delete only write the database row — no cluster is required.

| Name | Type | Default | Description |
|---|---|---|---|
| `SHIPWRIGHT_K8S_PROVISIONING` | `string` | — | Set to `enabled` to provision a real Kubernetes PersistentVolumeClaim + Secret + Deployment per agent via `KubernetesAgentProvisioner`. Any other value (or unset) selects the no-op provisioner, preserving DB-only create/delete behavior. |
| `SHIPWRIGHT_K8S_NAMESPACE` | `string` | — | Target namespace for per-agent PersistentVolumeClaim, Secret, and Deployment. When set (explicit value), use that namespace (cross-namespace provisioning). When unset, fall back to the downward API (the pod's own release namespace — the zero-config default). Only read when provisioning is enabled. |
| `SHIPWRIGHT_AGENT_IMAGE` | `string` | — | Agent container image (without tag) used for the provisioned Deployment. Only read when provisioning is enabled. |
| `SHIPWRIGHT_AGENT_IMAGE_TAG` | `string` | `latest` | Image tag joined as `image:tag` for the provisioned Deployment. Only read when provisioning is enabled. |
| `SHIPWRIGHT_ADMIN_DEPLOYMENT_NAME` | `string` | — | Name of the admin Deployment, used as the `ownerReference` target so per-agent resources are garbage-collected with the admin Deployment. Only read when provisioning is enabled. |
| `SHIPWRIGHT_ADMIN_DEPLOYMENT_UID` | `string` | — | UID of the admin Deployment, paired with `SHIPWRIGHT_ADMIN_DEPLOYMENT_NAME` for the `ownerReference`. Only read when provisioning is enabled. |
| `SHIPWRIGHT_AGENT_REPLICAS` | `number` | `1` | Replica count for the provisioned agent Deployment. Only read when provisioning is enabled. |
| `SHIPWRIGHT_AGENT_PVC_STORAGE_GI` | `number` | `40` | Storage size in Gi for the per-agent persistent home directory (PVC). Only read when provisioning is enabled. Must be large enough to hold mise caches and workspace files across pod restarts. |
| `SHIPWRIGHT_AGENT_PVC_NAME_TEMPLATE` | `string` | — | Template for deriving the PVC name from the agent's human-readable name. Use `{name}` as the placeholder — it is substituted with the agent's name (slug) when provided, or the sanitized agent ID otherwise. Example: `my-org-agent-{name}-home` → `my-org-agent-okwow-home`. When unset (the default), PVCs are named `{sanitizedAgentId}-home`. Useful when migrating from static agents whose PVCs were created with a fixed naming convention. Only read when provisioning is enabled. |

### Workspace and tooling

| Name | Type | Default | Description |
|---|---|---|---|
| `AGENT_HOME` | `string` | `/data/agent-home` | Persistent storage root. Mount a PVC here in Kubernetes so mise caches, workspace files, and `~/.claude` survive pod restarts. |
| `MISE_DATA_DIR` | `string` | `<AGENT_HOME>/mise` | Mise data directory. On first startup, seeded from the image's default mise location so baked tools survive pod restarts. Override only if needed. |
| `MISE_CACHE_DIR` | `string` | `<AGENT_HOME>/mise/cache` | Override the mise cache directory. Auto-derived from `AGENT_HOME`. |
| `XDG_CACHE_HOME` | `string` | `<AGENT_HOME>/cache` | Override the XDG cache directory. Auto-derived from `AGENT_HOME`. |
| `XDG_DATA_HOME` | `string` | `$HOME/.local/share` | Override the XDG data directory. Used to locate the mise data dir (`$XDG_DATA_HOME/mise`) when seeding a fresh PVC. |
| `SHIPWRIGHT_STARTUP_TIMEOUT_MS` | `number` | `180000` | Maximum milliseconds the entrypoint startup sequence may take before the agent exits. Override to a lower value (e.g. `10000`) in dev for faster fail-fast feedback. |
| `AGENT_ALLOWED_TOOLS` | `string` (JSON array) | — | JSON array of allowed Claude tool patterns. Set by the admin service config sync; do not set manually in production. |

### Voice

Optional. When unset, voice transcription and synthesis are disabled.

| Name | Type | Default | Description |
|---|---|---|---|
| `GROQ_API_KEY` | `string` | — | Groq API key for voice processing. Env-var-only (secret). |
| `ELEVENLABS_API_KEY` | `string` | — | ElevenLabs API key for speech synthesis. Env-var-only (secret). |
| `ELEVENLABS_VOICE_ID` | `string` | — | ElevenLabs voice ID to use for synthesis. |
| `WHISPER_SERVICE_URL` | `string` | — | URL of a Whisper transcription service for voice input. |

On Kubernetes these env vars are a deploy-time option of the Helm chart rather than something you set by hand. Set `agent.voice.enabled=true` and `agent.voice.provider` (`whisper` | `groq`); the chart then injects the matching env into provisioned agent pods. With `provider=whisper` it renders a self-hosted Whisper ASR pod (`onerahmet/openai-whisper-asr-webservice`, reached at its `POST /asr` endpoint) and sets `WHISPER_SERVICE_URL` to its in-cluster Service. With `provider=groq` it flows `GROQ_API_KEY` from a chart-managed voice Secret. ElevenLabs TTS (`ELEVENLABS_API_KEY`, optional `ELEVENLABS_VOICE_ID`) applies to both providers. See the `agent.voice` block in `charts/shipwright/values.yaml`.

### Dev-only

**Do not set these in production.**

| Name | Type | Default | Description |
|---|---|---|---|
| `ADMIN_DEV_AUTH` | `bool` | `false` | Enables `GET /admin/dev-login` (bypasses Google OAuth, mints a dev session). Blocked when `NODE_ENV=production`. |
| `METRICS_DASHBOARD_DEV_AUTH` | `bool` | `false` | Bypasses `/dashboard` session auth and `/metrics/*` API auth for local dev. Must not be enabled in production — exits with an error if `NODE_ENV=production`. |
| `TASK_STORE_SEED_ADMIN_TOKEN` | `string` | — | Bootstrap admin token seeded into the task-store on startup. Used only in local dev (`task stack`) to provision a bootstrapped admin token without manual token creation. Not a real secret — used only against the local dev Postgres instance. Ignored if empty. |
| `CHAT_SEED_ADMIN_TOKEN` | `string` | — | Bootstrap admin token seeded into the chat service on startup. Used only in local dev to provision a bootstrapped admin token without manual token creation. Not a real secret — used only against the local dev Postgres instance. Ignored if empty. |

---

## Observability

Each of `admin`, `metrics`, `task-store`, and `agent` reads its own `SENTRY_DSN` from its own environment — there is no shared/global toggle. See [`docs/observability.md`](./observability.md) for exactly what is (and isn't) collected and how the scrub hooks work.

`SENTRY_DSN` / `SENTRY_ENVIRONMENT` are documented per-service rather than repeated here: see the `SENTRY_DSN` row under [Agent Config → Server](#server) for the agent — including the pod-startup timing constraint, since `initSentry` runs once at module load, before the config-sync loop — and the `SENTRY_DSN` row under [Agent Config → Metrics & Admin & Chat & Task-Store services](#metrics--admin--chat--task-store-services) for `task-store`, `metrics`, and `admin`.

---

## Policy Config

Agent behavior is controlled by `state/agent-policy.md`. This is a Markdown file with a YAML front-matter block. Edit it directly to change review posting, merge permissions, and autonomy levels without reconfiguring crons or restarting the agent.

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `auto_post_reviews` | `bool` | `false` | Post review comments to GitHub automatically without manual approval. |
| `allowed_events` | `string[]` | `["COMMENT", "APPROVE"]` | GitHub review event types the agent may emit. |
| `review_external_prs` | `bool` | `true` | Review PRs opened by users other than the agent. |
| `allow_self_review` | `bool` | `true` | Allow the agent to review its own PRs. Set to `false` to require a human reviewer on agent-authored PRs. |
| `min_confidence` | `number` | `75` | Minimum confidence score (0–100) for a finding to be included in a review. |
| `max_findings` | `number` | `5` | Maximum number of findings to include in a single review. |
| `cleanup_merged_worktrees` | `bool` | `true` | Automatically remove worktrees for merged branches. |
| `cleanup_after_days` | `number` | `14` | Age threshold (days) before a merged-branch worktree is eligible for cleanup. |

### Example

```markdown
---
auto_post_reviews: false
allowed_events: [COMMENT, APPROVE]
review_external_prs: true
allow_self_review: true
min_confidence: 75
max_findings: 5
cleanup_merged_worktrees: true
cleanup_after_days: 14
---
```

---

## See also

- [architecture.md](./architecture.md) — the four-artifact A→B→C→D design.
- [agent.md](./agent.md) — Shipwright agent runtime, admin CRUD APIs, and data model.
- [quickstart.md](./quickstart.md) — how to get the full dev stack running locally.
- `CLAUDE.md` — env var namespacing convention and database env var rules.
