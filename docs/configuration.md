# Configuration

> Single authoritative reference for all Shipwright configuration options, organized by scope: [Plugin Config](#plugin-config), [Agent Config](#agent-config), and [Policy Config](#policy-config).

## Precedence

When the same option can be set multiple ways, resolution order is:

```
env var  >  .shipwright.json  >  built-in default
```

**Env vars are the primary configuration path.** Managed Shipwright agents must use env vars — they are injected by the admin service and are the only supported config mechanism for deployed agents. `.shipwright.json` is a local fallback for use when you install and run the Shipwright plugin directly in Claude Code (or a compatible system) without a managed agent. Do not commit or rely on `.shipwright.json` in a managed agent deployment.

---

## Plugin Config

Configuration for the Shipwright Claude Code plugin (`plugins/shipwright/`). These options control workspace discovery, task-store backend, and GitHub CLI integration.

### Env vars

| Name | Type | Default | Description |
|---|---|---|---|
| `SHIPWRIGHT_TASK_STORE` | `string` | — | Selects the task store backend (`github`, `jira`, or `json`). When set, takes precedence over all file-based config — the `.shipwright.json` walk-up and `SHIPWRIGHT_CONFIG` are skipped entirely. |
| `SHIPWRIGHT_GITHUB_OWNER` | `string` | — | GitHub organization or user name. Required when `SHIPWRIGHT_TASK_STORE=github`. |
| `SHIPWRIGHT_GITHUB_REPO` | `string` | — | GitHub repository name. Required when `SHIPWRIGHT_TASK_STORE=github`. |
| `JIRA_BASE_URL` | `string` | — | Base URL of the Jira instance (e.g. `https://example.atlassian.net`). Required when `SHIPWRIGHT_TASK_STORE=jira`. |
| `JIRA_PROJECT_KEY` | `string` | — | Jira project key (e.g. `SHIP`). Required when `SHIPWRIGHT_TASK_STORE=jira`. |
| `SHIPWRIGHT_REPOS_DIR` | `string` | `<AGENT_HOME>/workspace/repos` | Override the workspace repos directory. Used by scripts that need to know where checked-out repos live. |
| `SHIPWRIGHT_WORKTREE_DIR` | `string` | `<AGENT_HOME>/workspace/worktrees` | Override the workspace worktrees directory. |
| `SHIPWRIGHT_LOCAL_MARKETPLACE` | `string` | — | Absolute path to a local marketplace checkout. When set, plugin installs and updates use this path instead of fetching from GitHub. Dev-only — do not set in production. |
| `SHIPWRIGHT_DEV_CHAT` | `bool` | `false` | Enables the unauthenticated `POST /chat` endpoint on the agent. **Must not be set in production** (`NODE_ENV=production` blocks it via `chat-guard.ts`). |
| `SHIPWRIGHT_CONFIG` | `string` | — | Explicit path to `.shipwright.json` when auto-discovery (walk-up from cwd) is not suitable. Falls back to local JSON state if neither this nor the walk-up finds a file. |
| `GH_CMD` | `string` | `gh` | Override the `gh` CLI executable. Useful in environments where `gh` is installed to a non-default path. |
| `AGENT_HOME` | `string` | `~/.shipwright-agent` | Persistent storage root for workspace files, mise caches, and `~/.claude`. Set in the agent container; also used by plugin scripts for workspace discovery. |
| `WORKSPACE_PATH` | `string` | — | Direct workspace path override. Takes precedence over `AGENT_HOME`-based discovery when set. |
| `JIRA_API_TOKEN` | `string` | — | API token for Jira authentication. Required when `taskStore` is `"jira"`. Env-var-only (secret). |
| `JIRA_EMAIL` | `string` | — | Email address for Jira authentication. Required when `taskStore` is `"jira"`. |

### `.shipwright.json`

`.shipwright.json` is for use when you **install and run the Shipwright plugin in Claude Code (or a compatible system)** directly — without a managed Shipwright agent. Managed agents receive all configuration via env vars from the admin service; they do not read `.shipwright.json`.

Config-file resolution (`create-task-store.ts` → `loadConfig`):
1. Check `SHIPWRIGHT_TASK_STORE` env var — if set, use env vars directly and skip file-based config.
2. Walk up from `cwd` looking for `.shipwright.json`.
3. Fall back to `SHIPWRIGHT_CONFIG` env var.
4. Fall back to local JSON state (`state/`).

#### Task store keys

| Key | Type | Default | Description |
|---|---|---|---|
| `taskStore` | `"json" \| "github" \| "jira"` | required | Backend for the task store. |
| `github.owner` | `string` | required if `taskStore="github"` | GitHub org or user that owns the issues repo. |
| `github.repo` | `string` | required if `taskStore="github"` | GitHub repo name containing issues used as tasks. |
| `jira.baseUrl` | `string` | required if `taskStore="jira"` | Base URL of the Jira instance (e.g. `https://yourorg.atlassian.net`). |
| `jira.projectKey` | `string` | required if `taskStore="jira"` | Jira project key (e.g. `SHIP`). |
| `jira.readyJql` | `string` | — | Custom JQL to filter ready tasks. Overrides the default status-based query. |
| `jira.statusMap` | `Record<string, TaskStatus>` | — | Maps Jira status names to Shipwright task statuses. |

#### Minimal example

```json
{
  "taskStore": "github",
  "github": {
    "owner": "your-org",
    "repo": "your-repo"
  }
}
```

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
| `SHIPWRIGHT_INTERNAL_API_KEY` | `string` | — | Bearer token for the runtime API (`/agents/*`) and the config fetch at startup. Env-var-only (secret). |

### Migration (one-time cutover)

Used only by `agent/src/run-migration.ts` when migrating agents from the Vitals OS platform to the Shipwright admin service. Not needed in a fresh deployment.

| Name | Type | Default | Description |
|---|---|---|---|
| `VITALS_OS_API_URL` | `string` | — | Base URL of the source Vitals OS accounts service. Used by the migration script only. |
| `VITALS_OS_API_KEY` | `string` | — | API key for the source Vitals OS accounts service. Migration script only. Env-var-only (secret). |
| `SHIPWRIGHT_ADMIN_API_KEY` | `string` | — | API key for the destination Shipwright admin service. Migration script only. Env-var-only (secret). |

### Server

| Name | Type | Default | Description |
|---|---|---|---|
| `PORT` | `number` | `3000` | Hono server port. Applies to both the admin service (`admin/src/main.ts`) and the agent runtime server (`agent/src/run-agent.ts`); each defaults independently to `3000`. |
| `HEALTH_PORT` | `number` | `PORT ?? 3001` | Agent health server port for the K8s liveness probe. Defaults to `PORT` when set, otherwise `3001`. Set separately to expose the probe on a different port from the main server. |
| `NODE_ENV` | `string` | — | Runtime environment. Set to `production` to enforce production-safety guards (blocks `SHIPWRIGHT_DEV_CHAT`, `ADMIN_DEV_AUTH`). |

### Metrics & Admin service

| Name | Type | Default | Description |
|---|---|---|---|
| `DATABASE_URL_SHIPWRIGHT_ADMIN` | `string` | required | Postgres connection string for the admin service schema (e.g. `postgresql://user:pass@host:5432/db`). |
| `SHIPWRIGHT_SESSION_SECRET` | `string` | — | Secret for signing the `vitals_session` JWT cookie (used by both the metrics dashboard and the admin service). |
| `SHIPWRIGHT_ENCRYPTION_KEY` | `string` | — | 64-char hex (32 bytes) for AES-256-GCM encryption of secrets at rest. **If unset, secrets are stored in plain text** — always set this in any real deployment. |
| `SHIPWRIGHT_ADMIN_ALLOWED_EMAILS` | `string` | — | Comma-separated list of Google email addresses permitted to log in to the admin UI. |
| `SHIPWRIGHT_ADMIN_APP_BASE_URL` | `string` | `http://localhost:{PORT}` | Public base URL of the admin service, used to construct the Google OAuth redirect URI. |
| `GOOGLE_CLIENT_ID` | `string` | — | Google OAuth 2.0 client ID. Required for the admin UI login flow. |
| `GOOGLE_CLIENT_SECRET` | `string` | — | Google OAuth 2.0 client secret. Required for the admin UI login flow. |

### Workspace and tooling

| Name | Type | Default | Description |
|---|---|---|---|
| `AGENT_HOME` | `string` | `~/.shipwright-agent` | Persistent storage root. Mount a PVC here in Kubernetes so mise caches, workspace files, and `~/.claude` survive pod restarts. |
| `MISE_DATA_DIR` | `string` | `<AGENT_HOME>/.mise` | Override the mise data directory. Auto-derived from `AGENT_HOME`; override only if needed. |
| `MISE_CACHE_DIR` | `string` | `<AGENT_HOME>/.mise/cache` | Override the mise cache directory. Auto-derived from `AGENT_HOME`. |
| `XDG_CACHE_HOME` | `string` | `<AGENT_HOME>/.cache` | Override the XDG cache directory. Auto-derived from `AGENT_HOME`. |
| `AGENT_ALLOWED_TOOLS` | `string` (JSON array) | — | JSON array of allowed Claude tool patterns. Set by the admin service config sync; do not set manually in production. |

### Analytics

All analytics vars are env-var-only (secrets/infra identifiers).

| Name | Type | Default | Description |
|---|---|---|---|
| `POSTHOG_PROJECT_API_KEY` | `string` | — | PostHog project API key for event ingest. Env-var-only (secret). |
| `POSTHOG_HOST` | `string` | `https://us.i.posthog.com` | PostHog ingest host. Override for self-hosted PostHog deployments. |

### Voice

Optional. When unset, voice transcription and synthesis are disabled.

| Name | Type | Default | Description |
|---|---|---|---|
| `GROQ_API_KEY` | `string` | — | Groq API key for voice processing. Env-var-only (secret). |
| `ELEVENLABS_API_KEY` | `string` | — | ElevenLabs API key for speech synthesis. Env-var-only (secret). |
| `ELEVENLABS_VOICE_ID` | `string` | — | ElevenLabs voice ID to use for synthesis. |
| `WHISPER_SERVICE_URL` | `string` | — | URL of a Whisper transcription service for voice input. |

### Dev-only

**Do not set these in production.**

| Name | Type | Default | Description |
|---|---|---|---|
| `SHIPWRIGHT_DEV_CHAT` | `bool` | `false` | Enables the unauthenticated `POST /chat` endpoint. Blocked at startup when `NODE_ENV=production`. |
| `ADMIN_DEV_AUTH` | `bool` | `false` | Enables `GET /admin/dev-login` (bypasses Google OAuth, mints a dev session). Blocked when `NODE_ENV=production`. |

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

- [architecture.md](./architecture.md) — the three-artifact A→B→C design.
- [agent.md](./agent.md) — Shipwright agent runtime, admin CRUD APIs, and data model.
- [quickstart.md](./quickstart.md) — how to get the full dev stack running locally.
- `CLAUDE.md` — env var namespacing convention and database env var rules.
