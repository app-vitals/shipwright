# Plan: skip-progress-live-state

Repo: app-vitals/shipwright

## Problem

Another agent reported PRs auto-blocked by the skip streak although their own code was fine (2026-10-08, 16:59-17:56 UTC):

1. A patch run that did real work (pushed via `gh pr update-branch`, patch.md Step 2.5) ended `[silent]` and was counted as a skip.
2. Red CI inherited from the base branch re-selects the PR on every tick; patch judges the failure out of scope and exits, and nothing records that judgment.

## Findings

- Timeline: the incident predates the patch-handled-state PRs (merged 19:06-19:54 UTC the same day). The progress-reset (#3960) and auto-clear (#3966) PRs merged 2026-10-07 21:52 / 22:14 UTC, so were probably live.
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
- A review run counted as a skip (#2589, 17:04): cause unknown, needs the run's `skipReason` and the PR record from the other agent; to be added as a defined task once diagnosed with the owner.

## Tasks

| ID | Title | Layer | Deps | Model |
|---|---|---|---|---|
| SLS-1.1 | Patch [silent]: reset or record skip from the live-state outcome | Background | - | sonnet |
| SLS-2.1 | Shared ciFailureSignature helper; honor a ci:{headSha}:{signature} rejected ledger ref in candidacy and the snapshot | Shared | - | sonnet |
| SLS-2.2 | patch.md: write the CI ref when a CI failure is judged not the PR's | CLI | 2.1 | sonnet |

All separate PRs, safe to deploy standalone; additive except SLS-1.1 may delete `prMadeProgress` for patch if it becomes dead code.

## Decision Log

- Replace (not supplement) the record-field progress check for patch: two definitions of progress is how this arose.
- No base-branch CI comparison: reuse the ledger instead.
- Deploy clear-stale-block parity deferred.
