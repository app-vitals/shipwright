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

Cron runs record each execution of a cron job, including token usage, cost, and telemetry. `POST`/`GET /agents/:id/crons/:cronId/runs` and `PATCH .../runs/:runId` are fully described in the spec.

**Telemetry fields** (nullable; populated by agent builds with prompt-audit support, older builds leave these unset): first-turn context baseline (`baselineModel`, `baselineContextTokens`, `baselineInputTokens`, `baselineCacheCreationTokens`, `baselineCacheReadTokens` — the measured always-loaded context independent of cache warmth), run-level counts (`turns` distinct usage-bearing assistant turns, `toolCalls` distinct tool_use blocks), content fingerprinting (`contextFingerprint` sha256[:12] grouping runs by what the model was given, `pluginVersion`, `claudeCodeVersion`), and per-skill attribution (separate `skillUsage` rows per skill/subagent, tracking invocations, turns, token breakdown per skill, and the context delta on first invoke). See `admin/src/agent-cron-runs.ts` for the `PatchAgentCronRunInput` shape (fields `contextBaseline`, `turns`, `toolCalls`, `contextFingerprint`, `pluginVersion`, `claudeCodeVersion`, `skillUsage`).

`skipReason` follows a `{command}:{category}:{reason}[:{detail}]` taxonomy (STD-1.1) rather than free text. On a `[silent]`-marker dispatch it's populated from the dispatched command's own `[skip-reason:text]` marker when present (DBV-1.1), falling back to `"command:no-work"` otherwise. No category is exempt (SRB-1.1): every skip reason, including `deferred` ones, is forwarded to the task store's reason-aware streak counter, so only the same reason repeating three times in a row auto-blocks — see `agent/src/markers.ts` and `agent/src/loop-orchestrator.ts`.

### Cron run stats

```
GET /agents/all/cron-runs/stats
```

Admin-only, described in the spec. One nuance: `byPhase` excludes runs with no phase attribution (legacy five-job crons, runs dispatched without a phase cron) from that dimension only — those runs still count toward `totals` and every other breakdown (`byAgent`, `byCron`, `byModel`, `byCronModel`, `daily`). `bySkill` (per `(kind, name)` skill/subagent usage) excludes skipped runs; `baselines` (first-turn context baseline per `(contextFingerprint, baselineModel, phase)`, ordered by first appearance) includes skipped runs but excludes runs that reported no baseline. Both are empty arrays when nothing was reported.

---

## Related

- Core agent CRUD, authentication, env vars, runtime config: [`docs/agent-api.md`](./agent-api.md)
- Allowed-tools, API tokens, plugins, chat token usage, work-queue snapshot: [`docs/agent-api-resources.md`](./agent-api-resources.md)
