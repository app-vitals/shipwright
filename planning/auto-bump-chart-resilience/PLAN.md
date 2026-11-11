# Plan: auto-bump-chart-resilience

Repo: app-vitals/shipwright. Session: `auto-bump-chart-resilience`.

## Problem

`auto-bump-chart.yml` merges its own chart-bump PR in a single "Wait for checks and merge" step. On
2026-11-09 (run 42660246090, admin-v1.323.3) `gh pr merge --squash --admin` hit a transient GitHub
`GraphQL: Something went wrong while executing your query` error. The merge loop only retries the
stale-base error ("Base branch was modified"), so it gave up on attempt 1 and left PR #4910 open. Main
stayed on chart 1.32.85, so every later bump computed 1.32.86, collided with #4910's branch, and failed
after five attempts (agent-v1.456.6, admin-v1.323.5, ...). The stall lasted about 24 hours until the PR
was merged by hand. Two earlier stalls (#2542, #2570) are recorded in the merge step's comments.

Second weakness: `.github/workflows/test-auto-bump-chart.sh` (1,783 lines) holds hand-mirrored copies of
the workflow's inline bash ("keep both copies in sync"), but no workflow, package.json script or bun test
runs it. Edits to the workflow are effectively unverified.

## Design

Fix at the source; no new automation layer that comes back to merge after a failure (rejected: a
"finisher" for stalled bump PRs, see Decision Log).

- ABR-1.1 runs `test-auto-bump-chart.sh` and `test-check-chart-drift.sh` in the existing required CI job
  (no new check name), confirms they pass in a clean environment (fixing real failures in the same PR),
  and makes sure they run when only a workflow file changes. A content test asserts ci.yml invokes both.
- ABR-1.2 broadens the merge retry in `auto-bump-chart.yml` from stale-base only to also cover transient
  GitHub errors (the GraphQL "Something went wrong" message and 5xx), with a short backoff, and after the
  last attempt re-reads `gh pr view --json state` and treats an already-MERGED PR as success. Anything
  else (conflict, auth, branch protection) still fails fast. The mirrored copy in the test script gets
  matching cases (transient error retried, already-merged treated as success, non-transient still fails).

## Tasks

| Task | Depends on | Layer | Model | Safe standalone |
|---|---|---|---|---|
| ABR-1.1 ci: run test-auto-bump-chart.sh and test-check-chart-drift.sh in CI | none | Shared | sonnet | yes |
| ABR-1.2 fix: retry transient GitHub errors when merging the chart bump PR | ABR-1.1 | Shared | sonnet | yes |

Dependency map: `[START] -> ABR-1.1 -> ABR-1.2`. Both edit `auto-bump-chart.yml` and its test script, so
they serialize. 1.1 goes first so 1.2 lands under CI verification.

## Out of scope / follow-ups

- The same stale-base-only retry exists in `scripts/platform-bump-gate.sh` (has a bun unit test) and
  `.github/workflows/sync-plugin-version.yml` (`test-sync-plugin-version.sh`). Same one-line fix; not
  included here to keep this change small. File separately if wanted.
- Sourcing shared functions from `.github/workflows/lib/` instead of mirroring them in the test script.
- Whether `patch` should touch `automated`-labeled PRs: `check-review.ts:516` excludes them, `check-patch.ts`
  has no equivalent.

## Decision Log

- Stalled-PR finisher (merge green `automated` bump PRs after the workflow failed): rejected by the
  owner. Prefer fixing failures at their source over a second layer that merges after automation failed.
