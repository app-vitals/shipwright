# Agent Spend Caps — Product Specification

**Date**: 2026-09-24
**Session**: agent-spend-caps
**Status**: Draft
**Repo**: `app-vitals/shipwright`

## Overview

A per-agent, admin-configurable daily and monthly LLM spend ceiling that halts the `shipwright-loop` autonomous dispatch cycle once crossed, with a Slack alert on the transition. This is the first of several PRDs supporting a longer-term goal (free trial hosting of Shipwright Managed for course students, not itself in scope here) — but it stands on its own as a real gap for any Shipwright deployment: today nothing stops a misconfigured or runaway agent from spending without limit.

## Problem Statement

Shipwright already tracks LLM cost at multiple granularities (per-task `costUsd` in the task store, per-cron-run model breakdowns and per-agent daily chat usage in the admin service) but nothing reads that data to stop or throttle an agent. An agent can run its `shipwright-loop` cron indefinitely — dispatching `dev-task`/`review`/`patch`/`deploy` every tick — with no ceiling on cumulative spend. There is no existing budget/cost-cap mechanism anywhere in the codebase (confirmed by search — the only "budget" hits in `agent/src` are LVB, the unrelated wall-clock/process-tree verification-timeout system, not LLM spend).

## Users & Context

- **Agent operator** (admin API/UI user): sets an optional daily and/or monthly spend cap on an agent, the same way they'd configure a cron schedule or tool allowlist today.
- **The `shipwright-loop` cron itself**: on each tick, before dispatching a phase command, checks whether the agent is over its configured cap and skips dispatch if so.
- **Whoever's watching Slack**: gets a single alert when an agent crosses its cap, via the existing per-agent alerts-channel path.

---

## Features

### Feature 1: Unified per-agent spend aggregation

**Priority**: High
**Description**: A single function that computes an agent's total LLM spend for "today" and "this month," summing across the existing cost-tracking sources so a cap check has one number to compare against.

**User Stories**:
- As the spend-cap enforcement check, I want one function that returns an agent's spend-to-date so I don't have to know about every underlying cost table.

**Requirements**:
- New function, e.g. `getAgentSpend(agentId, { since: Date }): Promise<{ totalUsd: number }>`, in `admin/src` (co-located with the existing `agent-chat-tokens.ts` aggregation it builds on).
- Sums `AgentChatTokenUsageDailyByModel` (existing `queryStats()` pattern in `admin/src/agent-chat-tokens.ts:123-195`) and `AgentCronRunModelBreakdown` (`admin/prisma/schema.prisma:221-233`) for the given agent and date range.
- **Before writing the sum, verify whether `Task.costUsd` (task-store) double-counts against `AgentCronRunModelBreakdown` (admin) for the same dev-task/review/patch/deploy dispatch** — these appear to be two independent cost-recording paths (task-store records PR-level cost via a generic PATCH from the dev-task command itself; admin records cron-run-level cost via `agent/src/cron-run-reporter.ts`) and the relationship between them is not yet confirmed. If they double-count, only one should feed the aggregation; if they cover genuinely distinct spend (e.g. task-store misses non-task cron activity, or vice versa), both are needed. This is a plan-session exploration item, not resolved here.
- Exposed via a new read-only admin API endpoint, e.g. `GET /agents/:id/spend?range=today|month`, for both the enforcement check and future UI use.

**Acceptance Criteria**:
- [ ] `getAgentSpend()` returns a correct sum for a fixture agent with cost rows in both `AgentChatTokenUsageDailyByModel` and `AgentCronRunModelBreakdown`, verified against a hand-computed expected total
- [ ] `GET /agents/:id/spend?range=today` and `range=month` return distinct, correct totals for the same fixture
- [ ] An agent with zero cost rows returns `{ totalUsd: 0 }`, not an error

**Technical Considerations**: This is a read aggregation over existing tables — no schema migration for this feature. The `Task.costUsd` vs. `AgentCronRunModelBreakdown` overlap question above is a real open question; whichever way it resolves, the aggregation must not silently double-count.

**Source Map**:
- `admin/src/agent-chat-tokens.ts` — existing `queryStats()` pattern to extend/reuse (lines 123-195)
- `admin/prisma/schema.prisma` — `AgentChatTokenUsageDailyByModel` (240-255), `AgentCronRunModelBreakdown` (221-233)
- `task-store/prisma/schema.prisma:126-130` — `Task.costUsd` and related columns, for the double-count check
- `agent/src/cron-run-reporter.ts:12-19` — where `AgentCronRunModelBreakdown` rows are written

**Testing Strategy**: Layer: integration — real Postgres fixture rows across both tables, verifying the aggregation sums correctly and handles the zero-cost case.

---

### Feature 2: Per-agent spend cap configuration

**Priority**: High
**Description**: Two new optional numeric fields on `Agent` — a daily and a monthly USD ceiling — settable via the existing admin API PATCH path, alongside other per-agent scalar config.

