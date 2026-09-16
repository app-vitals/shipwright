# Plan Session: sessions-list-filter-fix

Repo: app-vitals/shipwright

## Input

Verbal report (Dan, Slack): on the Sessions list page (`/admin/sessions`), filtering by
Org and Agent both appear broken.

## Investigation

Reproduced against the live task-store directly (`GET $SHIPWRIGHT_TASK_STORE_URL/sessions`)
rather than guessing from code alone. Two distinct, unrelated root causes:

**Agent filter — genuine code bug in `admin/src/admin-ui-sessions-list.ts`, shipped by
PR #3504 ("sessions-pt-agent-names").** The Agent `<input>` offers a `datalist`
autocomplete of agent *names* (`agentService.listOptions()`), but
`registerSessionsListRoutes`'s handler forwards whatever value is submitted straight
through as `agentId` to task-store (`params.set("agentId", agentId)`). Task-store's
`agentId` filter (`session-service.ts`'s `list()`) matches against real agent IDs —
`rollup.agentIds`, sourced from `task.assignee`/`task.claimedBy` — not display names.
Live curl confirms the API-level filter itself works correctly (`agentId=<bogus-id>` →
0 results), so the bug is entirely that the admin route never resolves the typed name
to an ID before querying. The Tasks page (`admin/src/admin-ui.ts`, ~line 3086) already
solves the identical problem: it calls `agentService.searchByName(agent)` to resolve
the name into a `Set` of matching IDs, fetches a larger page from task-store, then
filters/re-paginates client-side. Sessions never got that step.

**Org filter — not a code bug; a deploy lag, confirmed live, no task queued.**
`GET /sessions?org=<anything>` returns the same total as no filter at all — the param
is being silently dropped. But the fix (PR #3490, `session-service.ts`'s `org` filter,
merged 2026-09-16 08:40 PT, integration-tested, included in tag `task-store-v1.140.0`
cut 22:03 UTC the same day) is legitimately merged and correct — confirmed by contrast,
since `GET /tasks?org=<bogus>` (an older, already-deployed org filter) correctly
returns 0. The running task-store pod simply predates that build. Rechecked twice,
~15 minutes apart — still stale as of this plan. This needs a recheck once the deploy
catches up, not a code change, so no task is queued for it.

Verified with no issues found (no task needed): `repo` filter, `q` (search) filter, and
pagination/sort all work correctly on both `/sessions` and `/tasks` at the API level.

## Design

**SLF-1.1 (admin, API layer)** — fix the Sessions page Agent filter:
- Extract the Tasks page's inline "resolve agent name → matching ID set → fetch a
  larger page → filter client-side → re-paginate" logic (`admin-ui.ts` ~lines
  3086-3155) into one shared helper, since it will now have two identical call sites
  instead of one bespoke copy. Natural home is alongside `renderRepoOrgFilterFields()`
  in `admin-ui-pages.ts`, which is already shared between the Tasks and Sessions pages
  for the same reason.
- `registerSessionsListRoutes`'s handler calls the new helper instead of
  `params.set("agentId", agentId)`: resolve `?agent=` via `agentService.searchByName()`,
  drop the raw `agentId` forward to task-store entirely (task-store's `agentId` filter
  takes one exact ID, not a fuzzy/multi-match name), fetch a larger page when the
  filter is active (mirroring the Tasks page's bump to `limit=500`), filter `sessions`
  to `session.agentIds.some(id => matchedIds.has(id))`, recompute `total`, and slice
  for the requested `offset`/`limit`.
- No HTML/template changes — the Agent `<input>` + datalist markup already correctly
  suggests names; only the server-side resolution changes.
- Purely additive/corrective in-memory logic — no schema or API contract change.

Safe to deploy standalone: yes — no renames/removals, no schema change.

## Decision Log

- No task queued for the Org filter: it's a deploy-lag issue on already-merged,
  already-correct code, not an engineering task. Re-verify after the next task-store
  deploy cycle; only investigate the deploy pipeline itself if still broken after a
  reasonable wait.
- Shared helper extraction (rather than a second inline copy in
  `admin-ui-sessions-list.ts`): the "resolve name → IDs → filter → re-paginate" logic
  is non-trivial (list-then-slice pagination math) and would otherwise exist twice,
  identically, across the Tasks and Sessions routes.

## Task Breakdown

| Task | Title | Layer | Complexity | Model | Hours | Depends on | HITL |
|---|---|---|---|---|---|---|---|
| SLF-1.1 | Fix Sessions page Agent filter to resolve names to agent IDs | API | 3 | sonnet | 3 | — | |

### Dependency graph

```
[START]
  └─ SLF-1.1: fix Agent filter name→ID resolution (no deps)
```

HITL scan: no tasks require human steps.
