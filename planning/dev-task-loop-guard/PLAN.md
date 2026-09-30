# Plan: dev-task-loop-guard

**Repo:** app-vitals/shipwright
**Session:** dev-task-loop-guard

## Problem

Two dev-task executions (`SZV-BRT-3.2`, `FTR-1.4`) got stuck redispatching forever,
each tying up the `shipwright-loop` FIFO's single winning slot every tick and
burning real tokens, because they had a "hidden requirement" the task store had
no structural way to represent:

- `SZV-BRT-3.2`: a manual prerequisite stated only in the task description
  ("confirm the brand plugin's logo field has landed on main before starting"),
  not expressed as a `dependencies` edge.
- `FTR-1.4`: depended on `FTR-1.3` being *deployed*, but task-store's dependency
  resolution (`ready.ts` lines 115-118) treats a dependency as satisfied once the
  upstream task reaches `merged` — well before `deployed`. The real requirement
  only existed as prose, so `ready.ts` marked `FTR-1.4` ready the moment
  `FTR-1.3` merged.

Both surfaced identically in the cron log: `dev-task` correctly noticed it
couldn't proceed and self-deferred with a `dev-task:deferred:...` skip-reason —
but `loop-orchestrator.ts` exempts any skip-reason tagged `deferred` from ever
calling `recordSkip()` (~line 1041), so `skipCount`/`lastSkippedAt` never moved.
Combined with `work-selector.ts`'s pure oldest-first FIFO, the same task kept
winning the pick every tick, deferring every time, forever — invisible to
`/unblock` too, since it never reached `status: 'blocked'`.

## Root Cause Investigation

1. `task-store/src/ready.ts`, `stale-claim-reaper.ts`, `task-service.ts` were
   read to map re-dispatch mechanics. A task returns to `pending` either via
   `stale-claim-reaper.ts`'s `reap()` (claim-TTL timeout) or an explicit release
   — and `reap()` never touches `skipCount`, so a session that stalls/crashes
   (rather than cleanly reporting) also evades the existing skip-count auto-block.
2. The existing "Auto-blocked after N consecutive skips" mechanism
   (`task-service.ts` `recordSkip`, `SKIP_BLOCK_THRESHOLD = 3`) only fires when
   `loop-orchestrator.ts` calls `POST /tasks/:id/skip` — which it explicitly
   skips doing whenever the skip-reason's 2nd colon segment is `deferred`
   (`isDeferredCategory`) or matches `dev-task:same-branch-sibling-busy:*`
   (`isSameBranchSiblingBusy`). Live cron-log evidence confirmed both
   `SZV-BRT-3.2` (`dev-task:deferred:manual-prerequisite-unsatisfied:...`,
   recurring every ~3 min) and `FTR-1.4`
   (`dev-task:deferred:dependency-unsatisfied:FTR-1.3`, recurring every ~1-3
   min, live during this session) hit exactly this exemption.
3. Investigated whether the `same-branch-sibling-busy` exemption is still
   needed. Git history: `29280544b` (BBE-1.1, `ready.ts`'s same-branch
   exclusion) is the real systemic fix — it already stops the automated loop
   from ever offering a busy-sibling task as a candidate. `451da5093`
   (BBE-1.2, the `recordSkip` exemption) is a now-vestigial belt-and-suspenders
   patch for a redispatch path BBE-1.1 already closed. Today,
   `dev-task.md`'s Same-Branch Sibling Check only fires as a backstop for the
   explicit-task-id dispatch path (manual/resumed invocation) — a sub-second
   race window. Tripping the reason-aware counter via that path would require
   a human manually re-invoking dev-task against the same busy-sibling task 3
   times in a row, which is itself a legitimate signal, not a false positive.

## Decisions

- **Reuse the existing `skipCount`/`SKIP_BLOCK_THRESHOLD` mechanism rather than
  adding a parallel counter** (e.g. a separate `reapCount` field) for
  stale-claim timeouts. One counter, one threshold, one auto-block path —
  the reaper just needs to call into the same counting logic `recordSkip`
  already provides, driven by a fixed reason (`"stale_claim_timeout"`).
