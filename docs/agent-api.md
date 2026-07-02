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

Body:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Agent slug — used as the K8s Deployment name |
| `slackId` | no | Slack user ID for the agent's bot account |
| `selfHosted` | no | `true` if the agent runs outside Kubernetes (default `false`) |
| `repos` | no | Array of `org/repo` strings scoped to this agent |

Returns `201` with `{ id, name, slackId, selfHosted, repos, createdAt, updatedAt }`.

### List agents

```
GET /agents
```

Admin-only. Returns all agents with `id`, `name`, and `selfHosted` fields. Used for metrics name resolution.

### Get agent

```
GET /agents/:id
```

Admin-only. Returns the full agent record including `selfHosted` and `repos`.

### Update agent

```
PATCH /agents/:id
```

Admin-only. Updatable fields: `selfHosted` (boolean), `repos` (array of `org/repo` strings — each entry is validated for format). Returns the updated agent.

### Delete agent

```
DELETE /agents/:id
```

Admin-only. Deprovisions the agent's K8s workload (Deployment + Secret; PVC is retained for data safety), then deletes the DB record. All child records (envs, crons, tools, tokens, plugins) are cascade-deleted.

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

## Cron jobs

### Create cron job

```
POST /agents/:id/crons
```

Body:

| Field | Required | Description |
|-------|----------|-------------|
| `schedule` | yes | Cron expression, e.g. `"0 9 * * 1-5"` |
| `prompt` | yes | The prompt text sent to the agent when the cron fires |
| `channel` | no | Slack channel ID to post in (mutually exclusive with `user`) |
| `user` | no | Slack user ID to DM (mutually exclusive with `channel`) |
| `silent` | no | If `true`, suppress the Slack reply after execution |
| `enabled` | no | Whether the cron is active (default `true`) |
| `preCheck` | no | Pre-check script path. Three formats: `"plugin:script.ts"` (relative to plugin's `scripts/` dir), `"./relative.ts"` (relative to workspace root), `"/absolute.ts"`. Pass `null` to clear. |
| `name` | no | Human-readable identifier, e.g. `"morning-brief"` |

Returns `201` with the created cron job.

### List cron jobs

```
GET /agents/:id/crons
```

Returns `{ crons: AgentCronJob[] }` where each cron includes a run summary (last run timestamp, outcome, today's run count).

### Update cron job

```
PATCH /agents/:id/crons/:cronId
```

Body fields are the same as create, all optional. Two constraints:

- `schedule` and `prompt` must be provided together when doing a content update
- `enabled` and `preCheck` are orthogonal — each can be sent alone or combined with any other field
- At least one field must be present (empty body returns `400`)

Returns the updated cron job.

### Delete cron job

```
DELETE /agents/:id/crons/:cronId
```

Returns `204`. System crons (flagged `isSystem=true`) cannot be deleted — returns `403`.

### Reconcile system crons

```
POST /agents/:id/crons/reconcile
```

Reconciles the agent's system crons against the `SYSTEM_CRONS` list in the harness. Called automatically on agent startup. Returns `204`.

### Cron summary

```
GET /agents/:id/crons/summary
```

Returns a lightweight summary of all cron jobs — name, schedule, enabled state, and last run info — without full prompt text. Useful for dashboards.

---

## Cron runs

Cron runs record each execution of a cron job, including token usage and cost.

### Create cron run

```
POST /agents/:id/crons/:cronId/runs
```

Body:

| Field | Required | Description |
|-------|----------|-------------|
| `startedAt` | yes | ISO timestamp when the run started |
| `skipped` | no | `true` if the pre-check returned false |
| `skipReason` | no | Reason the run was skipped |
| `outcome` | no | `"success"` or `"error"` |

Returns `201` with the created run record.

### List cron runs

```
GET /agents/:id/crons/:cronId/runs
```

Query params: `limit` (default 20), `offset` (default 0). Returns `{ items: AgentCronRun[], total: number }`.

Each run record includes: `id`, `cronId`, `agentId`, `startedAt`, `completedAt`, `skipped`, `skipReason`, `outcome`, `error`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd`, `model`.

### Update cron run

```
PATCH /agents/:id/crons/:cronId/runs/:runId
```

Used to record completion data after a run finishes. Updatable fields: `completedAt`, `outcome`, `error`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd`, `model`. Returns the updated run.

### Cron run stats

```
GET /agents/all/cron-runs/stats
```

Admin-only. Aggregated token stats across all agents. Query params: `from` and `to` (optional ISO datetimes).

Returns:

```json
{
  "totals": { "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheCreationTokens": 0, "costUsd": 0 },
  "byAgent": { "<agentId>": { ... } },
  "byCron": { "<cronId>": { ... } },
  "byModel": { "<modelId>": { ... } },
  "daily": [{ "date": "YYYY-MM-DD", ... }]
}
```

---

## Tools (allowed-tools list)

The allowed-tools list controls which Claude Code tools the agent can call.

### Add tool

```
POST /agents/:id/tools
```

Body: `{ pattern: string, enabled?: boolean }`. Pattern is a glob or exact tool name (e.g. `"Read"`, `"Bash"`, `"mcp__*"`). Returns `201`.

### List tools

```
GET /agents/:id/tools
```

Returns `{ tools: AgentTool[] }` where each entry has `id`, `pattern`, and `enabled`.

### Update tool

```
PATCH /agents/:id/tools/:toolId
```

Body: `{ pattern?: string, enabled?: boolean }`. Returns the updated tool.

### Delete tool

```
DELETE /agents/:id/tools/:toolId
```

Returns `204`.

---

## API tokens

Per-agent bearer tokens for scoped API access. The raw token is returned once at creation; only its SHA-256 hash is stored.

### Create token

```
POST /agents/:id/tokens
```

Body (optional): `{ label?: string }`. Returns `201` with `{ id, label, createdAt, revokedAt, token }` where `token` is the raw value — save it immediately.

### List tokens

```
GET /agents/:id/tokens
```

Returns `{ tokens: AgentToken[] }` with hash and metadata. Raw token values are never returned after creation.

### Revoke token

```
DELETE /agents/:id/tokens/:tokenId
```

Soft-deletes the token (sets `revokedAt`). Returns `204`.

---

## Plugins

Plugins are Claude Code marketplace plugins installed for the agent.

### Install plugin

```
POST /agents/:id/plugins
```

Body: `{ name: string, version?: string, enabled?: boolean }`. Returns `201`.

### List plugins

```
GET /agents/:id/plugins
```

Returns `{ plugins: AgentPlugin[] }`.

### Update plugin

```
PATCH /agents/:id/plugins
```

Query param: `name` (required). Body: `{ version?: string, enabled?: boolean }`. Returns the updated plugin.

### Remove plugin

```
DELETE /agents/:id/plugins
```

Query param: `name` (required). Returns `204`.

---

## Chat token usage

Daily aggregate of Slack chat session token usage.

### Record daily usage

```
POST /agents/:id/chat-tokens/daily
```

Atomic upsert — accumulates usage into the existing rows for `(agentId, date, model)` tuples if they exist. When a single day spans multiple models (e.g., agent tools using different Claude versions), supply a `modelBreakdown` array to split usage by model.

Body:

| Field | Required | Description |
|-------|----------|-------------|
| `date` | yes | `YYYY-MM-DD` |
| `modelBreakdown` | yes | Array of per-model usage entries. Each entry: `{ model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheCreationTokens: number, costUsd?: number }` |

Returns an array of updated daily rows (one per model in the breakdown).

### Chat token stats

```
GET /agents/chat-tokens/daily/stats
```

Admin-only. Aggregated chat-token daily stats across all agents broken down by model. Query params: `from` and `to` (optional `YYYY-MM-DD` date strings).

Returns `{ totals, byAgent, byModel, daily }` where each aggregate includes `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, and `costUsd`.

---

## Runtime config

```
GET /agents/:id/config
```

Used by the agent harness on startup and during the config sync loop. Returns the agent's full config bundle:

- `env` — decrypted key/value env vars
- `allowedTools` — array of tool patterns
- `plugins` — installed plugins with derived marketplace URLs

Returns `404` if the agent doesn't exist.