**User Stories**:
- As an operator, I want to set a $20/day cap on a specific agent so it can never run away on spend, the same way I'd toggle a cron on or off.

**Requirements**:
- `Agent.dailySpendCapUsd Float?` and `Agent.monthlySpendCapUsd Float?`, both nullable, default `null` (unset = no cap, current behavior unchanged for every existing agent).
- Both fields editable via the existing `PATCH /agents/:id` route, alongside the other scalar `Agent` fields already handled there.
- Both fields returned by `GET /agents/:id`.

**Acceptance Criteria**:
- [ ] `PATCH /agents/:id` with `{ "dailySpendCapUsd": 20 }` persists and is returned by a subsequent `GET /agents/:id`
- [ ] An agent created with no cap fields set has both fields `null`, and existing `GET`/`PATCH` behavior for all other fields is unchanged
- [ ] Setting a cap to `null` explicitly clears it (removes the cap)
- [ ] Prisma migration is additive only — no existing column is modified, renamed, or made required

**Technical Considerations**: Follows the existing pattern for adding a scalar `Agent` field (see `admin/prisma/schema.prisma:25-53` for the current field list) — no new relation, no new model.

**Source Map**:
- `admin/prisma/schema.prisma:25-53` — `Agent` model scalar fields
- Admin API's existing agent PATCH/GET handler (wherever `Agent` scalar fields are currently read/written — dev-task should locate this by grepping the existing field list, e.g. `restrictSlackToMembers`, during Step 2 codebase exploration)

**Testing Strategy**: Layer: smoke — HTTP route contract test via in-process `app.request()`, extending whatever existing smoke suite covers `PATCH /agents/:id`.

---

### Feature 3: Cap enforcement in the loop dispatcher

**Priority**: High
**Description**: Before `shipwright-loop` dispatches a phase command for an agent with a configured cap, check today's and this month's spend against the cap; skip the dispatch if either is exceeded.

**User Stories**:
- As an agent operator, I want my configured cap to actually stop the loop from spending further once crossed, not just be a number nobody reads.

**Requirements**:
- Hook the check into `agent/src/loop-orchestrator.ts`'s `dispatchItem()` (around line 764-784, before the `PHASE_COMMANDS[phase]` invocation at 780-784) — or at the top of `runLoopTick()` (line 1361) if a single check per tick is preferable to a per-item check. Prefer the per-tick placement unless Step 2 exploration finds a reason multiple items can be selected and dispatched within a single tick.
- If the agent has `dailySpendCapUsd` or `monthlySpendCapUsd` set, call Feature 1's `getAgentSpend()` for both ranges; if either configured cap is met or exceeded, skip dispatch for this tick.
- **Fail open on aggregation error**: if `getAgentSpend()` throws or the query fails, log the error and proceed with normal dispatch — a broken cost query must never halt the production fleet. This is a hard requirement, not a nice-to-have, given every existing agent runs through this same code path.
- An agent with no cap configured (both fields `null`) takes the existing, unmodified dispatch path — the spend query is not even called, so there is zero behavior or performance change for agents that don't opt in.
- On the tick where the cap is first crossed (a state transition from under-cap to over-cap, not every subsequent tick), send one Slack alert via the existing per-agent alerts-channel path (`agent/src/cron-handler.ts:298-309` pattern) naming the agent, the cap type (daily/monthly), the configured limit, and the current spend.

**Acceptance Criteria**:
- [ ] An agent with `dailySpendCapUsd: 20` and `getAgentSpend()` returning `{ totalUsd: 25 }` for today has its dispatch skipped for that tick
- [ ] An agent with no cap fields set dispatches exactly as it does today — verified by a test asserting `getAgentSpend()` is never called for such an agent
- [ ] A simulated `getAgentSpend()` rejection does not prevent dispatch — the tick proceeds as if no cap were configured, and the error is logged
- [ ] The Slack alert fires exactly once across consecutive over-cap ticks (verified by asserting no duplicate alert on a second over-cap tick immediately following the first), not once per tick
- [ ] Test decision: unit tests for the cap-comparison and state-transition logic in isolation; an integration test for the `dispatchItem`/`runLoopTick` skip behavior using an injected `getAgentSpend` double (not real Postgres) per this repo's test-isolation rule (no `mock.module()`, inject via DI)

**Technical Considerations**: This is the highest-risk change in this spec — it sits directly in the dispatch path every existing production agent runs through, including this agent (Doc) itself. The fail-open requirement above is the primary safety mechanism; the opt-in-by-null-default is the secondary one. `dev-task` implementing this task should run the full existing `loop-orchestrator` test suite and confirm zero regressions for the no-cap-configured path before considering this done.

**Source Map**:
- `agent/src/loop-orchestrator.ts` — `runLoopTick()` (~line 1361), `dispatch()` (~line 1326), `dispatchItem()` (~line 764, `PHASE_COMMANDS[phase]` call at 780-784)
- `agent/src/cron-handler.ts:298-309` — existing Slack alert pattern to reuse

