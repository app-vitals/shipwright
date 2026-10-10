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
