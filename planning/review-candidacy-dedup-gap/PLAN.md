# Plan Session: review-candidacy-dedup-gap

**Repo:** app-vitals/shipwright
**Origin:** live incident — `app-vitals/shipwright#2600` and `app-vitals/goals#68` stuck
oscillating on the review phase for 12h47m+ (28 and 35 wasted `shipwright-loop` dispatches
respectively), diagnosed 2026-08-13. Supersedes task `RVD-1.3`, which was filed incorrectly
via a direct `POST /tasks` (missing required `branch` field, blocked immediately) instead of
through this plan session.

## Root cause (confirmed live via `diagnose-review-candidacy.ts`, not just code reading)

`agent/src/check-review.ts`'s `getReviewCandidates()` (candidate **selection**) and
`review.md`'s own dispatch-time re-checks use two different definitions of "already
reviewed":

- **Selection** (`traceReviewCandidacyDecision()`, via `classifyReviewState()` in
  `check-helpers.ts`): only excludes a PR when the existing review has *no genuine finding*
  (`classifyReviewState()` returns `"approved"`/`"posted"`). A review with a real, substantive
  `Verdict: COMMENT` finding returns `null` — which `classifyReviewState()` uses for BOTH "no
  review at head at all" and "a review exists with a real finding." Selection doesn't
  distinguish these, so a real-finding review is (incorrectly) still treated as
  "review-eligible."
- **Dispatch** (`review.md`'s RVD-1.2 Live-Review Pre-Check, ~line 1072, and its Step 3
  defense-in-depth dedup, ~line 1174): both correctly treat ANY review at head — clean or
  not — as terminal, and defer with `[skip-reason:review:deferred:already-reviewed-at-head]`.

Selection says "eligible," dispatch says "already done." The PR bounces between them forever,
burning a tick every time, and since the loop's cross-phase FIFO dispatches only one winning
item per tick, the PR's separate, correctly-eligible `patch` candidate never wins the tie.

## Broader pattern (Dan's follow-up ask)

