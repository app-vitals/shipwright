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

## Tasks

| ID      | Title                                                        | Depends on       | Branch                                        | Layer | Hours | Complexity | Model  | HITL |
|---------|---------------------------------------------------------------|------------------|------------------------------------------------|-------|-------|------------|--------|------|
| APM-1.5 | Extend `/agents/:id/config` with the 6 APM-1.1 policy fields  | APM-1.1          | `feat/apm-1-5-agent-config-policy-fields`       | API   | 1     | 2          | haiku  |      |
| APM-1.4 | `readAllowSelfReview` DB-first (corrected, narrowed scope)    | APM-1.1, APM-1.5 | `feat/apm-1-4-allow-self-review-db-first`       | Shared| 3     | 3          | sonnet |      |
| APM-1.6 | `readCleanupMergedWorktrees`/`readCleanupAfterDays` DB-first  | APM-1.4, APM-1.5 | `feat/apm-1-6-cleanup-fields-db-first`          | Shared| 3     | 3          | sonnet |      |

### APM-1.5 — Extend `/agents/:id/config` with the 6 APM-1.1 policy fields

**Description:** `admin/src/api.ts`'s `GET /agents/:id/config` handler already loads the
full `Agent` row but never wires APM-1.1's 6 new columns (`autoPostReviews`,
`allowSelfReview`, `minConfidence`, `maxFindings`, `cleanupMergedWorktrees`,
`cleanupAfterDays`) into its response. Add them as a direct passthrough from the
already-loaded row, following the existing `phaseMethodology` field's pattern
(PMC-1.1) exactly.

**Acceptance criteria:**
- `GET /agents/:id/config`'s response includes all 6 APM-1.1 fields, passed through
  directly from the loaded `Agent` row — no new query, no transformation.
- Test decision: unit tests only (`admin/src/api.unit.test.ts` or the nearest existing
  handler-level test file) — add assertions that the response includes the 6 fields.
  No existing test is retired; this is net-new coverage for a previously-unserved
  response shape.

**Layer:** API
**Hours:** 1
**Complexity:** 2
**Model:** haiku
**HITL:** no
**Safe to deploy standalone:** yes — purely additive response field, no consumer
depends on their absence.
**Branch:** `feat/apm-1-5-agent-config-policy-fields`

### APM-1.4 — `readAllowSelfReview` DB-first (corrected, narrowed scope)

**Description:** Migrate only `check-helpers.ts`'s `readAllowSelfReview` getter to
DB-first order (matching APM-1.2's already-shipped scope, PR #3751) — not all 3
getters as originally written. Remove the getter's incorrect `worktree-reaper.ts`
caller reference and replace it with its real callers: `check-deploy.ts`'s
`CheckDeployDeps.isSelfReviewAllowed` and `check-review.ts`'s
`CheckReviewDeps.isSelfReviewAllowed`. Convert that one closure from sync to async
at both real call sites, in the same PR as the getter change.

**Acceptance criteria:**
- `readAllowSelfReview` reads DB-first (via APM-1.5's `/agents/:id/config`
  passthrough), falling back to `state/agent-policy.md` then a hardcoded default,
  matching APM-1.2's shipped chain.
- `readAllowSelfReview`'s doc comment no longer references `worktree-reaper.ts`; it
  names `check-deploy.ts` and `check-review.ts` as the real callers.
- `check-deploy.ts`'s and `check-review.ts`'s `isSelfReviewAllowed` closures are
  converted from sync to async, with both call sites updated in this same task.
- Test decision: unit tests (`check-helpers.unit.test.ts`, `check-deploy.unit.test.ts`,
  `check-review.unit.test.ts`) updated for the DB-first order and the sync→async
  signature change. No existing coverage is retired — extended in place.

**Layer:** Shared
**Hours:** 3
**Complexity:** 3
**Model:** sonnet
**HITL:** no
**Safe to deploy standalone:** yes — same-PR atomic update (getter + both call sites
land together).
**Branch:** `feat/apm-1-4-allow-self-review-db-first`

### APM-1.6 — `readCleanupMergedWorktrees`/`readCleanupAfterDays` DB-first

**Description:** Migrate the 2 remaining cleanup getters using the same
DB→file→hardcoded pattern and sync→async conversion approach APM-1.4 establishes,
applied to `pr-state-reconciler.ts`'s sync call sites (`readCleanupMergedWorktrees`,
`readCleanupAfterDays`, ~lines 1645/1661). Update `docs/configuration.md`'s Source
column for these 2 fields from "file only" to the three-tier chain.

**Acceptance criteria:**
- `readCleanupMergedWorktrees` and `readCleanupAfterDays` read DB-first (via APM-1.5's
  passthrough), falling back to `state/agent-policy.md` then a hardcoded default.
- `pr-state-reconciler.ts`'s two sync call sites (~lines 1645/1661) are converted to
  async in the same PR as the getter change.
- `docs/configuration.md`'s Source column for these 2 fields is updated from "file
  only" to the three-tier DB→file→hardcoded chain.
- Test decision: unit tests (`check-helpers.unit.test.ts`, `pr-state-reconciler.unit.test.ts`)
  updated for the DB-first order and the async conversion. No existing coverage is
  retired — extended in place.

**Layer:** Shared
**Hours:** 3
**Complexity:** 3
**Model:** sonnet
**HITL:** no
**Safe to deploy standalone:** yes — same-PR atomic update (getter + call sites land
together).
**Branch:** `feat/apm-1-6-cleanup-fields-db-first`

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

### Breaking Change Safety

All 3 tasks are additive or same-PR atomic-update (sync→async signature changes
update their own call sites in the same task). Safe to deploy standalone: yes, for
all 3.

## Decision Log

- Scope of APM-1.4's DB-first migration: narrowed to `readAllowSelfReview` only,
  matching APM-1.2's already-shipped design, rather than amending APM-1.2's
  merged/open PR — approved by Dan (Slack, 2026-09-29).
- The 2 cleanup fields' DB-first migration: opened as its own task (APM-1.6)
  rather than accepted as a permanent file-only gap, because `state/agent-policy.md`
  is slated for eventual removal — approved by Dan (Slack, 2026-09-29).

## HITL scan

No tasks require human steps — APM-1.5/1.4/1.6 are all ordinary code changes (an
additive API response field, a getter migration, and matching call-site async
conversions) with no infra/secret/console keywords or judgment triggers. All 3 are
flagged `HITL: no`.
