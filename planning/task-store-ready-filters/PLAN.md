# Plan Session: task-store-ready-filters

Repo: app-vitals/shipwright

## Background

Another agent reported that `?ready=true&session=agency-okwow-prod` returned a task
(`ASB-1.1`) belonging to a different session — the documented `?session` post-filter for
`GET /tasks` didn't appear to apply when combined with `?ready=true`.

## Root Cause

`task-store/src/routes/tasks.ts`'s `/tasks` handler branches early into
`taskService.listReady(agentId, repos)` whenever `?ready=true` or `?state=ready` is set
(`tasks.ts:559-566`). That branch reads only `agentId`/`repos` from the query string and
never reads `session` — or any of the other filters the general (non-ready) list path
supports. `TaskService.listReady()`'s signature (`task-service.ts:114,262`) only ever
accepted `(agentId?, repos?)`.

Cross-referencing against every filter the general `list()` path supports
(`TaskListFilters`, `task-service.ts:57-101`) confirmed this isn't isolated to `session` —
it's systemic. Silently dropped under `ready=true`: `session`, `source`, `repo`, `org`,
`claimedBy`, `pr`, `branch`, and admin-token `assignee` overrides. Two filters are *not*
bugs despite also being absent from `listReady()`'s signature:

- `hitl` — `ready` structurally excludes `hitl === true` tasks by definition
  (`ready.ts:80`); there is no contradiction-free way to ask for `?ready=true&hitl=true`.
- `requiresHumanApproval` — already correctly documented as non-excluding (Type B tasks
  ship through the ready set regardless of this flag).

`limit`/`offset`/`sort`/`updatedSince` are also unsupported under `ready=true`, but that is
pre-existing, intentional, and already documented (`docs/task-store.md:92-97`) — full-graph
dependency resolution needs every task, not a paginated/recency-windowed slice.

The docs (`docs/task-store.md:44-64`) present one unified filter table for `GET /tasks` and
only carve out the pagination/sort exception — nothing discloses that `session`/`repo`/`org`/
etc. are dropped under `ready=true`. That's the proximate cause of the leak: callers
reasonably assumed `session` composed with `ready=true` because the docs never said
otherwise.

**Note:** an in-progress, unrelated session (`RHA-1.1`–`1.5`) is removing
`requiresHumanApproval` from the schema entirely. This plan deliberately does not touch that
field to avoid colliding with that work.

## Design

Extend `TaskService.listReady()` to accept an optional filters object (`session`, `source`,
`repo`, `org`, `claimedBy`, `pr`, `branch`, `assignee`), applied as a **post-filter over the
already-resolved `ready` array** — never folded into the initial `findMany()`, since
dependency resolution requires the complete task graph (a filtered-out task may still be a
dependency of an in-scope task). This mirrors the existing `agentId`/`repos` post-filter at
`task-service.ts:273-281`. `repo`/`org` matching mirrors `buildRepoOrgWhere`'s semantics
(array-any-match for repo; `startsWith "<org>/"` for org; AND between the two).

**`assignee`'s combination with `agentId`/`repos` scoping — specified explicitly, since it
doesn't slot in cleanly:** in the plain `list()` path, `assignee` is a genuine `where`-builder
filter, so it composes uniformly — AND-narrows the `agentScope` OR union when repo scope is
present (`tasks.ts:624-633`), or otherwise directly replaces the token's own identity
(`assignee: agentId ?? c.req.query("assignee")`, `tasks.ts:638`). `listReady()` has no `where`
clause to fold an `assignee` filter into — its existing `agentId` param (`task-service.ts:262-284`)
*is itself* the OR-union predicate (`assignee === agentId OR (assignee === null AND repo in
repos)`), computed directly against the post-resolution `ready` array. The rule this plan
adopts, chosen to preserve the same narrowing-only safety property `list()`'s agentScope case
relies on:
- **When `agentId` is present** (agent token calling `?ready=true`): a caller-supplied
  `assignee` AND-narrows the `agentId`/`repos` OR-union result — i.e. `listReady()` first
  computes the existing `agentId`/`repos` union, then, if `assignee` was also supplied,
  additionally filters that result to `t.assignee === assignee`. This mirrors `list()`'s
  `agentScope` behavior (narrow-only, never widens what the token can already see) and is a
  no-op unless the caller passes an `assignee` that's a subset of what `agentId`/`repos`
  already permits.
