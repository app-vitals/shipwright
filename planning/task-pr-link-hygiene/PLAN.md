# Plan: task-pr-link-hygiene

Repo: app-vitals/shipwright

## Background
Shipwright PR #4918 was never dispatched for review/patch/merge for ~15h. A stale `done` task
(`CFB-4.4`, `hitl: true`, `pr: 4918`, last updated 2026-09-02) was linked to the same PR number as
the real task (`APP-4.2`). `mergeLinkedTasks` (`agent/src/coding/check-helpers.ts`) ORs `hitl`
across every linked task, so `isTaskBlockedForDispatch` returned true and the loop dropped the PR
as `task-blocked`. That skip logged no task ids and left no cron-run row, so it was invisible.
The data was repaired by hand (`CFB-4.4.pr = null`).

Findings that shaped scope:
- The bare PR record (no `commitSha`/`authorLogin`/`headRef`/`title`) is by design: `pr_open`
  stamps only `origin`; the other fields arrive via review/patch claim or the merged-PR census
  sweep. It did not cause the skip. No task.
- Tasks have no `prNumber` field (only `pr`, `prUrl`, `prCreatedAt`). Nothing to remove.

## Design
1. `mergeLinkedTasks`: only non-terminal tasks (not done/merged/closed/deployed) contribute
   `hitl` or the blocked override. All-terminal behaves as before.
2. `task-blocked` skip traces in check-review/check-patch/check-merge carry the offending linked
   task ids (+ hitl/status); the cron-run `skipReason` surfaces it in the `review:deferred:...` style.
3. task-store warns (log only, no rejection) when a task's `pr` is set to a number already held by
   another non-terminal task in the same repo on a different branch. `headRef` cannot be used as
   the check: it is null for open, unclaimed PRs.

## Tasks
| Task | Title | Depends on | Complexity / model | Branch |
|---|---|---|---|---|
| TLH-1.1 | fix: ignore terminal tasks when merging linked-task hitl/blocked | - | 2 / sonnet (bundle) | fix/tlh-linked-task-hygiene |
| TLH-1.2 | feat: include linked task ids in task-blocked skip traces and cron-run skipReason | - | 3 / sonnet | fix/tlh-linked-task-hygiene |
| TLH-2.1 | feat: warn on colliding task pr links in task-store | - | 3 / sonnet | feat/tlh-2-1-warn-colliding-pr-links |

TLH-1.1 and TLH-1.2 share a branch and touch the same files; the bundle runs at the highest tier.
All tasks are safe to deploy standalone (additive or behavior-narrowing, no renames/removals).

## Decision Log
- Bare PR records: no task; by design (stampOrigin writes origin only at pr_open).
- Task `prNumber`: no task; field does not exist on tasks.
- TLH-2.1: warn-only, collision check only; headRef check dropped (null on open PRs).
