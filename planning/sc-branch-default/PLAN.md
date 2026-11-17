# Plan: Default branch on system-cron fired tasks

Session: `sc-branch-default`
Repo: `app-vitals/shipwright`

## Design

**Business logic (task-store service layer):**

- Add a pure helper `systemCronTaskBranch(taskId: string): string` to `task-store/src/system-cron-template.ts`, returning `` `feat/${taskId.toLowerCase()}` ``. This mirrors the existing `systemCronTaskId()` helper already in that file (same pure-helper style, same file, same "deterministic from inputs" contract) and matches the `feat/{id-lowercase}` convention already documented in the task-store skill (`POST /tasks` required-fields table) and in `dev-task`'s `missing_branch` lifecycle rule.
- In `task-store/src/system-cron-service.ts`, `fire()`'s task-mapping (the `tasks: Prisma.TaskCreateManyInput[] = repos.map(...)` block, ~line 434) adds `branch: systemCronTaskBranch(id)` alongside the existing `id` field — using the already-computed `id` (from `systemCronTaskId`) as the input, so the two stay in lockstep by construction rather than by convention.

No API, views, or DB schema changes — `Task.branch` already exists as a nullable column (`String?`) and is already read by the dev-task worktree-setup path; this only changes what `fire()` writes into it.

**Why this is safe to deploy standalone:** Purely additive — no task consumer currently asserts `branch: null` (confirmed: no test in the repo does), and setting a previously-null field can only unblock tasks, never break a path that depended on it being absent.

## Task

| Task | Title | Layer | Hours | Complexity | Model | HITL | Depends on | Blocks |
|---|---|---|---|---|---|---|---|---|
| SCB-1.1 | fix: set branch on system-cron fired tasks | Shared | 2 | 3 | sonnet | — | — | — |

**SCB-1.1**
- **Description:** Add `systemCronTaskBranch(taskId)` to `system-cron-template.ts` (returns `feat/{taskId.toLowerCase()}`, pairing with the existing `systemCronTaskId` helper). Use it in `fire()` (`system-cron-service.ts`) to set `branch` on every task created in a fire batch.
- **Acceptance criteria:**
  - Every task created by `fire()` has a non-null `branch` equal to `feat/{id-lowercase}` of that task's own id.
  - New unit test in `system-cron-template.unit.test.ts` covering `systemCronTaskBranch` (typical id, and an id with the `SC-{cronId}-{slot}-{owner}-{repo}` shape used in production).
  - Integration test coverage (extend `system-cron-service.integration.test.ts` or `system-cron-scheduler.integration.test.ts`) asserting a task created via a real `fire()` call has `branch` set — the existing suites only assert on task `id`, never on `branch`, so this is net-new coverage, not a retrofit of an existing assertion.
  - No existing test asserts `branch: null` on a fired task (confirmed by repo search) — nothing to retire.
- **Dependencies:** none
- **Branch:** `feat/scb-1.1-default-branch-system-cron`
- **Safe to deploy standalone:** yes (additive only; no rename/removal/constraint change)

## Dependency Map

```
[START]
  └─ SCB-1.1: fix: set branch on system-cron fired tasks (no deps)
```

```
Task    | Depends on | Blocks | HITL
SCB-1.1 | —          | —      |
```

## HITL scan

HITL scan: no tasks require human steps.

## Not carried

No `Success Criteria` / `Priorities & Sequence` sections in the spec — carry-through check not applicable.
