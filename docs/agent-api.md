# Agent Admin API

The Shipwright admin service exposes a CRUD API for managing agents and their resources. It is the control plane used by the admin UI, the `agent-admin` skill, and the provisioning pipeline.

Base path: `/agents`

---

## Authentication

Three auth paths are checked in order:

1. **Admin key** — `Authorization: Bearer <key>` where the key matches an entry in `SHIPWRIGHT_ADMIN_API_KEYS`. Sets `isAdmin=true`, bypasses all per-agent checks.
2. **Per-agent bearer token** — `Authorization: Bearer <token>` where the token is a per-agent DB token scoped to a specific agent ID. Sets `isAdmin=false`, restricts access to that agent's own routes (`403` on cross-agent access).
3. **Session cookie** — `admin_session` httpOnly JWT verified with `SHIPWRIGHT_SESSION_SECRET`. Sets `isAdmin=true`.

If an `Authorization` header is present but the token is invalid in both token paths, the request is rejected with `401` (no fallthrough to cookie). Missing auth returns `401`. Cross-agent access with a per-agent token returns `403`.

Routes marked **admin-only** require `isAdmin=true`. Per-agent bearer tokens cannot call these routes.

---

## Agents

### Create agent

```
POST /agents
```

Admin-only. Creates an agent record and, for managed (non-self-hosted) agents, provisions the Kubernetes workload.

The `type` field (optional, defaults to `"coding"`) selects an Agent Type manifest (`agent-types/<type>/manifest.yaml`) that drives seeding: an unknown `type` returns `400` **before any row is created** (zero agent/tool/plugin/member rows persist). On successful agent creation, the resolved manifest is used to seed:

- **AgentTool** rows from the manifest's `tools[]`
- **AgentPlugin** rows from the manifest's `plugins[]` (for the default "coding" type, this includes the `shipwright` plugin)
- **AgentMember** rows from the manifest's `members[]`
- **`repos`** — the manifest's `repos[]` merged (deduplicated) with any request-supplied `repos`

All seeding happens inside the same rollback-guarded block as provisioning — if any seeding step or provisioning fails, every already-seeded child row (tools/plugins/members) is cascade-deleted along with the rolled-back agent row.

Body:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Agent slug — used as the K8s Deployment name |
| `slackId` | no | Slack user ID for the agent's bot account |
| `selfHosted` | no | `true` if the agent runs outside Kubernetes (default `false`) |
| `type` | no | Agent Type name (default `"coding"`). Unknown type → `400`, zero rows created |
| `repos` | no | Array of `org/repo` strings, merged with the resolved type's manifest `repos[]` |
| `reviewAuthorAllowlist` | no | Array of GitHub login strings — authors permitted to trigger this agent's review/dev-task work (default empty array = all authenticated users). |
| `patchAuthorAllowlist` | no | Array of GitHub login strings — authors whose PRs this agent will also treat as patch candidates (default empty array). **DBR-1.4:** enforcement is active — `agent/src/check-patch.ts` adds PRs authored by these logins to the patch candidate pool, merged with the agent's self-authored PRs and deduplicated by (repo, PR number). When empty (the default), patch runs remain self-authored-only — an additive allowlist, not a fail-open filter like `reviewAuthorAllowlist`. Settable at creation and editable afterward via `PATCH /agents/:id`. |
| `restrictSlackToMembers` | no | `true` to restrict Slack message access to agents with `AgentMember` rows (default `false` = unrestricted). When true and no members are configured, a non-blocking warning is returned. |

Returns `201` with `{ id, name, slackId, selfHosted, repos, reviewAuthorAllowlist, patchAuthorAllowlist, restrictSlackToMembers, typeName, createdAt, updatedAt, missingRequiredEnv, warning? }`. Returns `400` for an unknown `type`. The optional `warning` field is present when `restrictSlackToMembers` is true but no members are configured.

### List agents

```
GET /agents
```

