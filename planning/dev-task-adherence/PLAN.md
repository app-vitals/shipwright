# Plan: dev-task step adherence

Session: `dev-task-adherence` · Repo: `app-vitals/shipwright`

Source: Slack discussion between Dan, Dave and the agent (2026-10-09/10). Approved by Dan; Dave to correct anything afterwards.

## Goal

Cut prompts as far as possible while quality and step-following stay high. The steps are the product: skipping one is a defect even when CI passes. The "how" is what gets cut. One prompt at a time, judged on real production runs.

## Evidence

- 9 of 9 sampled dev-task sessions (agent: VRW-1.1, VRW-1.2, PAU-4.2; Dan's sample: PAU-1.10, PAU-1.8, SSX-3.1, SSX-2.2, CDV-1.1, PRL-1.1) dispatched no implementation or spec-compliance subagent and edited files inline (Python/cat heredocs). Skill loading was fine; CI passed, so outcome metrics did not show it.
- `dev-task.md` is ~1,400 lines, mostly mechanics. The prompt audit flags it as ~18k tokens/run (~2.3M tokens/week) but only reads markdown and token cost; it cannot see skipped steps.
- No sandbox exists. The audit's evals run in git worktrees and cannot stand in for production runs. Evals are out of scope for this session.

## Design

**Decisions from the discussion**
- All dev-task steps are mandatory. Step 8.5 (docs-refresher) is always dispatched; the agent decides inside whether docs need updating.
- Enforcement is automatic and after the run. No extra steps are added to any phase.
- Rollout is an A/B on real runs, ~100 runs per arm, random split per run, one prompt at a time.

**Adherence measurement (DTA-1.2).** Admin already stores per-run `AgentCronRunSkillUsage` rows (`kind`, `name`, `invocations`); subagent dispatches appear as `agent:<subagent_type>`. The adherence report compares each run to a per-command required-steps table. No schema or agent-side change. A dispatch proves a step started, not that it was done well.

**Variant switch (DTA-1.3).** `PHASE_COMMANDS` in `agent/src/loop-orchestrator.ts` is a fixed phase-to-command map. Add a configured share of runs that use an alternate command, and record the variant per run so results can be grouped.

**Required steps for dev-task (all mandatory)**

| Step | Proof of running |
|---|---|
| 5 Implementation subagent | `agent:` dispatch |
| 6 Simplify | marker needed; unmeasured at first |
| 6.5 Spec compliance | `agent:` dispatch |
| 7 Requirements verification | marker needed; unmeasured at first |
| 8 Pre-ship checks | lint/test commands ran (partial) |
| 8.5 Docs refresh | `agent:shipwright:docs-refresher` dispatch (a skip reason is fine) |
| 9, 9b, 10 | PR, CI, handoff visible in outcomes |

CI-fix subagents (9b) run only on failure and are not required per run.

## Tasks

| ID | Task | Depends on | Review |
|---|---|---|---|
| DTA-1.1 | One line in `dev-task.md`: task size / docs-only is never grounds to skip a step | none | Dave (PR) |
| DTA-2.1 | Machine-readable required-steps table for dev-task | none | Dan, Dave |
| DTA-1.2 | Adherence report from existing admin run data | 2.1 | none |
| DTA-1.3 | Per-run command variant switch in the loop orchestrator | none | Dave |
| DTA-2.2 | Trimmed dev-task variant (spine + references/) | 2.1 | Dave |
| DTA-2.3 | Trial ~100 runs/arm, stop condition set beforehand (HITL) | 1.2, 1.3, 2.2 | Dan, Dave |
| DTA-3.1 | Check patch/review/deploy adherence, pick next prompt (HITL) | 1.2, 2.3 | Dan, Dave |
| DTA-4.1 | Adherence metric in prompt-audit | 1.2 | none |
| DTA-4.2 | Quiet `unresolvable-path` by default (optional) | none | none |

**Dependency note:** DTA-1.2 depends on DTA-2.1 (it consumes the table file), a small change from the thread's draft where 1.2 had no dependency.

**Order:** 1.1, 1.3, 2.1 and 4.2 are ready immediately; 1.2 and 2.2 follow 2.1; 2.3 follows 1.2/1.3/2.2; 3.1 and 4.1 follow.

## Breaking Change Safety

All tasks are additive (a prompt line, a new table file, a new report, an optional variant path off by default, a new metric, a rule default). Safe to deploy standalone: yes for every task. The variant switch must default to 0% so nothing changes until the trial starts.

## Safeguards

- DTA-1.2 changes no behavior: measure before changing prompts.
- The trimmed command goes to a share of runs only.
- Any metric must reproduce the 9-of-9 finding before it is trusted.
- Trial stop condition: adherence no lower, patch cycles and CI pass no worse. ~19 dev-task sessions/day on one agent means ~10 days for 100 runs per arm at a 50/50 split.

## Decision Log

- Added DTA-1.2 -> DTA-2.1 dependency: the report consumes the table file.
- DTA-2.3 and DTA-3.1 marked HITL: they are human-run trial and analysis steps with no code diff.
- Marker-based measurement of Steps 6 and 7 deferred until first adherence numbers exist, to avoid adding output steps.

## Addendum (2026-10-13): DTA-5.1 — fix Step 5 dispatch detection

DTA-2.3 blocked on `adherence_report_cannot_score_trial`: the report's grouping-by-variant
half was already fixed by DTA-1.4 (byCommandVariant, PR #4246, merged/deployed 2026-10-12).
The remaining half — step detection seeing the Step 5 dispatch in only 3/201 task-bearing
runs since 2026-10-08 — is a real bug, root-caused by reading the code (no re-investigation
needed):

**Root cause.** `RunTelemetryAccumulator.observeContent()` in `agent/src/run-telemetry.ts`
(~line 151) only recognizes a subagent dispatch when the stream-json tool_use block's
`name === "Agent"`, and only populates `subagentByToolUseId` for that same name (~line 157).
The Claude CLI's stream can emit either `"Agent"` or `"Task"` for the identical dispatch
tool — `agent/src/progress-milestones.ts` (earlier, PR #2906) already encodes this duality,
mapping both names to the `"delegating"` phase in its `TOOL_PHASE_MAP`. `run-telemetry.ts`
(later, PR #3982) never adopted that precedent, so whenever a real run's CLI build emits
`"Task"` instead of `"Agent"`, the Step 5 dispatch is invisible to `invocationsOf()` /
`customImplementer` in `admin/src/dev-task-adherence.ts`, and `step5Ran` evaluates false
even though Step 5 genuinely ran.

**Fix (DTA-5.1):** widen both checks in `run-telemetry.ts` to `name === "Agent" || name ===
"Task"`. Single file, no architecture decision, no breaking change — additive widening of a
string check. `admin/src/dev-task-adherence.ts` needs no change; it already consumes
`SkillUsageRow[]` correctly once the rows are populated right.

| ID | Task | Depends on | HITL |
|---|---|---|---|
| DTA-5.1 | Recognize both `Agent` and `Task` tool names in `run-telemetry.ts` dispatch detection | none | no |

**Breaking Change Safety:** additive string-check widening. Safe to deploy standalone: yes.

**Note for whoever retries DTA-2.3:** once DTA-5.1 merges and deploys, re-run the adherence
report over a fresh window and confirm the dispatch-detection rate against real runs before
resetting DTA-2.3 to pending — not done automatically here.

## Addendum (2026-10-21): DTA-2.3 retried; real root cause was a pre-telemetry data gap, not the matcher

DTA-2.3 was reset to pending on 2026-10-20 after confirming DTA-5.1 and DTA-1.4 had both
deployed. Before starting the trial, we cross-checked the live report against real
transcripts (via another agent, doc) to settle whether the "mostly skipped" numbers were
still a detection bug.

**Finding: the matcher is correct.** Every dispatch observed in real transcripts used tool
name `Agent` (never `Task`); `run-telemetry.ts` already handles both. No further matcher fix
needed.

**Real cause: `AgentCronRunSkillUsage` didn't exist before PR #3982 (merged 2026-10-08).**
Joining 146 completed+dispatched runs against the report: 124 (from 09-21 to 10-08) have
null `turns`/`toolCalls`/`claudeCodeVersion`/`pluginVersion` — no telemetry was ever
persisted, because the accumulator didn't exist yet. 12 more are legitimately
"skipped" (docs-refresher-only dispatch, no implementer). Only 1 (`SPL-2.8`) is a real
miss, and it's the same small, still-live pattern described below. Restricting to
`from=2026-10-10` (first full day with telemetry live) gives a more honest 9/102 (8.8%)
Step 5 ran-rate.

**Known live limitation: stalled-and-resumed runs misattribute their dispatch.** When a run
dispatches the implementer, then stalls without completing (`completedAt` stays null), a
later resume reuses the same Claude session (`sessionId`) but gets a fresh
`AgentCronRun` row — its own telemetry only covers its own turns, so the dispatch is
invisible to the resumed row, and the stalled row never reports at all. Confirmed via
`SPL-2.8`, and separately via `AEP-3.1`/`AEP-3.2` (dispatch confirmed in transcript,
`completedAt: null`). Small (affects a single-digit percentage of runs) but real; not
fixed here. Likely symmetric across trial arms, so not expected to bias the A/B
comparison, but should be called out in the final write-up rather than silently absorbed.

**Decision:** started the DTA-2.3 trial on 2026-10-20 on doc, warchild and maverick
(`SHIPWRIGHT_LOOP_DEV_TASK_ALT_COMMAND=/shipwright:dev-task-lean`,
`SHIPWRIGHT_LOOP_DEV_TASK_ALT_SHARE=50`) without a report code fix — the pre-telemetry gap
is purely historical, and every run the trial generates from 2026-10-20 forward already has
real telemetry. DTA-2.3's own description was updated with: (1) use `from=2026-10-20` when
reading the final comparison, not all-time, and (2) treat the resumed-run gap as a documented
caveat, not a regression signal.

## Addendum (2026-10-21): required-steps table covers only 3 of 9 steps; most of the rest is already capturable without new agent instrumentation

While verifying the report, we compared `references/required-steps/dev-task.json` (DTA-2.1)
against what `admin/src/dev-task-adherence.ts`'s `evaluateRun()` actually implements.
`isDispatchStep()` only treats a step as measurable when `proofOfRunning` starts with
"agent dispatch", and the switch statement only has cases for steps `5`, `6.5`, `8.5`. The
table declares 7 of 9 steps `measurable: true` (everything except 6 and 7), but only 3 of
those 7 are wired up — steps `8`, `9`, `9b`, and `10` silently fall through to
"unmeasured", identically to the genuinely-unmeasured 6/7, even though the table claims
otherwise.

Steps 0/1/3 (toolchain detection, fetch/validate, prompt construction) have no independent
proof of running — any task-bearing run already proves they happened, so they don't need a
table entry at all.

Breaking down what's actually needed for the remaining gap:

| Step | Proof type (per table) | Status | What's needed |
|---|---|---|---|
| 2 (Mark In-Progress) | task claim | not wired | Join report against the task's own `claimedAt`/`startedAt` — already in the task store, no new instrumentation. |
| 4 (Set Up Worktree) | branch/PR reality | not wired | Join against git/GitHub state (branch, PR existence) — already checked live by dev-task itself, just not persisted for the report to read. |
| 6 (Simplify) | marker needed | unmeasured (by design) | New marker. |
| 6.5 (Spec Compliance Check) | agent dispatch | wired | — |
| 7 (Requirements Verification) | marker needed | unmeasured (by design) | New marker. |
| 8 (Pre-Ship Checks) | lint/test ran | not wired | **Already fully captured** — `POST /verification-checks` (task-store, LVB-5.1) records every check's `taskId`/`checkName`/`status` today. Report just needs to query `GET /verification-checks?taskId=` and join. No new instrumentation. |
| 8.5 (Auto-Refresh Docs) | agent dispatch | wired | — |
| 9 (Push & PR) | PR visible in outcomes | not wired | Join against the task's own `pr`/`prCreatedAt` field or the PR record. |
| 9b (CI Gate) | CI/handoff visible in outcomes | not wired | Join against the PR record's CI/outcome fields (`ciFixAttempts`, `mergeCommit`, etc.), already tracked. |
| 10 (Update Queue & Handoff) | handoff visible in outcomes | not wired | New marker — no existing persisted signal for "the handoff print happened." |

So the gap is smaller than it first looked: 5 of the 7 untracked steps (2, 4, 8, 9, 9b) need
only a report-side join against data already being recorded elsewhere in the task store/PR
records — no agent-side changes. Only 6, 7, and 10 need a new marker (same mechanism as the
existing `[skip-reason:...]`/`[silent]` convention).

**Next:** break this into scoped follow-up tasks (join-based steps first, since they're
lower-risk and higher-value; marker-based steps second) via a fresh planning pass on this
same session.