- **When `agentId` is absent** (admin token calling `?ready=true`): `assignee` applies as a
  standalone equality filter (`t.assignee === assignee`) against the ready array — there is no
  token identity to replace (unlike `list()`'s no-`agentScope` branch, which replaces because
  the caller **is** an assignable identity there); an admin token has no identity of its own to
  fall back to, so `assignee` simply filters, matching how every other new filter
  (`session`/`source`/etc.) behaves when `agentId` is absent.

Thread the same query params through `tasks.ts`'s `ready=true`/`state=ready` branch
(currently `tasks.ts:559-566`), reading them the same way the fallback branch already does.

Update `docs/task-store.md`'s `ready` row and surrounding prose to state which filters now
apply under `ready=true` (all of the above), keeping the existing, correct carve-outs for
`limit`/`offset`/`sort`/`updatedSince` and the ready-specific `hitl`/`requiresHumanApproval`
semantics.

No OpenAPI schema change is required — `TaskListQuerySchema` (`openapi-schemas.ts:415`)
already declares all of these fields; they're just not being read on the `ready=true`
branch.

## Tasks

| Task | Title | Depends on | Blocks | HITL |
|---|---|---|---|---|
| TRF-1.1 | Fix `listReady()` to honor session/repo/org/source/claimedBy/pr/branch/assignee filters | — | — | — |

### TRF-1.1

**Description:** `?ready=true`/`?state=ready` silently drops every query filter except
`agentId`/`repos` (token-derived scope). Extend `TaskService.listReady()` to accept an
optional filters object covering `session`, `source`, `repo`, `org`, `claimedBy`, `pr`,
`branch`, `assignee`, applied as a post-filter over the already-resolved ready array. Thread
the same query params through `tasks.ts`'s `ready=true` branch. Update
`docs/task-store.md` accordingly.

**Acceptance Criteria:**
1. `TaskService.listReady()` accepts an optional filters param (`session`, `source`, `repo`,
   `org`, `claimedBy`, `pr`, `branch`, `assignee`), applied strictly *after*
   `resolveReadyTasks()` resolves the graph — mirrors the existing `agentId`/`repos`
   post-filter at `task-service.ts:273-281`. `repo`/`org` matching mirrors
   `buildRepoOrgWhere`'s semantics (array-any-match for repo, `startsWith "<org>/"` for org,
   AND between the two). `assignee` specifically: when `agentId` is present, AND-narrows the
   existing `agentId`/`repos` OR-union result (mirrors `list()`'s `agentScope` AND-narrowing,
   `tasks.ts:624-633`); when `agentId` is absent, applies as a standalone equality filter
   against the ready array (no token identity to replace, unlike `list()`'s no-`agentScope`
   branch at `tasks.ts:638`) — see Design section for full reasoning.
2. `tasks.ts`'s `ready=true`/`state=ready` branch reads `session`/`source`/`repo`/`org`/
   `claimedBy`/`pr`/`branch`/`assignee` from the query string (same parsing already used in
   the fallback branch) and forwards them into `listReady()` alongside `agentId`/`repos`.
3. `docs/task-store.md`'s `ready` row + prose are updated: session/source/repo/org/
   claimedBy/pr/branch/assignee apply identically under `ready=true`; `limit`/`offset`/
   `sort`/`updatedSince` remain the only real full-graph exceptions (unchanged);
   `hitl`/`requiresHumanApproval` keep their existing documented ready-specific semantics
   (unchanged).
4. **Test decision:** add unit tests in `task-service.unit.test.ts` for `listReady()`
   covering each new filter alone and combined with `agentId`/`repos` scoping; add an
   integration test in `tasks.integration.test.ts` proving filtering happens *post*-
   dependency-resolution (a task excluded by a filter must still correctly satisfy a
   dependency edge for an in-scope task — the regression case for this bug's actual root
   cause); extend `state-filter.smoke.test.ts`/`api.smoke.test.ts` asserting the route
   forwards each new param to `listReady()` (mirrors the existing `agentId`-forwarding case
   at `api.smoke.test.ts:623`). No existing tests are retired — purely additive.

**Dependencies:** none
**Branch:** `feat/trf-1-1-ready-filter-passthrough`
**Layer:** API
**Hours:** 4
**HITL:** none
**Complexity:** 3 (`sonnet`) — pure modification of existing code, reuses established
patterns (no new abstraction)
**Safe to deploy standalone:** yes — purely additive optional filters, no behavior change
when omitted
