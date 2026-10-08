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

`skipReason` follows a `{command}:{category}:{reason}[:{detail}]` taxonomy (STD-1.1) rather than free text. On a `[silent]`-marker dispatch it's populated from the dispatched command's own `[skip-reason:text]` marker when present (DBV-1.1), falling back to `"command:no-work"` otherwise. No category is exempt (SRB-1.1): every skip reason, including `deferred` ones, is forwarded to the task store's reason-aware streak counter, so only the same reason repeating three times in a row auto-blocks — see `agent/src/markers.ts` and `agent/src/loop-orchestrator.ts`.

### Cron run stats

```
GET /agents/all/cron-runs/stats
```

Admin-only, described in the spec. One nuance: `byPhase` excludes runs with no phase attribution (legacy five-job crons, runs dispatched without a phase cron) from that dimension only — those runs still count toward `totals` and every other breakdown (`byAgent`, `byCron`, `byModel`, `byCronModel`, `daily`).

Two dimensions feed the prompt-audit patrol (the metrics that make a markdown change measurable):

- **`bySkill`** — per-skill / per-subagent token attribution, summed over `AgentCronRunSkillUsage` rows. `kind` is `skill` (a plugin skill invoked via the `Skill` tool, named as invoked, e.g. `shipwright:task-store`), `agent` (a subagent type invoked via the `Agent` tool), or `root` (turns before any skill was invoked). Attribution is last-wins: every turn after an invoke is charged to the most recently invoked skill, because a skill body stays in the conversation for the rest of the session. `avgInvokeContextDelta` is the mean of each row's `invokeContextDelta` — the `input + cacheCreation` of the first usage-bearing turn after the skill's first invoke, i.e. the new context admitted when its body loaded. Skipped runs are excluded, like every other token dimension.
- **`baselines`** — the always-loaded-context series: one row per (`contextFingerprint`, `baselineModel`, `phase`) with the distribution of `baselineContextTokens` (the first assistant turn's `input + cacheCreation + cacheRead`, which is the full context the model saw before any work — system prompt, tool schemas, CLAUDE.md/rules, the skill listing, the cron prompt — independent of cache warmth), plus `avgTurns` / `avgToolCalls` and the first/last `startedAt`. Rows are ordered by first appearance. Skipped runs are **included** here (a `[silent]` dispatch still paid its first-turn context), while runs with no baseline (resumed sessions, older agent builds) are left out. Two runs with the same `contextFingerprint` were given the same always-loaded text (`agent/src/context-stamp.ts`: sha256 over the workspace `CLAUDE.md`, its `@` imports, no-`paths` rules, and the plugin version), so a CLAUDE.md edit shows up as a new fingerprint and its before/after rows are the measurement.

### Cron run telemetry fields

`PATCH .../runs/:runId` also accepts, and `GET` returns, the per-run telemetry the agent derives from the Claude CLI stream (`agent/src/run-telemetry.ts`): `contextBaseline` (spread onto the `baseline*` columns), `turns`, `toolCalls`, `contextFingerprint`, `pluginVersion`, `claudeCodeVersion`, and `skillUsage` (upserted per `[cronRunId, kind, name]`, in the same transaction as `modelBreakdown`). All are additive and nullable: an agent build that predates them reports nothing and every column stays null. A resumed session (`-r`) reports counts and attribution but no `contextBaseline`, since its first turn replays prior history rather than a cold always-loaded context.

---

## Related

- Core agent CRUD, authentication, env vars, runtime config: [`docs/agent-api.md`](./agent-api.md)
- Allowed-tools, API tokens, plugins, chat token usage, work-queue snapshot: [`docs/agent-api-resources.md`](./agent-api-resources.md)