- **Make the counter reason-aware, not just a raw count.** A streak only
  continues when the skip-reason matches the immediately prior one; a
  different reason resets `skipCount` to 1. This is what makes it safe to stop
  exempting "deferred" skips wholesale — unrelated, resolving causes don't
  accidentally chain into a false auto-block, but the *same* unresolved cause
  repeating 3x correctly trips it.
- **Remove the `isDeferredCategory`/`isSameBranchSiblingBusy` exemption
  entirely** rather than narrowing it to an allowlist. Investigation (above)
  confirmed the same-branch-sibling-busy case no longer needs special
  protection given BBE-1.1 — no allowlist needed at all.
- **Add `hitl: true` to the auto-block**, not just `status: "blocked"`. Today's
  `recordSkip` threshold branch only sets `status`+`blockedReason`; every other
  dev-task self-block path (missing branch, PRD misroute, requirements-not-met)
  sets both. This closes that inconsistency.
- **Out of scope (follow-up, not this task):** adding deploy-level dependency
  granularity (e.g. a `requiresDeployed` flag distinguishing "merged" from
  "deployed" as the satisfaction criterion) to fix `FTR-1.4`'s root cause at
  the dependency-resolution level instead of reactively. SRB-1.1's reason-aware
  auto-block already catches this case (3 identical-reason defers → block), so
  it's covered as a safety net; the preventive fix is deferred.

## Task

| Task | Depends on | Blocks | HITL |
|---|---|---|---|
| SRB-1.1 | — | — | |

**Safe to deploy standalone: yes** — additive column, additive optional request
field, internal logic changes only. No consumer-facing contract removed.

### SRB-1.1 — Make skip auto-block reason-aware and reap-triggered

**Layer:** Shared · **Hours:** 3 · **Complexity:** 4 · **Model:** sonnet
**Branch:** `feat/srb-1-1-skip-reason-aware-block`

**Description:** Extend the task-store's skip-tracking mechanism so the
3-strikes auto-block only counts consecutive occurrences of the *same* skip
reason, and so both stale-claim-reaper timeouts and every deferred-category
skip feed the same counter instead of bypassing it.

**Acceptance Criteria:**
1. `Task` gains a nullable `lastSkipReason` column (Prisma migration);
   `POST /tasks/:id/skip` accepts an optional `reason: string` in its request
   body, defaulting server-side to `"unspecified"` when omitted.
2. `recordSkip(id, reason)`: when `reason` differs from the task's current
   `lastSkipReason` (including transitioning from `null`), reset `skipCount`
   to 1 and store the new `lastSkipReason`. When it matches, increment
   `skipCount` as today. Either way, crossing `SKIP_BLOCK_THRESHOLD` (3) sets
   `status: "blocked"`, `hitl: true`, and a `blockedReason` naming the
   consecutive count and the reason.
3. `stale-claim-reaper.ts`'s `reap()` invokes the same reason-aware counting
   logic for every task it reaps, passing the fixed reason
   `"stale_claim_timeout"`, instead of resetting claim fields while leaving
   `skipCount`/`lastSkipReason` untouched.
4. `loop-orchestrator.ts` removes the `isDeferredCategory`/
   `isSameBranchSiblingBusy` exemption block entirely (~lines 1023-1062) and
   passes the parsed `[skip-reason:...]` marker text through as `reason` on
   every `/skip` call — no skip-reason category is exempt from counting.
5. `unblock()` and `resetSkip()` additionally clear `lastSkipReason` to `null`,
   consistent with their existing `skipCount`/`lastSkippedAt` reset.
6. **Test decision:** extend `task-store/src/skip-tracking.integration.test.ts`
   for reason-aware streak behavior (same-reason increments, different-reason
   resets, threshold crossing sets both `status` and `hitl`); extend
   `stale-claim-reaper`'s existing test suite for the new skip-tracking side
   effect on reap; extend `task-service.unit.test.ts`'s `unblock()` test to
   assert `lastSkipReason` clears; add a regression test in the
   `loop-orchestrator` test suite asserting a same-branch-sibling-busy defer
   sequence recurring 3x with an identical reason now correctly auto-blocks
   (guards the counting path itself, independent of BBE-1.1's dispatch-side
   protection). No existing tests are retired — this extends established
   coverage.

**Dependencies:** none.
