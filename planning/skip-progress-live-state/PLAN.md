# Plan: skip-progress-live-state

Repo: app-vitals/shipwright

## Problem

Another agent reported PRs auto-blocked by the skip streak although their own code was fine (2026-10-08, 16:59-17:56 UTC):

1. A patch run that did real work (pushed via `gh pr update-branch`, patch.md Step 2.5) ended `[silent]` and was counted as a skip.
2. Red CI inherited from the base branch re-selects the PR on every tick; patch judges the failure out of scope and exits, and nothing records that judgment.

## Findings

- Root cause of the reported incident (verified from Sentry logs): the `ok-wow` agent pod had not restarted since 2026-10-04 15:15 UTC and ran the 2026-10-02 build (plugin 1.349.1, same as this agent), which predates the progress-reset (#3960, 2026-10-07 21:52 UTC) and auto-clear (#3966) PRs. Every `[silent]` run, including two that did real work, was counted as a skip - the pre-#3960 behavior. Not a new bug in the progress check. Agent image rollout is a separate issue tracked outside this session.
- The update-branch gap below is real by code reading but was NOT demonstrated by the incident (the old build counted everything).
- The skip counter's "did real work" check (PSL-2.1 `prMadeProgress`) compares three PR-record fields: `commitSha`, `reviewedCommitSha`, `reviewState`. `gh pr update-branch` pushes a commit and writes none of them back (only worktree fix paths 4c.5/5c.5/6d.5 do), so it reads as no progress.
- PHS-3.1 already built a live-state reader (`agent/src/patch-outcome-check.ts`: head SHA, open finding refs, merge-dirty, CI failing). The skip counter does not use it, so two definitions of "progress" coexist.
- With PHS-3.1's first-occurrence escalation, inherited-red CI would now BLOCK on the first no-op patch run rather than loop. That needs a settle record, same pattern as PHS-1.2.

## Design (reuse the PHS-3.1 reader and PHS-1.2 ledger; one small shared helper)

1. Patch `[silent]` dispatches decide reset-vs-record from the existing live-state outcome (changed/settled -> resetSkip; unchanged -> existing recordSkip) instead of `prMadeProgress`.
   - **Plumbing.** `evaluatePatchOutcome` currently runs in `dispatch()` (`loop-orchestrator.ts` ~1594) after `dispatchScoped` returns, but the reset-vs-record choice is inside `dispatchScoped`'s `[silent]` branch (~1236-1244). SLS-1.1 moves the `before`/`after` snapshot pair (and the `evaluatePatchOutcome` call) into `dispatchScoped` for patch items, so the silent branch reads the outcome directly; `dispatch()` keeps only the escalation side effect, fed by the same outcome rather than a second snapshot.
   - **Overlap with PHS-3.1.** PHS-3.1 already escalates the `unchanged` case on first occurrence. For patch, `unchanged` therefore escalates and does NOT also call `recordSkip` (the skip streak is dropped for patch `[silent]` runs that escalate; `changed`/`settled` call `resetSkip`). Non-patch phases are untouched.
2. Inherited-red CI uses the PHS-1.2 ledger pattern: patch writes a patch-source `rejected` entry with ref `ci:{headSha}:{ciFailureSignature}` when it judges the failure not the PR's; candidacy and the snapshot skip CI-failing when that entry exists. A new head or a different signature re-qualifies. No base-branch CI comparison (that would be new logic).
   - **`ciFailureSignature` is a shared helper, not new per-site logic.** patch.md Step 6b already computes it (sorted, comma-joined names of failing jobs on the failing run; stored via `POST /prs/:id/patch`), but nothing in `agent/src` does. SLS-2.1 adds one helper in `agent/src` (next to `patch-outcome-check.ts`) taking the check-run list at `headSha` and returning the sorted, comma-joined names of checks with conclusion `failure`/`timed_out`; `check-patch.ts` candidacy and the `patch-outcome-check.ts` snapshotter both import it. patch.md Step 5c.5/SLS-2.2 keeps its existing `gh run view --json jobs` derivation, which must produce the same string (job names of failed jobs, sorted, comma-joined); SLS-2.1 pins this with a test fixture shared by both derivations so the three sites cannot drift.

## Out of scope / held

- check-deploy not calling `clearStaleSkipBlock` (inconsistent with patch/review): left alone as higher risk (decided).
- A review run counted as a skip (#2589, 17:04): explained by the stale agent image (pre-#3960), no separate bug.
- Agent image rollout / tenant pods not rolling with chart bumps: tracked in a separate session.

## Tasks

| ID | Title | Layer | Deps | Model |
|---|---|---|---|---|
| SLS-1.1 | Patch [silent]: reset or record skip from the live-state outcome | Background | - | sonnet |
| SLS-2.1 | Shared ciFailureSignature helper; honor a ci:{headSha}:{signature} rejected ledger ref in candidacy and the snapshot | Shared | - | sonnet |
| SLS-2.2 | patch.md: write the CI ref when a CI failure is judged not the PR's | CLI | 2.1 | sonnet |
| SLS-1.2 | Patch live-state "changed" resets the streak even with a no-op skip-reason marker | Background | 1.1 | sonnet |

All separate PRs, safe to deploy standalone; additive except SLS-1.1 may delete `prMadeProgress` for patch if it becomes dead code.

## Follow-up found after SLS-1.1 merged

SLS-1.1 gates the live-state reset on `!skipReasonMarker` (kept from PSL-2.1). A patch run whose only work was `gh pr update-branch` (Step 2.5) reaches Step 3d and emits `[skip-reason:patch:deferred:no-op-at-dispatch:{pr}]`, so it still records a skip even though the head moved. SLS-1.2 fixes this: for patch, live-state changed/settled resets regardless of that marker; unchanged live state still records the marker's reason. Review/deploy marker behavior is untouched.

## Decision Log

- Replace (not supplement) the record-field progress check for patch: two definitions of progress is how this arose.
- No base-branch CI comparison: reuse the ledger instead.
- Deploy clear-stale-block parity deferred.
- SLS-1.1 left as merged; marker gap handled by new task SLS-1.2 rather than editing a task already in flight.
