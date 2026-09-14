# Agent Admin API — Operations

Scheduling and execution-history endpoints for the [Agent Admin API](./agent-api.md): cron jobs and cron runs. See [`docs/agent-api.md`](./agent-api.md) for core agent CRUD, authentication, environment variables, and runtime config, and [`docs/agent-api-resources.md`](./agent-api-resources.md) for the allowed-tools list, API tokens, plugins, chat token usage, and the work-queue snapshot.

Base path: `/agents` (same resource as the core API — these are additional routes under it).

**Full endpoint reference** — every route, parameter, request/response shape, and status code — lives in the generated [`admin/openapi.json`](../admin/openapi.json) spec. **Practical usage** lives in the [`agent-admin`](../plugins/shipwright/skills/agent-admin/SKILL.md) skill.

This page covers only behavioral nuance the spec doesn't carry.

---

## Cron jobs

`POST`/`GET`/`PATCH`/`DELETE /agents/:id/crons[/:cronId]`, `POST /agents/:id/crons/reconcile`, and `GET /agents/:id/crons/summary` are fully described in the spec — including the create/update field constraints and the three-pass reconcile algorithm (create-or-update matched-by-name, link/unlink `parentCronId`, delete orphans).

One nuance the spec doesn't carry: reconcile's parent-linking (Pass 2) self-heals in **both** directions on every call — a manifest entry that gains a `parentCron` declaration sets `parentCronId` even if the row previously had none, and one that loses its `parentCron` declaration clears an existing `parentCronId` back to `null`. `parentCronId` itself is always system-managed and never settable through the create/update routes.

---

## Cron runs

Cron runs record each execution of a cron job, including token usage and cost. `POST`/`GET /agents/:id/crons/:cronId/runs` and `PATCH .../runs/:runId` are fully described in the spec.

`skipReason` follows a `{command}:{category}:{reason}[:{detail}]` taxonomy (STD-1.1) rather than free text. On a `[silent]`-marker dispatch it's populated from the dispatched command's own `[skip-reason:text]` marker when present (DBV-1.1), falling back to `"command:no-work"` otherwise. Skip reasons with a `deferred` category segment are exempt from `SKIP_BLOCK_THRESHOLD` counting, so a legitimate defer (e.g. waiting on a dependency) doesn't trip auto-blocking the way a genuine no-op would — see `agent/src/markers.ts` and `agent/src/loop-orchestrator.ts`.

### Cron run stats

```
GET /agents/all/cron-runs/stats
```

Admin-only, described in the spec. One nuance: `byPhase` excludes runs with no phase attribution (legacy five-job crons, runs dispatched without a phase cron) from that dimension only — those runs still count toward `totals` and every other breakdown (`byAgent`, `byCron`, `byModel`, `byCronModel`, `daily`).

---

## Related

- Core agent CRUD, authentication, env vars, runtime config: [`docs/agent-api.md`](./agent-api.md)
- Allowed-tools, API tokens, plugins, chat token usage, work-queue snapshot: [`docs/agent-api-resources.md`](./agent-api-resources.md)
