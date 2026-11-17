# Product Spec: Default branch on system-cron fired tasks

## Problem

System crons (`test-readiness`, `docs-freshness`) fan out one task per repo via `SystemCronService.fire()`. `fire()` builds each task's `Prisma.TaskCreateManyInput` without a `branch` field, so every system-cron-created task starts with `branch: null`.

`dev-task`'s own lifecycle rules block any claimed task with no branch (`blockedReason: "missing_branch"`), per `plugins/shipwright/references/dev-task/task-lifecycle.md`. This isn't a hypothetical — it fired in production on 2026-11-17: both crons' first-ever run produced tasks that got auto-blocked (or would have, had they been claimed) as soon as an agent picked them up, requiring a manual `branch` PATCH + `/unblock` call on 24 tasks to recover.

No code anywhere in the repo currently derives a default branch from a task id — the `feat/{id-lowercase}` convention is documented (task-store skill, `POST /tasks` reference) but never enforced. This is a gap, not a regression.

## What "fixed" looks like

Every task `fire()` creates has a non-null `branch` at creation time, following the existing `feat/{id-lowercase}` convention, so it is immediately claimable and workable by `dev-task` without manual intervention.

## Out of scope

- Backfilling already-fired tasks (already hand-patched for the 2026-11-17 batches; `fire()` is idempotent per `(cronId, scheduledFor)` slot, so this only affects future fires).
- Repo-scoping of the fan-out (handled separately — Dan reconfigured both definitions to `repoScope: "selected"` with the current agent-fleet repo list).
