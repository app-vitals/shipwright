# Plan: pfl-5-ledger-fallback-gap

## Background

PR [#3052](https://github.com/app-vitals/shipwright/pull/3052) (merged 2026-09-02,
`c3e0ea87`) closed a gap left by `PFL-4.1`: a PR got stuck in the patch phase forever
because no ledger entry could ever be written for its self-approve review.

- **PFL-5.1** restored `isSelfCleanApprove`/`isSupersededBySelfReview` as fallback
  exclusions in `hasUnaddressedFindings` (`plugins/shipwright/scripts/compute-unaddressed-findings.ts`),
  alongside `isResolvedByLedger` — an immediate fix for the stuck PR.
- **PFL-5.2** closed the gap at the root: `review.md`'s Step 11 now ledgers its own
  just-posted self-clean-approve review at post time, instead of only ever ledgering a
  *prior* review at the start of a subsequent pass.
- **PFL-5.3** wired task-store ledger findings into `check-patch.ts`'s candidate check.

This work was done directly on the PR (diagnosed and implemented by an agent without
task-store access) rather than through a `plan-session`, so no task-store record exists
for PFL-5.1/5.2/5.3. This plan exists solely to properly file the one remaining
follow-up: removing the PFL-5.1 fallback once PFL-5.2 is confirmed live.

## Design

No new code design — this is a single removal-only follow-up task, mirroring `PFL-4.1`'s
own precedent exactly (same "restore as immediate fix, remove once root-cause fix is
confirmed live" pattern, same file, same functions).

`hasUnaddressedFindings`'s `qualifyingReviews` filter
(`compute-unaddressed-findings.ts:462-469`) currently excludes three things:
`isSelfCleanApprove`, `isSupersededBySelfReview`, and `isResolvedByLedger`. Once PFL-5.2
is confirmed to be writing ledger entries for self-reviews in production, and the PR that
triggered this incident (plus any other PR relying on the PFL-5.1 fallback) has merged,
drop the first two exclusions — `isResolvedByLedger` alone should cover every case,
exactly as PFL-4.1 established for the general case.

Both functions stay exported and unchanged: `review.md`'s Step 5.5 and
`check-patch.ts`'s `hasMergeOnlyStaleFindings` still call them independently.

Test change: remove the `hasUnaddressedFindings` regression tests in
`compute-unaddressed-findings.unit.test.ts` explicitly labeled "restored PFL-5.1" (the
blocks around self-authored-review exclusion, self-review-with-real-findings,
bold-wrapped self-APPROVE, narrative "Verdict: APPROVE", and superseded-by-later-clean-
self-review). The standalone `isSelfCleanApprove`/`isSupersededBySelfReview` unit-test
`describe` blocks stay — they test the functions directly, which remain in use elsewhere.
The ledger-based tests from PFL-3.1/3.2/5.2 already cover the equivalent behavior for the
`hasUnaddressedFindings` gate itself.

Safe to deploy standalone: yes — removal-only, no external consumers of the exclusion
behavior beyond `hasUnaddressedFindings` itself.

## Tasks

| ID | Title | Depends on | Branch | Layer | Hours | Complexity | Model | HITL |
|----|-------|-----------|--------|-------|-------|------------|-------|------|
| PFL-5.4 | Remove PFL-5.1's self-review fallback exclusions once ledger coverage is confirmed | — | `feat/pfl-5-4-remove-self-review-fallback` | Shared | 1 | 2 | sonnet | ⚠ HITL |

### PFL-5.4

Remove `isSelfCleanApprove`/`isSupersededBySelfReview` as exclusions from
`hasUnaddressedFindings`'s main `qualifyingReviews` filter once PFL-5.2's ledger writes
are confirmed live in production, leaving `isResolvedByLedger` as the sole exclusion for
self-review dispositions. Both functions remain exported and unchanged everywhere else
they're used.

This is gated on a human judgment call about bake time, not a fixed schedule — same
pattern as PFL-4.1's own gating. `hitl: true` until a human confirms readiness.

**Acceptance criteria:**
- `isSelfCleanApprove` and `isSupersededBySelfReview` are removed as exclusions from
  `hasUnaddressedFindings`'s main `qualifyingReviews` filter in
  `compute-unaddressed-findings.ts` — `isResolvedByLedger` remains as the sole exclusion
  for self-review dispositions
- Both functions remain exported and unchanged everywhere else they're used (`review.md`'s
  Step 5.5 ledger-write judgments, `check-patch.ts`'s `hasMergeOnlyStaleFindings`)
- The PFL-5.1 regression tests in `compute-unaddressed-findings.unit.test.ts` covering the
  `hasUnaddressedFindings` exclusion path are removed as now-dead (the ledger-based tests
  from PFL-3.1/3.2/5.2 already cover the equivalent behavior); the standalone
  `isSelfCleanApprove`/`isSupersededBySelfReview` unit tests are retained since the
  functions remain in use elsewhere
- `task ci` passes (lint, typecheck, test:coverage) with the aggregate coverage gate met

**Human steps** (required before clearing `hitl`):
1. Confirm PFL-5.2 (merged in #3052, `c3e0ea87`, 2026-09-02) has been live in production
   for a deliberate bake period — not a fixed schedule, long enough to see at least one
   real self-authored PR go through a first-and-only review pass and get a ledger entry
   written for it.
2. Query the task-store PR ledger for a `PrFinding` with `source:"review"`,
   `disposition:"resolved"` whose evidence references the PFL-5.2 post-time write,
   confirming it actually fired in production (not just passed unit tests).
3. Confirm the specific PR that originally triggered this incident, and any other PR that
   was relying on the PFL-5.1 fallback, has merged.

Only once all three are confirmed should this task be unblocked (`hitl: false`) for
`dev-task` to execute.

### Dependency Map

```
[START]
  └─ PFL-5.4: Remove PFL-5.1's self-review fallback exclusions (no deps, ⚠ HITL)
```

```
Task     | Depends on | Blocks | HITL
PFL-5.4  | —          | —      | ⚠ HITL
```

## HITL scan

HITL tasks detected: 1
PFL-5.4 — Remove PFL-5.1's self-review fallback exclusions once ledger coverage is
confirmed — flagged by: judgment (human bake-period sign-off, no mechanical trigger),
same pattern as PFL-4.1's own precedent