When a dispatch-time re-check discovers the persisted state is stale (the record still looks
"needs attention" but live GitHub already shows it's resolved), does the dispatch path
correct the record, or just bail and leave the mis-classification to recur? Audited every
`[skip-reason:...]`/`[silent]` bail point across `review.md`, `patch.md`, `deploy.md`, and
`dev-task.md`:

- **`review.md` RVD-1.2 Live-Review Pre-Check** (~line 1072) — detects a terminal review via
  a live GitHub GraphQL query, matched by a `Verdict: APPROVE|COMMENT` label regex. Releases
  its inherited claim (if any) and stops. **No record write-back** — the task-store record's
  `reviewState` is left exactly as it was, so the next tick's selection makes the same call
  again.
- **`review.md` Step 3 defense-in-depth dedup** (~line 1174) — same shape, task-store-based
  instead of live-GitHub-based. **No record write-back.**
- **`review.md`'s "unresolved human feedback" skip** (~line 335) — for comparison, this one
  already does it right: PATCHes `reviewState: "posted"` before bailing. Known caveat
  (documented in the file itself): a background reconciler (`pr-state-reconciler.ts`'s
  `reconcileReviewState()`, CHU-2.4 sub-pass) reverts `posted` back to `pending` when
  `hasAnyReviewAtHead()` is false — i.e. only for the "unresolved feedback was a plain PR
  comment with no formal review object" case. Any write-back this session adds must not
  collide with that reconciler.
- **`patch.md` Step 3d** ("no PRs need attention," ~line 353) — patch is single-target-only,
  so this fires when `patch.md`'s own fresh classification (Steps 3a-3c) finds nothing to do
  for the explicitly-targeted PR, having been selected by `check-patch.ts`'s
  `getPatchCandidates()`. **No record write-back** on its face, but on inspection this is
  structurally different from the review.md gaps: `getPatchCandidates()` doesn't read any
  cached "needs patch" field from the task-store record for its qualification decision — it
  re-derives DIRTY/CI/findings status fresh from live GitHub on every tick, same as
  `patch.md`'s own Step 3a-3c. There's no persisted mis-classification to correct; reaching
  Step 3d most likely means a genuine race (CI went green, or a human fixed it directly,
  between selection and dispatch) rather than a stale cached value. **Scoping this down** to
  an observability-only task (structured skip-reason logging, matching the pattern the other
  legitimate-wait defers already use) rather than inventing a speculative write-back fix for
  a drift I haven't proven recurs. If it turns out to recur for the same PR repeatedly, that's
  the signal for a real follow-up.
- **`deploy.md`** (Step 3a "not approved," Step 3b "CI not green") and **`dev-task.md`**
  (Step 1 "status mismatch," Step 2 claim 409) — checked and **not affected**. Both re-derive
  their qualification signal from the same simple, directly-observable GitHub/task-store
  fields the corresponding candidate-selector reads (`reviewDecision`, CI `conclusion`, task
  `status`) — no separate body-text/thread heuristic that can diverge between selector and
  dispatcher the way `classifyReviewState()` vs the `Verdict:`-regex check can. A dispatch-time
  mismatch here is a genuine race that self-corrects on the next tick's fresh read, not a
  persisted-state bug.

## Design

### Group 1 — fix selection itself (root cause of the #2600 incident)

**RVD-2.1** — `traceReviewCandidacyDecision()`'s `already-reviewed-live` check currently
excludes only when `classifyReviewState(reviewData) !== null`. Swap to
`hasAnyReviewAtHead(reviewData)` (already exported from `check-helpers.ts`, already used by
the CHU-2.4 reconciler) — this makes selection match `review.md`'s own RVD-1.2 rule exactly:
any review at head + no fresh author reply → excluded, regardless of finding content. Widen
the `already-reviewed-live` trace variant's `classifiedState` field to
`"approved" | "posted" | null` (`null` now legitimately covers the genuine-finding case).

### Group 2 — defensive write-back at the two proven review.md gaps

**RVD-2.2** — RVD-1.2 Live-Review Pre-Check: when `$terminal == true` and the PR has a
task-store record whose `reviewState` isn't already `posted`/`approved`, PATCH it to
`reviewState: "posted"`, `reviewedCommitSha: {headRefOid}` before releasing the claim and
stopping — mirrors the existing "unresolved human feedback" write-back at ~line 340. Safe
against the CHU-2.4 reconciler: this only fires when a review object genuinely exists at
head (`hasAnyReviewAtHead()` true), which is exactly the condition that keeps the reconciler
from reverting it.

**RVD-2.3** — Step 3 defense-in-depth dedup: same write-back, using the record already
fetched in that step (no extra query needed) — PATCH `reviewState: "posted"` before the
existing `[silent]` stop, whenever the fetched record's `reviewState` doesn't already reflect
a terminal state at the current `headRefOid`.

### Group 3 — observability only (patch.md, scoped down per the note above)

**RVD-2.4** — `patch.md` Step 3d: emit a tagged
`[skip-reason:patch:deferred:no-op-at-dispatch:{pr}]` (new reason string) immediately before
the existing `[silent]`, matching the tagging convention already used elsewhere in this file
so the loop orchestrator's `SKIP_BLOCK_THRESHOLD` handling doesn't misclassify this as a
generic no-signal skip. No record write-back — see the design note above for why one isn't
justified yet.

## Breaking Change Scan

All four tasks are additive/narrowing changes to internal candidate-selection and
dispatch-time logic — no API/DB/schema/consumer surface. `RVD-2.1` narrows an existing
exclusion (previously-eligible PRs matching the new condition become excluded — this is the
intended fix, not a breaking change to any external contract). Safe to deploy standalone: yes
for all four; no sequencing dependency between them (each is an independent file/branch).
