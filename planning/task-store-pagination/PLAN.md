# Plan: task-store-pagination

Initiative: SWI-8 — Task store: cursor pagination (split out of SWI-7, task store at scale).
Home repo: `app-vitals/shipwright`. Single session, one PR per task.

## Pass 1 — 2026-11-18 — SWI-8 (no separate spec; the initiative description is the spec)

### Problem

List endpoints page with `?limit`/`?offset`. Observed problems:

- `GET /tasks` orders by `createdAt` alone. Rows from one bulk POST share timestamps (4 tied groups of up to 11 rows in the live store), so page boundaries inside a tie are not deterministic.
- The admin board fetches one 200-row window (`BOARD_TASK_LIMIT`) and derives column counts from the page (`colTasks.length`), so counts and cards are silently truncated.
- Several callers hand-roll "page until short" loops over offsets, including the reconciler's rotating-offset scan, which skips rows when the filtered set shrinks between ticks.

### Design

**Contract (additive first, offset removed last).** List routes accept `?cursor=` with `?limit=` and return `nextCursor` (string, or `null` on the last page) alongside the existing endpoint-specific array key, `total` and `limit`. `nextCursor: null` is the only end-of-list signal; there is no separate coverage/hasMore field. `offset` keeps working until the final task. Sending both `cursor` and `offset` is a 400. A malformed cursor is a 400.

**Cursor is opaque.** Callers never inspect it, so each endpoint chooses its own implementation.

- `GET /tasks`: keyset. The cursor encodes the last row's `(createdAt, id)`. The query is `WHERE createdAt > c OR (createdAt = c AND id > i)` with `ORDER BY createdAt, id`; `?sort=desc` flips both comparisons. The `id` tie-break lives in the cursor and the ordering. Resuming works even if the cursor row was deleted or no longer matches the filter (Prisma's native `cursor:{id}` would not).
- Endpoints whose ordering is derived in memory (e.g. session rollups) may wrap an internal offset behind the same opaque cursor.
- `?ready=true` and `?state=blocked` walk the whole dependency graph and return `nextCursor: null`.

**Admin.** The board queries each column separately with its own `total` and a "Load more" button, removing `BOARD_TASK_LIMIT` and the need for a truncation banner. Column placement is computed client-side today (`bucketTaskColumn`, status plus PR blocked state), so each column needs a server-side filter (`?column=`). Tables move from "page N of M" to Prev/Next with a cursor stack.

**Agent.** Reconcilers (`pr-state-reconciler.ts`, `pr-census.ts`, `claim-invariant-reconciler.ts`) follow `nextCursor` until null. The rotating scan in `fetchPrOpenTasksBatch` stores the last cursor string instead of an offset count, preserving cross-tick rotation (RCB-1.1) and no longer skipping rows as `pr_open` tasks merge.

**Docs/skills.** The `task-store` skill (`plugins/shipwright/skills/task-store/SKILL.md`) documents the contract and a single "follow `nextCursor` until null" snippet; other docs point to it.

### Tasks

| Task | Title | Layer | Depends on | Complexity / model | Hours |
|---|---|---|---|---|---|
| TPG-1.1 | feat: keyset cursor helper and nextCursor on GET /tasks | API | — | 4 / sonnet | 4 |
| TPG-1.2 | feat: cursor on remaining list endpoints plus guard test | API | 1.1 | 4 / sonnet | 5 |
| TPG-1.3 | feat: server-side column filter for board columns on GET /tasks | API | 1.1 | 3 / sonnet | 3 |
| TPG-2.1 | feat: admin board per-column queries with Load more | Frontend | 1.3 | 4 / sonnet | 4 |
| TPG-2.2 | refactor: admin tables to Prev/Next cursor paging | Frontend | 1.2 | 3 / sonnet | 4 |
| TPG-2.3 | refactor: agent reconcilers, census, metrics client, scripts and skill/doc snippets off offset | Background | 1.2 | 3 / sonnet | 4 |
| TPG-3.1 | refactor: remove ?offset from list endpoints | API | 2.1, 2.2, 2.3 | 2 / haiku | 2 |

