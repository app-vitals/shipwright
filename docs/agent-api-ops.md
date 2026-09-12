# Agent Admin API — Operations

Operational and execution-surface endpoints for the [Agent Admin API](./agent-api.md): cron jobs, cron runs, the allowed-tools list, API tokens, plugins, chat token usage, and the work-queue snapshot. See [`docs/agent-api.md`](./agent-api.md) for core agent CRUD, authentication, environment variables, and runtime config.

Base path: `/agents` (same resource as the core API — these are additional routes under it).

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

Returns `201` with the created cron job, including read-only fields: `id`, `agentId`, `system`, `parentCronId`, `createdAt`, `updatedAt`. **`parentCronId` is system-managed** and never settable by the user — it is `null` for top-level crons, and set by the system for child crons that belong to a parent orchestration job (LPC-1.3).

### List cron jobs

```
GET /agents/:id/crons
```

Returns `{ crons: AgentCronJob[] }` where each cron includes a run summary (last run timestamp, outcome, today's run count), and the read-only `parentCronId` field (used by LPC-1.3 scheduler dispatch filtering to identify child "config-only" crons that should not be independently scheduled).

### Update cron job

```
PATCH /agents/:id/crons/:cronId
```

Body fields are the same as create, all optional. Constraints:

- `schedule` and `prompt` must be provided together when doing a content update
- `enabled` and `preCheck` are orthogonal — each can be sent alone or combined with any other field
- At least one field must be present (empty body returns `400`)
- `parentCronId` is never settable (read-only, ignored in request bodies)
- System crons (flagged `system=true`) cannot be updated — returns `403`

Returns the updated cron job with all read-only fields included (`parentCronId`, `system`, `createdAt`, `updatedAt`).

### Delete cron job

```
DELETE /agents/:id/crons/:cronId
```

Returns `204`. System crons (flagged `isSystem=true`) cannot be deleted — returns `403`.

### Reconcile system crons

```
POST /agents/:id/crons/reconcile
```

Reconciles the agent's system crons against the cron list declared by its agent type manifest (`agent-types/{typeName}/manifest.yaml`, resolved via the `AgentTypeRegistry`; an unknown `typeName` falls back to the `coding` manifest with a logged warning, so this boot-path call never fails). Called automatically on agent startup. Returns `200` with a summary:

```json
{
  "created": 0,
  "updated": 2,
  "deleted": 0
}
```

**How reconciliation works:**

The process runs in three passes within a single transaction for atomicity:

- **Pass 1 — Create or update:** For each system cron that already exists (matched by name), the endpoint updates it in place with the current definition from the manifest's `crons` array, preserving its ID and existing enabled state. Updating in place (rather than delete+recreate) keeps the cron's ID stable across agent restarts, so `AgentCronRun` history (linked by foreign key with cascade-delete) is never wiped out. Manifest crons that don't yet exist are created with their default enabled state. Each entry's resulting row ID is recorded in a name → id map as it proceeds.
- **Pass 2 — Link parents:** For each manifest cron entry that declares a `parentCron`, the endpoint resolves the parent's row ID from the name → id map and sets `parentCronId` on the child. If an entry does not declare a resolvable `parentCron`, any existing non-null `parentCronId` on that row is cleared back to `null`. This self-heals the parent/child link on every reconcile call in both directions — null→set (e.g., if it was previously null on a pre-existing row) and set→null (e.g., if a `parentCron` declaration is later removed from the manifest). The order of entries in the manifest's `crons` array does not matter — both parent and child are guaranteed to have been recorded in the map by Pass 1.
- **Pass 3 — Orphan cleanup:** System crons whose names are no longer in the manifest's `crons` array are deleted.

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
| `skipReason` | no | Reason the run was skipped. Follows a `{command}:{category}:{reason}[:{detail}]` taxonomy (STD-1.1). On a `[silent]`-marker dispatch, populated from the dispatched command's own `[skip-reason:text]` marker when present (DBV-1.1), falling back to the generic `"command:no-work"` literal when the command didn't tag a specific reason. Skip reasons with a `deferred` category segment (the second colon-delimited field) are exempt from `SKIP_BLOCK_THRESHOLD` counting, allowing legitimate defers (e.g., awaiting a dependency to complete) to be distinguished from genuine no-ops that trigger auto-blocking. See `agent/src/markers.ts` and `agent/src/loop-orchestrator.ts`. |
| `outcome` | no | `"success"` or `"error"` |
| `itemType` | no | Work item type this run was dispatched against (`"task"` or `"pr"`). Set by the unified `shipwright-loop` cron alongside `itemId`; null when the tick had no dispatch (skipped tick, empty queue). Write-once at creation — not accepted on the PATCH endpoint. |
| `itemId` | no | Work item id this run was dispatched against (e.g. `"WLS-2.2"` for a task, `"acme/x#123"` for a PR). Null when the tick had no dispatch. Write-once at creation — not accepted on the PATCH endpoint. |

Returns `201` with the created run record.

### List cron runs

```
GET /agents/:id/crons/:cronId/runs
```

Query params: `limit` (default 20), `offset` (default 0), `itemId` (optional; narrows to runs dispatched against this work item), `phaseId` (optional; narrows to runs dispatched by this phase cron). `itemId`/`phaseId` filter server-side via the Prisma `where` clause and can be combined (AND, not OR). Returns `{ items: AgentCronRun[], total: number }`.

Each run record includes: `id`, `cronId`, `agentId`, `startedAt`, `completedAt`, `skipped`, `skipReason`, `outcome`, `error`, `phaseId` (nullable; child `AgentCronJob` id (FK) of the pipeline phase this run served — dev-task/review/patch/deploy; null for legacy five-job crons or runs with no phase attribution), `itemType`, `itemId`, `sessionId` (nullable; Claude session id this cron run corresponds to), `createdAt`, `modelBreakdown` (per-model token and cost breakdown array, each entry: `{ model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd }`). Top-level token fields (`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheCreationTokens`/`model`) were dropped from `AgentCronRun` — all token accounting now lives on `modelBreakdown`. The legacy `phase` string field was replaced by a `phaseId` foreign key (LPC-3.1). Note: the resolved `phaseCron` relation (`{ id, name }`) is only included by `listForAgent()`, used by the HTML cron-logs page — not by this JSON endpoint.

### Update cron run

```
PATCH /agents/:id/crons/:cronId/runs/:runId
```

Used to record completion data after a run finishes. Updatable fields: `completedAt`, `outcome`, `error`, `skipped`, `skipReason`, `sessionId`, `modelBreakdown` (array of `{ model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd }` — upserted per `[cronRunId, model]`). The legacy top-level `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheCreationTokens`/`model` fields are still accepted for backward compatibility with older agent builds but are silently ignored (not persisted) — send `modelBreakdown` instead. Returns the updated run.

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
  "byCron": [{ "key1": "<agentId>", "key2": "<cronName>", "phase": "dev-task", ... }],
  "byModel": { "<modelId>": { ... } },
  "byCronModel": [{ "key1": "<agentId>:<cronName>", "key2": "<model>", "phase": "dev-task", ... }],
  "daily": [{ "date": "YYYY-MM-DD", ... }],
  "byPhase": [{ "key": "<phase>", ... }]
}
```

`byCron` and `byCronModel` rows include a `phase` field (populated from the `phaseCron.name` relation, e.g., "dev-task"/"review"/"patch"/"deploy") for runs that have a `phaseId`, or `null` for runs with no phase attribution (legacy five-job crons and runs dispatched without a phase cron). `byPhase` groups token stats by the resolved phase cron name; runs with no phase attribution are excluded from this dimension only — they still count toward `totals` and the other dimensions.

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
