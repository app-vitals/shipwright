# Shipwright Agent

> Coding half of the agent reference. The platform half (run modes, HTTP surfaces, the core data model) is the vendored snapshot [`docs/platform/agent.md`](./platform/agent.md), sourced from `app-vitals/agent`; this page keeps only what is specific to Shipwright's coding agent.

## Admin CRUD API additions

| Resource | Endpoints |
|---|---|
| Work Queue | `POST /agents/:id/work-queue` (pushes/upserts the agent's ranked work-queue snapshot, overwriting any prior snapshot; body: `{computedAt, items}`), `GET /agents/:id/work-queue` (fetches the latest snapshot; `404` if none pushed yet) |

## Data model additions

| Model | Owns | Notable fields |
|---|---|---|
| `AgentPhaseMethodology` | Per-phase subagent-type override | `agentId`, `phase` (one of `prd`, `plan-session`, `review`, `patch`, `deploy`, `dev-task`), `subagentType` (nullable — when null, the phase uses its default methodology; when set, specifies which subagent type handles that phase), `updatedAt`; unique per `[agentId, phase]`. Managed by `AgentPhaseMethodologyService` (list, upsert). Enables per-agent customization of which subagent type handles each pipeline phase, overriding the global defaults. |
| `AgentWorkQueueSnapshot` | Latest ranked work-queue snapshot | `agentId` (unique — one row per agent), `computedAt`, `items` (JSON `RankedWorkItem[]`). Upserted by `POST /agents/:id/work-queue`; overwrites any prior snapshot — there is no history, only the latest state. |
| `SessionFollow` | User session follow tracking | `id` (CUID), `userEmail`, `sessionSlug`, `muted` (boolean, defaults to false; allows a user to follow a session while suppressing alerts), `createdAt`, `updatedAt`; unique per `[userEmail, sessionSlug]`. The `muted` flag allows idempotent follow behavior — re-following a muted session un-mutes it. Deletion removes the session from the user's follow list entirely. |
| `SessionAlertState` | Session alert cooldown tracking | `id` (CUID), `userEmail`, `sessionSlug`, `lastAlertedAt` (nullable datetime, tracks when a user was last alerted about this session), `createdAt`, `updatedAt`; unique per `[userEmail, sessionSlug]`. Used by reminder jobs to avoid re-alerting the same user/session pair within a cooldown window. |

## Key Files

Per-file reference table for `admin/src` and `agent/src` — see [agent-key-files.md](./agent-key-files.md).
