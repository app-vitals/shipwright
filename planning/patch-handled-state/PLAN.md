# Plan: patch-handled-state

Repo: app-vitals/shipwright

## Problem

A PR whose only "finding" is a non-actionable bot COMMENTED review ("no feedback to provide") is re-dispatched to
`/shipwright:patch` every tick. Observed on PR #1182: three dispatches in ~7 minutes, each releasing its claim after
30-50s (too fast for a real fix run), i.e. patch ended `[silent]` without recording anything.

Root cause: "this finding was handled" is tracked in about six places and none is authoritative.

| Signal | Written by | Consulted by |
|---|---|---|
| Ledger resolved/superseded (source: review) | review | hasUnaddressedFindings |
| Ledger rejected (source: patch) | patch Step 5c.5 | dep-risk re-route + review freshness only, NOT hasUnaddressedFindings |
| Any PR-author comment after the review (CPF-2.3) | patch rebuttal / humans | hasUnaddressedFindings |
| Thread isResolved / author reply (URT-1.1) | patch / humans | hasUnaddressedFindings |
| skipCount / blocked | loop-orchestrator | check-patch, check-review, check-deploy |
| reviewState / reviewedCommitSha | review | check-review |

Patch's durable "I looked and decided no" record (a `rejected` ledger entry) is ignored by the function that decides
candidacy. Candidacy is cleared only by a side effect (the rebuttal comment), so any exit that skips it leaves the PR a
candidate:

- `[silent]` in cron: skip-streak counts it; after 3 identical reasons the PR is auto-blocked, which excludes it from
  patch, review AND deploy (a mergeable PR is frozen by a harmless bot comment).
- `[silent]` in `scripts/hitl.ts`: no skip tracking at all (it never reads the result), so it re-dispatches forever.
- Crash/timeout/throw in cron: dispatch() reports a failed run and rethrows; recordSkip is never called, so the streak
  cannot fire. Only spin-detection (console.warn) notices.

No regression was found: the reply-exclusion (CPF-2.3, 2026-07) is the only mechanism that ever cleared a third-party
review, and it needs a posted comment. The skip tracker works as designed; it is a backstop, not the fix.

## Design

Invariant: every patch dispatch ends with the PR **settled, changed, or escalated** - enforced by code, not prompt
discipline.

1. **One authoritative "settled" record.** `hasUnaddressedFindings` honors a `source: "patch"` `disposition: "rejected"`
   ledger entry for a review ref (`commit.oid@submittedAt`, self-expiring on a new head) or an inline-thread ref.
   Server side is already permitted (patch may write `rejected`); this is additive. Patch writes one entry for every
   List A item it does not fix (including non-actionable bot reviews, with evidence). The rebuttal comment stays as
   human-visible communication but stops carrying state.
2. **State-based outcome check after every dispatch**, shared by the cron loop and `hitl.ts`. After any patch run
   (including a thrown error), recompute candidacy from live state; same head + same unsettled findings means the run
   broke the invariant and the existing escalation mechanism fires. State-based, so it works for hitl's inherited-stdio
   spawn without parsing transcripts.
3. **Dispatch errors feed the existing recordSkip** with a distinct reason, so a repeating crash is capped by the
   existing streak (and ends in the existing block). No new counters.
4. **The skip streak and its blocking scope are unchanged** (decided: blocking patch/review/deploy on a streak is fine
   because it should now be rare).
5. **Simplify only what is provably redundant**, after pinning every corner case with characterization tests. CPF-2.3 is
   NOT removed: a PR author's reply to a human review ("fixed in abc123") never gets a ledger entry, so CPF-2.3 is the
   only thing clearing it.

Out of scope: a bot-"no feedback" classifier (the settle path makes it unnecessary for correctness); PFL-5.4 (already
queued: remove PFL-5.1's self-review fallbacks) - PHS-4.1 does not duplicate it.

`compute-unaddressed-findings.ts` is shared with review.md Step 9.5 (verdict gate). Treating a patch `rejected` entry as
settled there matches what a posted rebuttal already does implicitly.

## Tasks

| ID | Title | Layer | Deps | Model |
|---|---|---|---|---|
| PHS-1.1 | Pin every existing "handled" exclusion with characterization tests | Shared | - | sonnet |
| PHS-1.2 | hasUnaddressedFindings honors patch-source rejected ledger refs | Shared | 1.1 | sonnet |
| PHS-2.1 | patch.md: define "List A, nothing actionable" as settle-with-rejected | CLI | 1.2 | sonnet |
| PHS-3.1 | Shared post-dispatch outcome check, wired into the loop | Background | 1.2 | opus |
| PHS-3.2 | Wire the outcome check into scripts/hitl.ts | CLI | 3.1 | sonnet |
| PHS-3.3 | Dispatch errors feed the existing recordSkip | Background | 3.1 | haiku |
| PHS-4.1 | Audit remaining exclusions; retire only provably redundant ones | Shared | 1.1, 2.1, 3.1 | sonnet |

```
1.1 -> 1.2 -> 2.1 --+
          \-> 3.1 -> 3.2
                \-> 3.3
1.1, 2.1, 3.1 -> 4.1
```

All tasks are separate PRs and safe to deploy standalone: 1.x-3.x only add behavior; 4.1 is the only removal and runs
after the tests and replacement paths exist.

## Decision Log

- Streak/block scope: unchanged - blocking everything on a streak is acceptable, now rare.
- Patch `rejected` counts as settled for the review verdict gate: approved.
- Ledger settle covers inline threads as well as review bodies: approved.
- PFL-5.4 overlap: defaulted to no dependency; PHS-4.1 leaves that scope to PFL-5.4.
