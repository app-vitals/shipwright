# Plan: unblock-unify

Session: `unblock-unify` · Repo: `app-vitals/shipwright` · Requested by Dan

## Problem

`POST /tasks/:id/unblock` hardcodes `status='pending'`. `unblock.md` Step 6 works
around it: task with a PR gets a hand-written `PATCH` to `pr_open` (non-atomic —
`TaskService.update()` is a plain Prisma update that leaves `claimedBy`/`claimedAt`/
`heartbeatAt`/`skipCount`/`lastSkippedAt`/`lastSkipReason` stale); task without a PR
gets `/unblock`; PR-only records get `PATCH /prs/:id` plus `/prs/:id/skip/reset`.
There is no path to `merged`/`deployed`/`released` (only unblock→pending then PATCH,
which lets dev-task open a duplicate PR), and nothing resets a PR's
`consecutiveCiFailureCount`. Separately, `recordSkip()` and the stale-claim reaper set `hitl:true` when they
auto-block, and several skills PATCH `blocked` + `hitl:true`.

## Design

**1. `POST /tasks/:id/unblock` accepts optional `{ to }`** —
`pending | pr_open | merged | deployed | released`.
- Keeps the single conditional `UPDATE … WHERE status='blocked'`; target status is a
  parameter. Clears claim + skip fields for every target (the
  `pending ⇒ claimedBy IS NULL` CHECK still holds).
- Validation: `pr_open`/`merged`/`deployed`/`released` require non-null `task.pr`
  (400), matching the existing `update()` pr_open guard. Terminal targets stamp
  `mergedAt`/`deployedAt`/`releasedAt` if empty.
- No `to` → inferred: no `task.pr` → `pending`; PR row `open` → `pr_open`;
  PR row `merged` → `merged`; PR row `closed` unmerged → **409** requiring explicit `to`.
  Inference never yields `deployed`/`released` (explicit only).
- Response reflects the resolved status; `TaskEvent` records the real transition.

**2. `POST /prs/:id/unblock`** — atomically resets `blocked`, `blockedReason`,
`blockedHeadSha`, `skipCount`, `lastSkippedAt`, `consecutiveCiFailureCount`,
`lastCiFailureSignature`; records a `PullRequestEvent`; 409 if not blocked.
`/prs/:id/skip/reset` stays.

**3. `unblock.md` Step 6** collapses to one call per item (task → task unblock,
PR-only → PR unblock); human may override `to`.

**4. Blocking no longer sets `hitl`.** `recordSkip()` (`task-store/src/task-service.ts`)
already dropped `data.hitl = true` (UBL-3.1, shipped as #4937). Still to do: drop the matching
`skipData.hitl = true` in the stale-claim reaper (`task-store/src/stale-claim-reaper.ts`), which
auto-blocks when `computeSkipStreak` crosses the threshold, and update its stale comment
(UBL-3.3);
drop `"hitl": true` from the block PATCHes in `plan-session.md` (6 places),
`dev-task/task-lifecycle.md`, and the plan-session methodology contract. Already-blocked
tasks with `hitl:true` are not backfilled. Blocked tasks stay out of the ready set via
`status='blocked'`; patch/patch-lean already treat `hitl || blocked` as the escalation signal.

## Breaking Change Safety

Additive endpoints. One behavior change: a no-body `/unblock` on a task with a PR
previously gave `pending` (duplicate-PR hazard), now `pr_open`/`merged`. Only
programmatic caller is `unblock.md`, which already routes around it. Generated admin
types (`admin/src/coding/task-store-types.ts`) regenerate in the API tasks.
Safe to deploy standalone: yes (all tasks).

## Tasks

| Task | Title | Layer | Model | Depends on |
|---|---|---|---|---|
| UBL-1.1 | feat: add `to` target and PR-state inference to `POST /tasks/:id/unblock` | API | sonnet | — |
| UBL-1.2 | feat: add `POST /prs/:id/unblock` | API | sonnet | 1.1 |
| UBL-2.1 | docs: collapse `unblock.md` Step 6 to one call per item | CLI | haiku | 1.1, 1.2 |
| UBL-3.1 | fix: stop setting `hitl` when `recordSkip()` auto-blocks — **shipped (#4937)** | API | haiku | — |
| UBL-3.3 | fix: drop `skipData.hitl` in the stale-claim reaper; update its tests and the stale comment | API | haiku | — |
| UBL-3.2 | docs: drop `hitl:true` from block PATCHes in skills | CLI | haiku | 3.1, 3.3 |

```
[START]
  ├─ UBL-1.1
  │     └─ UBL-1.2 (serialized after 1.1: both regenerate the admin types file)
  │           └─ UBL-2.1 (needs 1.1, 1.2)
  ├─ UBL-3.1 (shipped)
  │     └─ UBL-3.2 (needs 3.1, 3.3)
  └─ UBL-3.3
        └─ UBL-3.2
```

## Decision Log

- Closed-unmerged PR with no `to`: 409 requiring explicit target (Dan, confirmed).
- `deployed`/`released`: explicit-only, never inferred (Dan, confirmed).
- `hitl` on unblock: untouched, because blocking no longer sets it (Dan).
- UBL-1.2 depends on UBL-1.1 purely to avoid merge conflicts on the generated types file.