Admin-only. Returns all agents with `id`, `name`, `selfHosted`, and `typeName` fields. Used for metrics name resolution.

### Get agent

```
GET /agents/:id
```

Admin-only. Returns the full agent record including `selfHosted`, `repos`, `reviewAuthorAllowlist`, `patchAuthorAllowlist`, `restrictSlackToMembers`, `typeName`, and `missingRequiredEnv`.

`reviewAuthorAllowlist` is an array of GitHub login strings — authors whose pull requests are permitted to trigger this agent's review/dev-task work. When empty, all authenticated users are allowed.

`patchAuthorAllowlist` is an array of GitHub login strings — the authors intended to be permitted to trigger patch operations against this agent. **DBR-1.3:** the value is synced live via `agent/src/patch-author-allowlist-ref.ts`. **DBR-1.4:** enforcement is now active — `agent/src/check-patch.ts` filters patch candidates to PRs authored by allowlisted logins, merged with self-authored PRs and deduplicated by (repo, PR number). When empty (the default), patch runs remain self-authored-only — an additive allowlist, not a fail-open filter like review's `reviewAuthorAllowlist`.

`restrictSlackToMembers` is a boolean flag that, when `true`, restricts Slack message access to only users listed in the agent's `AgentMember` rows. Defaults to `false` (unrestricted). An optional `warning` field is included in the response when this flag is `true` but no members are configured, alerting the operator that all Slack senders are currently blocked.

`missingRequiredEnv` is an array of required env var keys declared by the agent's type manifest that have no corresponding `AgentEnv` row yet — key names only, never values. This is purely informational (ATS-4.2).

### Update agent

```
PATCH /agents/:id
```