### Dependency Map

```
[START]
  └─ TPG-1.1 keyset cursor on /tasks
        ├─ TPG-1.2 cursor on other list endpoints + guard test + task-store skill
        │     ├─ TPG-2.2 admin tables Prev/Next
        │     └─ TPG-2.3 agent reconcilers + metrics client + scripts + docs/skills off offset
        └─ TPG-1.3 ?column= filter
              └─ TPG-2.1 board per-column + Load more
TPG-3.1 remove ?offset  (needs 2.1, 2.2, 2.3)
```

### Breaking Change Safety

Add → migrate → remove. 1.x add the cursor contract alongside `offset`; 2.x migrate every consumer; 3.1 removes `offset` only after all consumers have migrated. 1.x, 2.x are safe to deploy standalone. 3.1 is the only removal and depends on all migrations.

Consumers of `offset` found: `agent/src/coding/pr-state-reconciler.ts`, `pr-census.ts`, `claim-invariant-reconciler.ts`; admin `admin-ui-coding.ts`, `admin-ui-sessions-list.ts`, `admin-ui-work-item-pages.ts`, `verification-checks.ts`, `reconcile-open-work.ts`, `system-cron-schedule.ts`; docs/skills `task-store`, `pull-requests`, `merge.md`, `investigate-stuck`, `patch/guards-ci.md`, and the offset wording in the prompt-fix/entropy-fix/consolidation-fix/error-fix skills. Also found on review and assigned to TPG-2.3: `metrics/src/lib/task-store-client.ts` (`fetchAllPages` loops on `offset` over `/tasks`, `/prs`, `/coverage-snapshots`; its `PageEnvelope` reads `offset`, and `metrics/src/types.ts` / `providers/task-store-provider.ts` carry offset fields), `scripts/register-planning-sessions.ts` (`/tasks?...&offset=`), `agent/scripts/backfill-pr-origin.ts` (offset loop over `/tasks`), and `plugins/shipwright/references/user-guide.md` ("loop on `offset`" wording). The endpoint reference docs `docs/task-store.md` and `docs/task-store-pr-tracking.md` document `offset` too: the contract goes in with TPG-1.2 and the `offset` wording is removed in TPG-3.1. The 2.x tasks must re-grep for callers before closing.

### Decision Log

- Cursor vs offset: chose cursor with `nextCursor` as the sole completeness signal — maintainer: `nextCursor: null` equals "no more", so a separate coverage field is redundant.
- Keyset for `/tasks`, opaque-per-endpoint elsewhere — maintainer: simplest, expected, easiest to maintain; tie-break baked into the cursor.
- Board: per-column queries with Load more, no truncation banner — maintainer: the board was a grokable window, the table is the full-data view; scope increased so truncation goes away.
- Remove `offset` (TPG-3.1) after migration — maintainer: remove if cursor is a priority; it is.
- Dedup-scan skills' `limit=1000` snippets are not restructured (maintainer: they still work and the dedup scan may be reworked separately); only their offset wording changes in TPG-2.3.
- Reconciler rotating scan keeps cross-tick rotation by storing the last cursor string — sanity-checked against `fetchPrOpenTasksBatch`; behaviour of RCB-1.1 preserved.
- Owner left empty — SWI-8 carries no owner.
- TPG-1.3 starts by confirming PR blocked state is expressible as a server filter; if not, split it and flag.
- `task-store` skill update lands with TPG-1.2 (contract defined there); the rest of the docs stay in 2.3 and 3.1.
- Review found missed `offset` callers (metrics client, `register-planning-sessions.ts`, `backfill-pr-origin.ts`, user-guide) — folded into TPG-2.3 rather than a new task, since they are the same "follow `nextCursor` until null" migration; TPG-3.1 still depends on 2.3.
