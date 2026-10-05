# Agent Admin API — Agent Resources

Per-agent resource endpoints for the [Agent Admin API](./agent-api.md): the allowed-tools list, API tokens, plugins, chat token usage, the work-queue snapshot, and the GitHub installations snapshot. See [`docs/agent-api.md`](./agent-api.md) for core agent CRUD, authentication, environment variables, and runtime config, and [`docs/agent-api-ops.md`](./agent-api-ops.md) for cron jobs and cron runs.

Base path: `/agents` (same resource as the core API — these are additional routes under it).

---

## Tools (allowed-tools list)

The allowed-tools list controls which Claude Code tools the agent can call.

### Add tool

```
POST /agents/:id/tools
```

Body: `{ pattern: string }`. Pattern is a glob or exact tool name (e.g. `"Read"`, `"Bash"`, `"mcp__*"`). The tool is created enabled. Returns `201`.

### List tools

```
GET /agents/:id/tools
```

Returns `{ tools: AgentTool[] }` where each entry has `id`, `pattern`, and `enabled`.

### Update tool

```
PATCH /agents/:id/tools/:toolId
```

Body: `{ enabled: boolean }` (required). Returns the updated tool.

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

Body (optional): `{ label?: string }`. Returns `201` with `{ token: { id, agentId, label, createdAt, revokedAt }, rawToken }` where `rawToken` is the raw value — save it immediately.

### List tokens

```
GET /agents/:id/tokens
```

Returns `{ tokens: AgentToken[] }` (metadata only — the hash is never returned). Raw token values are never returned after creation.

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

Body: `{ name: string, version?: string | null }`. The plugin is installed enabled. Returns `201`.

### List plugins

```
GET /agents/:id/plugins
```

Returns `{ plugins: AgentPlugin[] }`.

### Update plugin

```
PATCH /agents/:id/plugins
```

Query param: `name` (required). Body: `{ version?: string | null }`. Returns the updated plugin.

### Remove plugin

```
DELETE /agents/:id/plugins
```

Query param: `name` (required). Returns `204`.

---

## Phase Methodology

Per-phase subagent-type overrides control which subagent type handles each pipeline phase (prd, plan-session, review, patch, deploy, dev-task) for a given agent. By default, each phase uses its global default methodology; setting an override causes that phase to use a custom subagent type instead.

### List phase-methodology overrides

```
GET /agents/:id/phase-methodology
```

Returns `{ phaseMethodology: AgentPhaseMethodology[] }` — an array of only the phases with explicit overrides. Phases not in this list are using their default methodology. To see all six phases with defaults filled in, use `GET /agents/:id/config` instead, which returns the full `phaseMethodology` map.

### Set a phase's subagent-type override

```
PUT /agents/:id/phase-methodology/{phase}
```

Upserts the `subagentType` override for one pipeline phase. `phase` must be one of `prd`, `plan-session`, `review`, `patch`, `deploy`, or `dev-task`.

Body: `{ subagentType: string | null }`. When `subagentType` is `null`, the override is cleared and the phase falls back to its default methodology.

Returns `200` with `{ phaseMethodology: AgentPhaseMethodology }` containing the upserted row.

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
| `modelBreakdown` | yes | Array of per-model usage entries. Each entry: `{ model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheCreationTokens: number, costUsd: number }` |

Returns an array of updated daily rows (one per model in the breakdown).

### Chat token stats

```
GET /agents/chat-tokens/daily/stats
```

Admin-only. Aggregated chat-token daily stats across all agents broken down by model. Query params: `from` and `to` (optional `YYYY-MM-DD` date strings).

Returns `{ totals, byAgent, byModel, daily }` where each aggregate includes `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, and `costUsd`.

---

## Work queue snapshot

One row per agent, holding the agent's most recently pushed ranked view of its pending work (tasks/PRs across pipeline phases). There is no history — each push overwrites the prior snapshot.

### Push snapshot

```
POST /agents/:id/work-queue
```

Body:

| Field | Required | Description |
|-------|----------|-------------|
| `computedAt` | yes | ISO timestamp when the agent computed this ranking |
| `items` | yes | Array of ranked work items. Each entry: `{ type: "task" \| "pr", id: string, title?: string, phase: "dev-task" \| "plan" \| "review" \| "patch" \| "deploy", age: string }` (`age` is an ISO timestamp) |

Upserts the single row for this `agentId`, overwriting any prior snapshot. Returns `200` with:

```json
{
  "snapshot": {
    "id": "string",
    "agentId": "string",
    "computedAt": "ISO timestamp",
    "items": [{ "type": "task|pr", "id": "string", "title": "string (optional)", "phase": "dev-task|plan|review|patch|deploy", "age": "ISO timestamp" }],
    "createdAt": "ISO timestamp"
  }
}
```

### Get snapshot

```
GET /agents/:id/work-queue
```

Returns `200` with the latest pushed snapshot in the same `{ snapshot: { id, agentId, computedAt, items, createdAt } }` format, or `404` if the agent has never pushed one.

---

## GitHub installations snapshot

One row per agent, holding the agent's most recently reported GitHub App installations. Replace-all: each `PUT` overwrites the stored list wholesale, so an installation absent from the latest body is dropped. The row is deleted when the agent is deleted. Auth is the same as the work-queue routes: an admin key/session, or the agent's own bearer token (a token owned by a different agent gets `403`).

### Put snapshot

```
PUT /agents/:id/github-installations
```

Body (closed schema — any unknown field, such as a token, is rejected with `400`):

| Field | Required | Description |
|-------|----------|-------------|
| `reportedAt` | yes | ISO timestamp when the agent reported this list |
| `installations` | yes | Array of `{ owner: string, installationId: positive integer, state: string (max 50), lastError?: string \| null (max 500, sanitized) }`; each entry is also closed |

Returns `200` with:

```json
{
  "snapshot": {
    "id": "string",
    "agentId": "string",
    "reportedAt": "ISO timestamp",
    "installations": [{ "owner": "string", "installationId": 123, "state": "string", "lastError": "string (optional)" }],
    "createdAt": "ISO timestamp"
  }
}
```

### Get snapshot

```
GET /agents/:id/github-installations
```

Returns `200` with the latest snapshot in the same `{ snapshot: { ... } }` format, or `404` if the agent has never reported one.
