# Plan: patch-outcome-hardening

Repo: app-vitals/shipwright

## Problem

Two defects in the shipped patch outcome check (PHS-3.1) and its crash budget (PHS-3.3):

1. **A transient crash blocks a PR permanently.** The loop's patch wrapper (`dispatch()` in `agent/src/loop-orchestrator.ts`) runs the outcome check in a `finally`. When the dispatch throws (crash or timeout) and live state is unchanged, it escalates through `blockPr` on the first throw. PHS-3.3 intended crashes to have a bounded retry budget via the existing skip streak; that never gets a chance. Root cause was a contradiction in the patch-handled-state plan: PHS-3.1 said the check also runs on thrown exits, PHS-3.3 said crashes get a retry budget.
2. **Escalation blocks never clear.** `blockPr` PATCHes only `blocked` and `blockedReason` - no `blockedHeadSha` or `blockedReviewId` (and `PATCH /prs/:id` accepts neither). `clearStaleSkipBlock` only clears blocks whose reason contains "consecutive skips" and that have a `blockedHeadSha`, so a pushed fix never clears an escalation; it needs a manual unblock.

Verified non-issue: Step 6b.8 (rerun-first for cancelled CI) polls the rerun to a terminal state before the run ends, so the after-snapshot is settled/changed, not falsely unchanged.

## Design

1. The loop's outcome check does not escalate when the dispatch threw. Thrown exits stay on the PHS-3.3 skip streak (recordSkip with the error reason), which gives them the intended bounded retry. Clean exits (including `[silent]`) behave exactly as today.
2. A new head clears an escalation block, the same way it already clears a skip-streak block (decided). Escalation stamps `blockedHeadSha` (the head from the outcome snapshot) and `blockedReviewId` (latest review-source finding id, as `recordSkip` does; without it `clearStaleSkipBlock` sees `reviewChanged` as true on PRs with review findings and clears the block on the next tick with no new head), plus a shared reason prefix constant; `clearStaleSkipBlock` recognizes that prefix in addition to "consecutive skips". Human-written blocks (e.g. patch.md Step 5a.7 second-round disagreement) carry neither the prefix nor a stamp and are never auto-cleared. If patch still cannot make progress on the new head it escalates once more, once per head.
3. `scripts/hitl.ts` uses the same escalation helper (it calls `blockPr`), so both paths stamp and clear the same way. hitl spawn throws are not a crash-budget case (it has no streak), so its escalation behavior is unchanged.

## Sequencing

Deploy these together with SLS-1.2, SLS-2.1 and SLS-2.2 before the stale agent images are rolled, so no fleet agent runs PHS-3.1's escalation without these safety valves. Rollout itself is tracked outside this session.

## Tasks

| ID | Title | Layer | Deps | Model |
|---|---|---|---|---|
| POH-1.1 | Loop: skip outcome-check escalation when the dispatch threw | Background | - | haiku |
| POH-2.1 | task-store: PATCH /prs/:id accepts blockedHeadSha + blockedReviewId | API | - | haiku |
| POH-2.2 | Escalation stamps blockedHeadSha + blockedReviewId + shared prefix; clearStaleSkipBlock recognizes it | Shared | 2.1 | sonnet |

All separate PRs; additive and safe to deploy standalone (2.2 after 2.1 is deployed).

## Decision Log

- A new head clears an escalation block: approved.
- hitl throw behavior unchanged: hitl has no skip streak.
- Other accounts' task stores and one-off cleanup are out of scope.
