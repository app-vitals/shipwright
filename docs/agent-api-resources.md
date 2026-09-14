# Agent Admin API — Agent Resources

Per-agent resource endpoints for the [Agent Admin API](./agent-api.md): the allowed-tools list, API tokens, plugins, chat token usage, and the work-queue snapshot. See [`docs/agent-api.md`](./agent-api.md) for core agent CRUD, authentication, environment variables, and runtime config, and [`docs/agent-api-ops.md`](./agent-api-ops.md) for cron jobs and cron runs.

Base path: `/agents` (same resource as the core API — these are additional routes under it).

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
