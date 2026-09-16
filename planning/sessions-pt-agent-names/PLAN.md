# Plan Session: sessions-pt-agent-names

Repo: app-vitals/shipwright

## Input

Verbal report (Dan, Slack): on the Sessions list page (`/admin/sessions`), timestamps
aren't shown in Pacific time like the rest of the admin UI, and the Agents column shows
raw agent ids instead of agent names. Follow-up asks folded in during planning: the
Session and Slug columns are redundant, filtering would be easier with the same
autocomplete/distinct-values pattern the Tasks page uses, and an Org filter should be
added alongside Repo.

## Root cause

- `formatTimestamp()` in `admin/src/admin-ui-sessions-list.ts` calls `d.toLocaleString()`
  with no `timeZone` — falls back to server-local time. Every other admin page threads a
  `timezone` param (default `"America/Los_Angeles"`) from `admin-ui.ts`'s
  `createAdminUIApp` deps down into `toLocaleDateString/toLocaleString(..., { timeZone })`.
  The sessions-list module never received that param — missing from `SessionsListDeps`
  and from the `registerSessionsListRoutes(app, {...})` call site.
- `sessionRow()` renders `badgeList(session.agentIds, "badge-gray")` — raw ids, no
  lookup. Every other page builds an `agentNames: Record<string, string>` map via
  `agentService.listByIds(agentIds)` and resolves through it with an `id` fallback.
  `agentService` is already available to this module (used today only for visibility
  scoping) but `listByIds` is never called for display purposes.
- The Session column already falls back to the slug when no title is set
  (`session.title?.trim() || session.slug`), so the separate Slug column is a literal
  duplicate in the common no-title case.
- The Tasks page filter form gets datalist/multiselect autocomplete from
  `GET /tasks/distinct` (`{sessions, repos, orgs}`) + `agentService.listOptions()`, via
  the exported `renderRepoOrgFilterFields()` helper. The Sessions list filter form never
  received any of this — plain text inputs, no suggestions.
- `GET /sessions` (`task-store/src/routes/sessions.ts` → `SessionService.list()`) has no
  `org` filter at all today (unlike `GET /tasks`, which already supports it). `list()`
  filters entirely in-memory after rollup computation — `filters.repo` is applied as
  `items.filter(item => item.repos.some(repo => repoList.includes(repo)))`. An `org`
  filter is the same shape, matching on the `org/repo` prefix.

## Design

**SPT-1.1 (task-store, API layer)** — add `org` filtering to `GET /sessions`:
- `SessionListFilters.org?: string | string[]` in `session-service.ts`.
- `list()` gains an `org` filter block mirroring the existing `repo` block:
  `items.filter(item => item.repos.some(repo => orgList.includes(repo.split("/")[0])))`.
- `routes/sessions.ts` parses `c.req.queries("org")` into the filters object, same as
  `repo`.
- `SessionListQuerySchema` (openapi-schemas.ts) gains `org`.
- Purely additive, in-memory filter — no schema/migration change.

**SPT-1.2 (admin, Frontend layer)** — depends on SPT-1.1:
- `formatTimestamp(value, timezone)` gains a `timeZone` option; `SessionsListDeps` gains
  `timezone?: string`; `registerSessionsListRoutes(app, {...})` call site in
  `admin-ui.ts` passes the existing `timezone` var (already in scope, already passed to
  the sibling `registerSessionSettingsRoutes` call three lines below).
- Route handler collects distinct `agentIds` across the fetched page and calls
  `agentService.listByIds(...)` to build `agentNames`, threaded into `sessionRow` and
  used in place of raw ids in the Agents badge column (`agentNames[id] ?? id`
  fallback, matching every other page). `SessionsListAgentService` widens from
  `Pick<AgentService, "listByIds">` to also pick `"listOptions"`.
- `sessionRow`/`renderSection`: drop the separate Slug column/header. The Session cell
  is the title link, with the slug shown underneath in small muted mono text only when
  it differs from the title. Column count 8 → 7 (colspan updates on the empty-state row).
- Filter form: reuse the exported `renderRepoOrgFilterFields()` from
  `admin-ui-pages.ts` wholesale (Org + Repo native multiselects), replacing the current
  plain-text Repo input. Agent gains a `list="agents-list"` datalist, same markup as the
  Tasks page. Suggestions built the same way as the Tasks page: `Promise.all([
  fetchDistinctTaskValues(), agentService.listOptions()])`, threaded into
  `SessionsListDeps` (new `fetchDistinctTaskValues?` dep) and passed down to
  `renderSessionsListPage`.
- Route handler forwards `org` query values to the task-store `/sessions` fetch,
  alongside the existing `repo`/`agent`/`q` forwarding.

Safe to deploy standalone: both tasks — additive fields/params/UI only, no
renames/removals.

## Decision Log

- Bundling: SPT-1.1 and SPT-1.2 are NOT bundled onto a shared branch — different
  packages/layers (task-store API vs. admin UI), each independently reviewable, and
  SPT-1.1 is inert-but-harmless once merged even before SPT-1.2 consumes it. Sequenced
  via a dependency edge instead.
- Session/Slug column merge: slug is shown as a muted subtitle under the title only when
  it differs from the title, rather than dropped entirely — keeps the slug
  discoverable (copy/paste, debugging) without the literal duplicate text.

## Task Breakdown

| Task | Title | Layer | Complexity | Model | Hours | Depends on | HITL |
|---|---|---|---|---|---|---|---|
| SPT-1.1 | Add `org` filter to `GET /sessions` | API | 3 | sonnet | 2 | — | |
| SPT-1.2 | Sessions list UI: Pacific time, agent names, merged Session/Slug column, Org+Repo+Agent filter autocomplete | Frontend | 4 | sonnet | 3.5 | SPT-1.1 | |

### Dependency graph

```
[START]
  └─ SPT-1.1: org filter on GET /sessions (no deps)
        └─ SPT-1.2: sessions list UI overhaul (needs 1.1)
```

HITL scan: no tasks require human steps.
