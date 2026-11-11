# Plan: rollup-cross-session-deps

Repo: app-vitals/shipwright

## Problem
The session rollup ("Waiting on you") misses hitl tasks whose dependencies live in another session.
`SessionService.list()/get()` load only the session's own tasks and pass them to `computeSessionRollup`;
`classifyWaiting` (`task-store/src/session-rollup.ts:124`) calls `computeBlockedBy(task, allTasks)` with that
set, so out-of-session dependencies resolve as `{type:"dependency", status:"unknown"}` (`blocked-by.ts:85-88`)
and the hitl task is never classified waiting. Observed: `saul-lane-move` / SAL-3.1 (deps PMK-1.2/1.3/2.2, all
closed) reports `state: "active"`, `waitingTasks: []`.

Other `computeBlockedBy` callers (`task-service.ts:687, 805, 890`) pass the whole account's tasks and are fine.
The admin UI mirror (`classifyWaitingTask`) reads API-computed `blockedBy` from `/tasks?session=` (full store)
so it needs no change; only the rollup API and Sessions list are wrong.

## Design
- `computeSessionRollup` gains an optional `externalTasks` param used only for dependency resolution in
  `classifyWaiting` (`[...tasks, ...externalTasks]`). Counts, state, agentIds, repos, lastActivityAt still come
  from the session's own tasks only.
- `SessionService.list()/get()` collect dependency ids not in the session's task set and fetch them with one
  `prisma.task.findMany({ where: { id: { in }, accountId } })` (batched across sessions in `list()`, skipped
  when empty), then pass them through.
- Assumption: dependency ids are unique within an account (task-service callers already assume this).

## Tasks
| Task | Depends on | Blocks | HITL |
|------|-----------|--------|------|
| RCD-1.1 | — | — | |

Safe to deploy standalone: yes (optional param + read-only query).

### RCD-1.1: fix: resolve cross-session dependencies in session rollup waiting classification
Layer: Background · Branch: fix/rcd-1-1-rollup-cross-session-deps · 2h · complexity 3 · sonnet

Add an optional `externalTasks` parameter to `computeSessionRollup` and have `SessionService.list()/get()` supply the out-of-session dependency tasks, so a hitl task whose dependencies live in another session is classified waiting once those dependencies are terminal.

Acceptance criteria:
- `computeSessionRollup` takes `externalTasks` as a new optional 5th parameter, after the existing optional `session` arg, so existing callers (including `session-retention-reaper.ts:127`, which passes no externals) compile and behave unchanged.
- `externalTasks` is used only for dependency resolution in `classifyWaiting` (`[...tasks, ...externalTasks]`); counts, state, agentIds, repos and lastActivityAt are unchanged.
- `SessionService.list()` makes one batched, account-scoped `task.findMany` for dependency ids outside the sessions' own task sets, skipped when there are none. `get()` does the same for its single session.
- A hitl task whose cross-session deps are all terminal lands in `waitingTasks` (the `saul-lane-move` / SAL-3.1 shape). A hitl task with an unmet cross-session dep stays out of it.
- Test decision: unit tests for `computeSessionRollup` with and without `externalTasks`, plus a `SessionService` test spanning two sessions. Extend `session-rollup.unit.test.ts`; retire none.

Safe to deploy standalone: yes (optional param + read-only query).