Admin-only. Updatable fields: `selfHosted` (boolean), `repos` (array of `org/repo` strings — each entry is validated for format), `reviewAuthorAllowlist` (array of GitHub login strings — usernames of authors permitted to trigger this agent's review/dev-task work), `patchAuthorAllowlist` (array of GitHub login strings — authors whose PRs this agent will also treat as patch candidates; enforced at runtime since DBR-1.4 by `agent/src/check-patch.ts`, additively on top of the agent's self-authored PRs, with an empty value meaning self-authored-only), `restrictSlackToMembers` (boolean — when `true`, restricts Slack access to configured members only), `slackId` (nullable string — Slack user ID for the agent's bot account; normally resolved and persisted automatically via `auth.test` right after Slack OAuth completes, this field exists to backfill it for agents that connected Slack before that fix shipped). `typeName` is not updatable via this route. Returns the updated agent.

### Delete agent

```
DELETE /agents/:id
```

Admin-only. Runs the full `deleteAgentFully()` teardown: deprovisions the agent's K8s workload (Deployment, Secret, and PVC), revokes its task-store and chat-service tokens, deletes its chat threads, and — if a `SLACK_APP_ID` env var is present and an `xoxpToken` was supplied — deletes its Slack app. The Agent DB row (and its cascade-deleted child records: envs, crons, tools, tokens, plugins) is deleted **last**, and only if every one of those steps succeeded.

Body (optional):

| Field | Required | Description |
|-------|----------|-------------|
| `xoxpToken` | no | Slack user token (`xoxp-...`) authorizing Slack app deletion. Omit to skip automatic Slack app deletion — a present Slack app then becomes a `manualStepsRequired` entry instead of a hard failure. |

Returns `200` with:

```json
{
  "agentDeleted": true,
  "completed": ["k8s", "task-store-tokens", "chat-service-tokens-and-threads", "slack-app"],
  "failed": [],
  "manualStepsRequired": [
    { "key": "GH_TOKEN", "message": "Revoke this GitHub personal access token at https://github.com/settings/tokens (or the fine-grained PAT settings page)." }
  ]
}
```

- `agentDeleted` — `true` only when every automatable step succeeded and the Agent row was deleted. `false` means at least one step failed and the row was intentionally **preserved** for retry.
- `completed` — steps that succeeded, in execution order (`k8s`, `task-store-tokens`, `chat-service-tokens-and-threads`, `slack-app`).
- `failed` — `{ step, error }` entries for steps that threw. A failed step does not abort the remaining steps — every step is still attempted so a retry makes maximum forward progress.
- `manualStepsRequired` — operator reminders for state with no automated revocation: hand-pasted secrets (`GH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and any other `AgentEnv` row with `secret: true`), plus a Slack-app entry when `SLACK_APP_ID` is set but no `xoxpToken` was supplied. Always populated when applicable; never blocks the delete.

**Retry semantics:** `agentDeleted: false` means the call is safe to retry — every underlying step is individually idempotent (K8s deprovision tolerates an already-absent workload, token revocation tolerates an already-revoked token, thread deletion tolerates no threads), so re-issuing `DELETE /agents/:id` once the failing dependency is healthy again only re-attempts what didn't finish. The Agent row stays reachable via `GET /agents/:id` until `agentDeleted` is `true`.

`404` if the agent doesn't exist. `403` if the caller isn't an admin.

### Provision agent

```
POST /agents/:id/provision
```

Admin-only. Provisions or re-provisions the K8s workload for a single managed agent. For self-hosted agents, returns `{ skipped: true, reason: "self-hosted" }` with no K8s changes. On success returns `204`.

### Reconcile all agents

```
POST /agents/reconcile
```

Admin-only. Reconciles K8s Deployment state against all managed (non-self-hosted) agents in the DB. Returns:

```json
{
  "recreated": ["<agentId>"],
  "updated": ["<agentId>"],
  "orphans": ["<deploymentName>"],
  "failed": [{ "agentId": "<id>", "error": "<message>" }]
}
```

---

## Environment variables

Env vars are stored encrypted (AES-256-GCM) and decrypted on read.

### Set env vars (bulk replace)

```
POST /agents/:id/envs
```

Body: `{ [key: string]: string }`. Replaces all env vars for the agent atomically. Returns `204`.

### Get env vars

```
GET /agents/:id/envs
```

Returns `{ [key: string]: string }` with decrypted values.

### Patch env vars (partial update)

```
PATCH /agents/:id/envs
```

Body: `{ [key: string]: string }`. Updates specific keys without touching others. Returns `204`.

### Delete env var

```
DELETE /agents/:id/envs/:key
```

Deletes a single env var by key. Returns `204`.

---

## Operational APIs

Cron jobs, cron runs, the allowed-tools list, API tokens, plugins, chat token usage, and the work-queue snapshot are documented in [`docs/agent-api-ops.md`](./agent-api-ops.md).

---

## Runtime config

```
GET /agents/:id/config
```

Used by the agent harness on startup and during the config sync loop. Returns the agent's full config bundle:

- `env` — decrypted key/value env vars
- `allowedTools` — array of tool patterns
- `plugins` — installed plugins with derived marketplace URLs
- `repos` — array of `org/repo` strings (scoped repositories this agent may access)
- `reviewAuthorAllowlist` — array of GitHub login strings (authors permitted to trigger this agent's review/dev-task work; empty array = all authenticated users allowed). Used by the runtime for review filtering.
- `patchAuthorAllowlist` — array of GitHub login strings (authors whose PRs this agent will also treat as patch candidates). **DBR-1.3:** synced live via `agent/src/patch-author-allowlist-ref.ts`. **DBR-1.4:** enforcement is active — patch candidates authored by allowlisted logins are merged with the agent's self-authored PRs and deduplicated by (repo, PR number). Empty allowlist means self-authored-only (additive source, not fail-open).
- `restrictSlackToMembers` — boolean flag controlling Slack message access. When `true`, only users in the agent's `AgentMember` rows can send messages. Defaults to `false` (unrestricted). Used by runtime to enforce membership-based access control.
- `memberEmails` — array of member email addresses (derived from agent's `AgentMember` rows). Empty when `restrictSlackToMembers` is `false` or no members are configured.

Returns `404` if the agent doesn't exist.
