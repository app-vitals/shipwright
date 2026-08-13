# Plan Session: review-allowlist-vetted

**Repo:** app-vitals/shipwright
**Origin:** live incident — `ok-wow/ok-wow-ai#1919` (okwow agent) stuck unable to get a
re-review after the PR author patched, diagnosed 2026-08-13. Core fix (`AAL-3.2`) was filed
directly via `POST /tasks` before this plan session existed — this session is the retroactive
planning pass, run to confirm the fix is correctly scoped and to investigate a related open
question before deciding whether any follow-up work is needed.

## Root cause (confirmed live)

`getReviewCandidates()` in `agent/src/check-review.ts` applies the `isAuthorAllowed()`
exclusion unconditionally, before the task-store `PrRecord` is even looked up. On okwow
(`authorAllowlist: ["dmcaulay"]`), PR #1919's author (`zayyen-p`) is not on the allowlist —
so every commit after the PR's *first* review cycle gets permanently excluded from
candidacy, even though a real review cycle already completed and the author is actively
responding to reviewer feedback.

Confirmed via the task-store PR record and `shipwright-loop` run history: two review cycles
completed successfully (2026-08-12 21:29 UTC, 2026-08-13 18:45 UTC — both
`reviewState:"posted"`), but a third commit pushed after the second review was permanently
stuck — Sentry `ourlogs` showed `check-review` logging `{"check":"not-allowlisted"}` every
tick since, and the live `GET /agents/{id}/work-queue` snapshot excluded the PR entirely.

**Fix (`AAL-3.2`, already in progress, claimed by `doc`):** only apply `isAuthorAllowed()`
when no `PrRecord` exists yet for the PR. Once a PR has entered the review pipeline once —
meaning it already passed the allowlist gate — later commits on that same PR stay eligible
for re-review regardless of author, and fall through to the PR's normal
commitSha/reviewState dedup logic. This doesn't reopen the self-request-defeat concern the
original `isRequestedReviewer`-doesn't-bypass-allowlist design guarded against (see the
comment above that computation in `check-review.ts`): a non-allowlisted author still can't
manufacture that first `PrRecord` solo.

## Investigation: how did the first two cycles get through the allowlist at all?

This was an open question when `AAL-3.2` was filed. Resolved during this session — **not a
bug, working as designed**:

- **Cycle 1** (2026-08-12 21:29:39 UTC): the okwow pod had booted 45 seconds earlier
  (`21:28:54 UTC — "[agent] config sync started (60s interval)"`). `agentAuthorAllowlistRef`
  (`agent/src/agent-author-allowlist-ref.ts`) defaults to `[]` until the first sync tick
  completes, and `check-review.ts`'s `isAuthorAllowed` closure treats an empty allowlist as
  "unfiltered" (`authorAllowlistRef.get().length === 0`). For that ~60s pre-sync window, the
  allowlist was effectively wide open.
- **Cycle 2** (2026-08-13 18:45:48 UTC): that pod had booted ~12 hours earlier — not a boot
  race. But `agent-author-allowlist-ref.ts`'s own doc comment documents a previously-observed
  production issue (Sentry issue 7633628941) where the config-bundle API intermittently
  returns `authorAllowlist: null`, which `resolveAuthorAllowlist()` defaults to `[]` — the
  same fail-open effect, for one ~60s sync cycle, independent of pod age.

Both are instances of the *same* deliberate fail-open-on-sync-uncertainty design already
used for repo-scope filtering elsewhere in this file (`hasScopeSynced()` — "a config-sync
outage would silently exclude every repo from candidacy" is the documented rationale there).
`agentAuthorAllowlistRef` even exposes a `hasSynced()` method with the identical intent,
though `check-review.ts`'s `isAuthorAllowed` closure doesn't need to call it explicitly:
`get()` already returns `[]` in both the "never synced" and "deliberately empty" cases, so
the existing `.length === 0` check produces the correct fail-open behavior for free.
**Conclusion: this is intentional, not a defect. No fix needed.**

## Consistency check: check-patch.ts / check-deploy.ts

Neither file has any author-allowlist logic (`grep` confirmed zero references). Both operate
on the agent's own previously-opened PRs, where an external-author allowlist doesn't apply
— review is the only phase that filters candidates by a third-party PR author. No gap.

## Related work already in flight (no overlap, no action needed)

A separate, independently-triggered planning session — `review-candidacy-dedup-gap`
(`planning/review-candidacy-dedup-gap/PLAN.md`) — touched this same `getReviewCandidates()`
function this same day, fixing a *different* bug (selection vs. dispatch-time "already
reviewed" divergence). Its four tasks (RVD-2.1–2.4) were all merged 03:54–05:42 UTC, well
before `AAL-3.2` was created (22:42 UTC) — `AAL-3.2`'s worktree already includes those
changes. No conflict, no sequencing dependency.

## Conclusion

`AAL-3.2` (in progress) is a complete, correctly-scoped fix. **No follow-up tasks queued
from this session.**
