# Plan: platform-drift — self-merging platform release bump

Session: `platform-drift` · Repo: `app-vitals/shipwright`

## Context

`.github/workflows/platform-release.yml` (PLD-2.1) opens the `chore/platform-release`
bump PR and stops. The PR carries the `automated` label, so the review phase skips it
(`agent/src/coding/check-review.ts`), and it is authored by the `DISPATCH_TOKEN` owner so
it cannot be self-approved. It sits `REVIEW_REQUIRED`/`BLOCKED` indefinitely (seen on
#4519, the first 0.1.0 bump, which also blocks PLD-2.2).

`auto-bump-chart.yml` already solves this for chart bumps: after opening its PR it watches
required checks (rerunning failed ones up to 3 times) and then runs
`gh pr merge --squash --admin` with a stale-base retry, using the same `DISPATCH_TOKEN`.

## Design

One workflow change in `.github/workflows/platform-release.yml`:

1. Give "Open or update the bump PR" an `id` and write `pr_url` to `$GITHUB_OUTPUT`.
2. Add a final "Wait for required checks and admin-merge" step, gated on
   `steps.diff.outputs.changed == 'true'`, using `GH_TOKEN: DISPATCH_TOKEN` and the PR URL
   through env (never interpolated into the script). Same watch / rerun-failed (3 attempts)
   / `--squash --admin` / stale-base-retry pattern as `auto-bump-chart.yml`.
3. Raise the job `timeout-minutes` 15 -> 30.
4. Failure stays loud: the existing `failure()` step still opens/comments on the
   "platform release bump failed" issue; a PR failing CI is left open for a human.

No new secrets. `automated` and `platform-cutover` labels unchanged. The existing
`platform-release` concurrency group (no cancel-in-progress) already serializes runs.
This uses `--admin` merge; it does not depend on the repo's `allow_auto_merge` setting.

## Tasks

| ID | Title | Layer | Branch | Deps | HITL | Complexity / Model |
|---|---|---|---|---|---|---|
| PLD-2.3 | ci: have the platform release bump wait for checks and merge its own PR | Shared | `ci/pld-2-3-platform-release-self-merge` | - | no | 3 / sonnet |

Dependency map: `[START] -> PLD-2.3` (no deps). Safe to deploy standalone: yes (additive).

## Decision Log

- Unattended merge on green required CI: accepted (matches chart-bump behavior; the
  release chain exists to avoid hand-merging). Human-gate alternative rejected.
- `allow_auto_merge` is true on this repo despite bundle docs advising off: out of scope,
  flagged only.
- #4519 (the first bump) is admin-merged by hand; PLD-2.2 is unblocked after that merge.
