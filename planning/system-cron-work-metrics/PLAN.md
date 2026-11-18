# Plan: system-cron-work-metrics (revision 2, 2026-11-17)

Replaces the SCM-1.1 / 3.x / 4.x / 5.2-5.4 / 6.1 / 7.1 set, all cancelled or superseded. Tasks SCM-2.1, SCM-2.2 and SCM-5.1 are unchanged.

## Design

Per-cron work metrics are derived from signals that already exist and that the reconcilers already keep consistent: task status, Task.pr / prCreatedAt / mergedAt, PR state, and originKind/originRef. There is no Task.outcome or outcomeReason, no originTaskId, no PR size columns and no schema change.

- Origin is the cron id, written by the skill itself. test-readiness passes its cron id to test-fix and research-docs --auto stamps its own. Follow-on tasks carry originKind "cron" and originRef = cron id (the same value SCM-2.2 gives the SC- tasks). Nothing is passed through the scheduler or dev-task.
- Buckets per SC- task: shipped = PR merged (or task merged/deployed/released); in flight = PR open under 24h; stuck = PR open over 24h or task blocked; failed = task cancelled; no-op = task done with no PR; pending = not yet run.
- Follow-ons = tasks with originKind=cron, the cron's originRef and source other than system-cron.
- Metrics counts use the metrics service's account-wide token. Agent-token task lists are repo-scoped by design.

## Why not outcome / originTaskId / PR size

Task status is written by many components (dev-task, review/patch/merge/deploy phases, the PR-state and claim reconcilers, the stale-claim reaper, the GitHub repo-removal reconcile, humans). A skill-written outcome would be a second state machine none of them maintain: failed+done, stale failed after unblock, stale shipped after a reaper reset. originTaskId needs plumbing through scheduler, dev-task and skills for per-run grouping nobody asked for. PR size only exists to separate trivial merges, which is not worth a census change.

Known limits: a trivial docs PR counts as shipped; follow-ons are attributed per cron and range, not per fire; a manual test-readiness run may be stamped as cron (accepted).

## Tasks

| Task | Title | Depends on |
|---|---|---|
| SCM-8.1 | fix: open a PR with completed test-readiness phases when a later phase fails | none |
| SCM-8.2 | feat: stamp the cron id as origin on test-fix and research-docs follow-on tasks | SCM-2.2 |
| SCM-8.3 | feat: add /metrics/system-crons aggregation derived from task status and PR state | SCM-2.2, SCM-5.1 |
| SCM-8.4 | feat: show the system cron tile with as-of time and row links | SCM-8.3 |
| SCM-8.5 | docs: document agent repo scoping and the derived-bucket rules | SCM-8.3 |

SCM-7.1 is superseded by SCM-8.3 (its per-cron task count is part of the aggregation). The per-repo run grid (old SCM-6.1) is deferred.

```
SCM-2.2 ─┬─ SCM-8.2
         └─ SCM-8.3 ─┬─ SCM-8.4
             ▲       └─ SCM-8.5
          SCM-5.1
SCM-8.1 (no deps)
```

All additive and safe to deploy standalone. No HITL tasks.
