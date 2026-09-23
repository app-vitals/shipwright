# Plan Session: claim-retry-unification

**Repo:** app-vitals/shipwright

## Problem

Today only `dev-task` gets a fast, in-place retry when a dispatch exits without properly
wrapping up: DTW-1.3's resume loop in `agent/src/loop-orchestrator.ts`'s `dispatchItem()`
checks, after a clean (non-throwing) attempt, whether the task is still `in_progress` and
still claimed by this agent — if so, it resumes the *same* Claude session (`-r`) up to
`MAX_AUTO_RESUMES` (3) times, refreshing the claim's heartbeat before each resume.

`patch`, `review`, and `deploy` have no equivalent. Their candidate providers
(`check-patch.ts`, `check-review.ts`, `check-deploy.ts`) all exclude any PR with
`claimedBy != null` from candidacy — including a stale one — so a crashed or
incompletely-finished patch/review/deploy dispatch simply sits invisible until
`StaleClaimReaper` clears the claim (~65 minutes later) and the PR becomes a fresh
candidate again. There is no immediate, same-session recovery path for these three
phases today.

Separately, `task-service.ts`'s `release()` has no terminal-state guard — unlike
`pull-request-service.ts`'s `release()`, which was fixed (CHU-2.3) to skip resetting
`reviewState` when it's already `posted`/`approved`. An unconditional Task `release()`
call would clobber a terminal `status` (e.g. `cancelled`) back to `pending`.

## Design

1. **Prerequisite fix — `task-service.ts` `release()` terminal-state guard.** Mirror
   the PR-side fix: only reset `status` to `"pending"` when the existing status is
   `"in_progress"`; leave any other status untouched.

2. **New PR-state client plumbing.** `GET /prs/:id` and `POST /prs/:id/heartbeat` are
   already live server-side. Add `getPr(id)` / `heartbeatPr(id)` wrappers to
   `check-helpers.ts`'s `taskStoreClient`, mirroring the existing `getTask`/
   `heartbeatTask`, and wire them into `createProductionLoopOrchestrator`'s deps.

3. **Generalize the same-session resume loop to all four phases.** In `dispatchItem()`,
   drop the `phase === "dev-task"` restriction on `sessionKey` generation and on
   entering the resume loop — every phase now gets a per-dispatch `sessionKey`.
   Generalize the resume condition to a phase-generic "still claimed by this agent"
   check: task items keep using `getTaskState`/`agentId` (status + claimedBy); PR
   items use the new `getPr`/`heartbeatPr` deps (claimedBy only — PR items have no
   `in_progress`-equivalent status gate). dev-task's existing behavior (cap, ordering,
   `clearSessionKey`-on-exit) is preserved exactly; only the gate and the fetched state
   shape change.

This covers both failure shapes uniformly:
- **Crash/timeout** (thrown error) — still falls back to the reaper path for all four
  phases, as it already does today. Unchanged.
- **Clean exit that didn't unclaim** (returns `"completed"` but the record is still
  claimed by this agent) — now resumes the same session immediately, for all four
  phases, instead of only dev-task.

## Decision Log

- Unified resume condition uses `claimedBy === agentId` alone (no PR-side status
  equivalent of `status === "in_progress"`) — every real completion path
  (`complete()`, `patch()`, terminal `update()` transitions, and the newly-guarded
  `release()`) already nulls `claimedBy`, so claim ownership alone is a sufficient and
  simpler signal than what dev-task currently checks.

## Tasks

| Task    | Title                                                        | Depends on | Hours | Complexity | Model  |
|---------|---------------------------------------------------------------|------------|-------|------------|--------|
| CRT-1.1 | Add terminal-state guard to Task `release()`                  | —          | 1.5   | 2          | haiku  |
| CRT-1.2 | Add `getPr()`/`heartbeatPr()` task-store client wrappers       | —          | 1.5   | 2          | haiku  |
| CRT-1.3 | Generalize same-session resume loop to patch/review/deploy    | 1.1, 1.2   | 7     | 5          | opus   |

No renames/removals, no constraint additions — all three tasks are safe to deploy
standalone. No HITL findings.
