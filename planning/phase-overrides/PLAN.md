# Plan: phase-overrides — APM policy-migration gap fix (addendum)

This addendum covers a planning gap discovered while executing APM-1.4 within the
`phase-overrides` session (agent-policy DB-first migration, following APM-1.1's
schema addition and APM-1.2's markdown-command migration).

## Problem

APM-1.4 ("migrate `check-helpers.ts`'s 3 policy getters to DB-first") was blocked
on discovery:

1. `GET /agents/:id/config` (`admin/src/api.ts`) never wired APM-1.1's 6 new
   `Agent` columns (`autoPostReviews`, `allowSelfReview`, `minConfidence`,
   `maxFindings`, `cleanupMergedWorktrees`, `cleanupAfterDays`) into its response
   — the endpoint has nothing to serve. PMC-1.1 (`phaseMethodology`) is the
   template for how a field gets added to this response.
2. APM-1.4's AC as written required all 3 `check-helpers.ts` getters
   (`readAllowSelfReview`, `readCleanupMergedWorktrees`, `readCleanupAfterDays`)
   to share DB-first order, but APM-1.2's shipped scope (PR #3751) only makes the
   4 fields consumed by `review.md`/`merge.md`/`deploy.md` DB-first — the 2
   cleanup fields (consumed by `pr-state-reconciler.ts`, a different, background
   layer) were left file-only, documented as such in `docs/configuration.md`.
3. Decision: since `state/agent-policy.md` is slated for eventual removal, "file
   only" is not an acceptable end state for the 2 cleanup fields — they need
   their own DB-first migration task, not a silently-accepted gap.

## Design

**APM-1.5** extends `GET /agents/:id/config` to return all 6 APM-1.1 fields,
following PMC-1.1's `phaseMethodology` pattern exactly (direct passthrough from
the `Agent` row already loaded by the handler). Pure addition — unblocks
everything else.

**APM-1.4** is corrected in place: narrowed to `readAllowSelfReview` only
(matching APM-1.2's shipped scope), with its wrong `worktree-reaper.ts` caller
reference removed (real callers are `check-deploy.ts`/`check-review.ts` via
`CheckDeployDeps`/`CheckReviewDeps`'s `isSelfReviewAllowed`). Converts that one
closure from sync to async at both call sites.

**APM-1.6** (new) migrates the 2 cleanup getters using the same DB→file→hardcoded
pattern and async-conversion approach APM-1.4 establishes, applied to
`pr-state-reconciler.ts`'s sync call sites (`readCleanupMergedWorktrees`,
`readCleanupAfterDays`, ~lines 1645/1661). Also flips `docs/configuration.md`'s
Source column for these 2 fields from "file only" to the three-tier chain,
completing the migration path toward eventual removal of
`state/agent-policy.md`.

## Dependency Map

```
[START]
  └─ APM-1.5: extend /agents/:id/config with the 6 policy fields (needs APM-1.1, deployed)
        └─ APM-1.4: readAllowSelfReview DB-first, corrected AC (needs APM-1.1, APM-1.5)
              └─ APM-1.6: readCleanupMergedWorktrees/readCleanupAfterDays DB-first (needs APM-1.4, APM-1.5)
```

```
Task    | Depends on       | Blocks   | HITL
APM-1.5 | APM-1.1          | 1.4, 1.6 |
APM-1.4 | APM-1.1, APM-1.5 | 1.6      |
APM-1.6 | APM-1.4, APM-1.5 | —        |
```

Breaking-change safety: all 3 tasks are additive or same-PR atomic-update (sync→
async signature changes update their own call sites in the same task). Safe to
deploy standalone: yes, for all 3.

## Decision Log

- Scope of APM-1.4's DB-first migration: narrowed to `readAllowSelfReview` only,
  matching APM-1.2's already-shipped design, rather than amending APM-1.2's
  merged/open PR — approved by Dan (Slack, 2026-09-29).
- The 2 cleanup fields' DB-first migration: opened as its own task (APM-1.6)
  rather than accepted as a permanent file-only gap, because `state/agent-policy.md`
  is slated for eventual removal — approved by Dan (Slack, 2026-09-29).
