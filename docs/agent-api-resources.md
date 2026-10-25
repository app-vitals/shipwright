# Agent Admin API — Agent Resources

> Coding half. The platform half is the vendored snapshot [`docs/platform/agent-api-resources.md`](./platform/agent-api-resources.md), sourced from `app-vitals/agent`.

Per-agent resource endpoints for the [Agent Admin API](./agent-api.md): the allowed-tools list, API tokens, plugins, chat token usage, the work-queue snapshot, and the GitHub installations snapshot. See [`docs/agent-api.md`](./agent-api.md) for core agent CRUD, authentication, environment variables, and runtime config, and [`docs/agent-api-ops.md`](./agent-api-ops.md) for cron jobs and cron runs.

Base path: `/agents` (same resource as the core API — these are additional routes under it).

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
