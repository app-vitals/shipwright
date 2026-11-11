# Plan: pr-skip-loop-guard

Repo: app-vitals/shipwright. Origin: Dan's exploration of false PR auto-blocks (PRs #2426, #2428, #2548).
Guiding rule: blocking is better than an infinite loop. Out of scope: SKIP_BLOCK_THRESHOLD, recordPrSkip increment semantics, reason-aware PR streaks, state-keyed re-dispatch guard, dropping body-only review findings.

## Design
1. Same-head approval supersedes earlier COMMENTED reviews by the same reviewer (compute-unaddressed-findings.ts). Approval on a newer head supersedes nothing; unresolved threads still count.
2. Loop orchestrator: a [silent] PR dispatch that changed the PR record (reviewState / reviewedCommitSha / commitSha) did real work -> resetSkip instead of recordSkip. Fail closed on snapshot errors. Still reported as a skipped run.
3. PullRequest gets nullable blockedHeadSha, blockedReviewId, blockedAt, lastAutoBlockReason, lastAutoBlockedAt; set by recordSkip at threshold; resetSkip clears the live block but keeps lastAutoBlock*.
4. check-patch / check-review: a skip-count block ("consecutive skips") with a stored blockedHeadSha auto-clears via resetSkip when live head SHA or latest review id differs. Legacy blocks, CI-streak blocks and lookup errors stay blocked.

## Tasks
| Task | Title | Depends on | Layer | Cx | Model |
|---|---|---|---|---|---|
| PSL-1.1 | Supersede same-reviewer COMMENTED reviews by later same-head APPROVED | - | Shared | 3 | sonnet |
| PSL-2.1 | Don't count progress-making [silent] PR dispatches as skips | - | Background | 3 | sonnet |
| PSL-3.1 | Record block-time head SHA/review and preserved auto-block history on PR | - | Database | 3 | sonnet |
| PSL-3.2 | Auto-clear skip-count PR blocks when head SHA or review changes | PSL-3.1 | Background | 3 | sonnet |

Dependency map: PSL-1.1, PSL-2.1, PSL-3.1 start immediately; PSL-3.2 waits on PSL-3.1.
Breaking-change safety: all four safe to deploy standalone (additive nullable columns; logic-only otherwise).
HITL scan: no tasks require human steps.
