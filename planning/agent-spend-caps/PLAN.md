# Agent Spend Caps — Plan

**Session**: agent-spend-caps
**Repo**: app-vitals/shipwright
**Spec**: `planning/agent-spend-caps/PRODUCT-SPEC.md`

## Technical Design

Four tasks, additive-only throughout — every existing agent with no cap configured must see zero behavior change.

**ASC-1.1** builds `getAgentSpend()` in `admin/src`, summing `AgentChatTokenUsageDailyByModel` and `AgentCronRunModelBreakdown`. Its acceptance criteria require resolving the `Task.costUsd` overlap question (spec Feature 1) as part of the work, not deferring it — the implementing session must read `task-store`'s cost-write path and `agent/src/cron-run-reporter.ts` closely enough to state definitively whether they double-count before finalizing the sum.

**ASC-2.1** adds `Agent.dailySpendCapUsd`/`monthlySpendCapUsd` (both nullable) and wires them through the existing agent PATCH/GET route. Independent of ASC-1.1 — no shared files, runs in parallel.

**ASC-3.1** is the highest-risk task in this plan: it hooks the cap check into `agent/src/loop-orchestrator.ts`'s dispatch path, the code every production Shipwright agent runs through on every tick, including this repository's own agents. It depends on both ASC-1.1 (needs `getAgentSpend()`) and ASC-2.1 (needs the cap fields to read). Its acceptance criteria are deliberately strict: fail-open on any aggregation error, zero query overhead for agents with no cap configured, and a full run of the existing `loop-orchestrator` test suite with no regressions before the task is considered done.

**ASC-4.1** documents the new fields and the fail-open guarantee; depends on ASC-3.1 so the documented behavior matches what actually shipped.

No renames or removals — all four tasks are additive. Safe to deploy standalone: yes, for every task.

## Task Table

| ID | Title | Layer | Branch | Depends on | Hours | Complexity | Model | HITL |
|----|-------|-------|--------|------------|-------|------------|-------|------|
| ASC-1.1 | Add unified per-agent spend aggregation (getAgentSpend + read API) | API | feat/asc-1-1-spend-aggregation | — | 4 | 4 | sonnet | |
| ASC-2.1 | Add per-agent daily/monthly spend cap fields to schema + admin API | Database | feat/asc-2-1-spend-cap-fields | — | 2 | 2 | sonnet | |
| ASC-3.1 | Enforce spend caps in the shipwright-loop dispatcher (fail-open) | Background | feat/asc-3-1-dispatch-enforcement | ASC-1.1, ASC-2.1 | 4 | 5 | opus | |
| ASC-4.1 | Document spend cap fields and fail-open behavior | Docs | feat/asc-4-1-docs | ASC-3.1 | 1 | 1 | haiku | |

## Dependency Map

```
[START]
  ├─ ASC-1.1: spend aggregation (no deps)
  ├─ ASC-2.1: cap schema fields (no deps)
  │
  └─ ASC-3.1: dispatch enforcement (needs 1.1, 2.1)
        └─ ASC-4.1: docs (needs 3.1)
```

```
Task     | Depends on    | Blocks | HITL
ASC-1.1  | —             | 3.1    |
ASC-2.1  | —             | 3.1    |
ASC-3.1  | 1.1, 2.1      | 4.1    |
ASC-4.1  | 3.1           | —      |
```

## Breaking Change Safety

All four tasks are additive (new nullable columns, new function, new route, new dispatch-path check that no-ops for agents with no cap set). Safe to deploy standalone: yes, for every task.

**Special note on ASC-3.1**: although structurally additive, this task modifies the live dispatch path for every running agent. Its acceptance criteria require the full existing `loop-orchestrator` suite to pass with zero regressions and explicitly test the no-cap-configured path shows no behavior change — this is the safety gate in lieu of a schema-level breaking-change concern.

## HITL Scan

No tasks matched the Type A keyword heuristic or judgment step (no cloud console, credential provisioning, or `.claude/**` changes) — all four are ordinary code changes executable by `dev-task`. `HITL scan: no tasks require human steps`. ASC-3.1's risk is handled via its complexity/model tier (5/opus) and strict regression-testing acceptance criteria, not via HITL routing.

## Decision Log

None — this session ran with a human (Dan, via this planning thread) providing the spec's Resolved Decisions directly; no autonomous-mode defaults were applied.