**Testing Strategy**: Layer: integration — `loop-orchestrator`'s existing test doubles/fixtures for dispatch, extended with an injected spend-check double per this repo's hard no-`mock.module()` isolation rule.

---

### Feature 4: Documentation

**Priority**: Low
**Description**: Document the new fields and behavior so an operator configuring an agent knows the caps exist.

**Requirements**:
- Add `dailySpendCapUsd`/`monthlySpendCapUsd` to the admin CRUD API reference (`docs/agent-api.md` or wherever the `Agent` field reference lives).
- Note the fail-open behavior explicitly in the docs, so an operator understands a cap is a best-effort ceiling, not a hard guarantee against a tracking-layer outage.

**Acceptance Criteria**:
- [ ] The relevant docs file lists both new fields with their type, default, and effect
- [ ] The fail-open behavior is documented in the same section

**Source Map**:
- `docs/agent-api.md` (or the correct existing doc per Step 1's CLAUDE.md reference table — dev-task should confirm the exact file during exploration)

**Testing Strategy**: Layer: none — documentation only.

---

## Technical Constraints

- **Additive only.** Every schema change is a new nullable field; no existing field, relation, or behavior changes for an agent with no cap configured. This is the load-bearing constraint of the whole spec, given the dispatch path touches every running agent.
- **Fail open, always.** A spend-aggregation error must never block dispatch. This is more important than cap accuracy — an agent stuck unable to work because of a broken query is a worse outcome than a brief over-cap spend.
- No admin UI exposure for the caps is required in this spec (Feature 2's API is sufficient for v1) — a UI surface can follow as a separate, later task if wanted.
- Must not touch `LVB` (Loop Verification Budget) — confirmed unrelated, wall-clock/process-tree concern, not LLM spend. Do not conflate naming.

## Scope

**In Scope**:
- Unified spend aggregation function + read API
- Two new nullable `Agent` cap fields + admin API support
- Dispatch-time enforcement with fail-open safety and a one-time Slack alert
- Documentation of the new fields and fail-open behavior

**Out of Scope**:
- Self-service signup → automatic agent provisioning (separate PRD)
- GitHub App / Slack shared-tier support for multiple students on shared infra (separate PRD)
- Trial expiry / auto-deprovisioning (separate PRD)
- Multi-tenant isolation story (separate PRD or folded into the provisioning PRD)
- Admin UI for viewing/editing caps
- Per-model or per-task-type spend limits (this spec is a flat per-agent ceiling only)
- Resolving whether `Task.costUsd` and `AgentCronRunModelBreakdown` double-count — flagged for `dev-task`/plan-session exploration in Feature 1, not decided here

## Priorities & Sequence

Feature 1 (aggregation) must land before Feature 3 (enforcement), which depends on it. Feature 2 (schema fields) has no dependency on Feature 1 and can be built in parallel. Feature 4 (docs) can trail either, ideally landing with or after Feature 3.

## Testing Strategy

| Feature | Layer | Rationale |
|---------|-------|-----------|
| Unified spend aggregation | integration | reads real Postgres fixture rows across two tables |
| Spend cap configuration | smoke | HTTP route contract for the existing agent PATCH/GET path |
| Dispatch enforcement | integration | exercises `loop-orchestrator`'s dispatch path with an injected spend-check double |
| Documentation | none | documentation only |

## Resolved Decisions

- **Aggregation source tables**: sum `AgentChatTokenUsageDailyByModel` + `AgentCronRunModelBreakdown`, with the `Task.costUsd` overlap question left as an explicit exploration item for plan-session/dev-task rather than guessed at here. — Rationale: I don't have certainty on whether these double-count without reading the actual write paths in more depth than this PRD pass allows; guessing wrong here would either undercount or double-count every agent's spend, which defeats the entire feature. _(To be confirmed during plan-session Step 2 codebase exploration before Feature 1 is built.)_
- **Cap granularity**: flat per-agent daily + monthly USD ceiling, no per-model or per-task-type sub-limits. — Rationale: matches the "hard blocker" ask (stop runaway total spend) without adding configuration surface nobody asked for yet.
- **Enforcement failure mode**: fail open (allow dispatch) on any aggregation error. — Rationale: this code path runs for every existing production agent; a false-positive block from a transient query failure is a worse outcome than a brief over-cap spend, especially since this repo's own agent (running this very PRD) dispatches through this exact path.
- **No admin UI in this spec**: API-only for v1. — Rationale: keeps the PRD scoped to the actual blocker (a machine-enforced ceiling); a UI is a legitimate follow-up once the mechanism is proven, not a prerequisite for it to exist.

## Success Criteria

- An agent with a configured daily or monthly cap stops dispatching new `shipwright-loop` work once its aggregated spend meets or exceeds that cap, and a single Slack alert fires on the crossing.
- Every existing agent with no cap configured — including this repo's own production agents — shows zero behavior change: same dispatch path, same performance, no new query on the hot path.
- A simulated aggregation-query failure never blocks dispatch.
- `task ci` passes with no regression to the existing `loop-orchestrator` test suite.
