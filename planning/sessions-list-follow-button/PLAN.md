# Plan: sessions-list-follow-button

Dave reported that the Follow button on the Sessions list page
(`/admin/sessions`) does nothing, while the same button on a session's detail
page (`/admin/sessions/:slug`) works. Root cause confirmed by reading the
code, no live repro needed: the list page's button is a known, intentional
stub from SESH-4.2 that was never followed up.

## Root cause

`admin/src/admin-ui-sessions-list.ts`'s `sessionRow()` renders:

```html
<button type="button" class="btn btn-secondary follow-toggle-stub" disabled
        title="Follow is not wired up yet">Follow</button>
```

with a comment saying a future task would wire it to
`SessionFollowService`. That follow-up task was never queued. Meanwhile the
detail page (SESH-5.3) and the backend routes (SESH-6.2,
`admin-ui-session-follow.ts`'s `POST /admin/sessions/:slug/{follow,unfollow}`)
are fully built and working — the list page just never got connected to them.

## Design

No new backend work — reuse what SESH-5.3/6.2 already shipped.

**Views/UX** (`admin/src/admin-ui-sessions-list.ts`):
- Replace the disabled stub `<button>` in `sessionRow()` with a live button
  matching the detail page's markup/attribute convention
  (`data-slug`, `data-following`), but class-based (`session-follow-btn`)
  instead of a single `id`, since the list page renders one per row.
- `registerSessionsListRoutes()` needs each rendered session's current
  follow state. Add `sessionFollowService: Pick<SessionFollowService,
  "listByUser">` to `SessionsListDeps`, call `listByUser(userEmail)` once per
  request (after `sessions` is resolved), and build a `Set<string>` of
  followed slugs. Thread it through `renderSessionsListPage` → `renderSection`
  → `sessionRow` alongside the existing `agentNames` map — one query for the
  whole page, not one per row.
- Add a single inline `<script>` to `renderSessionsListPage()`'s returned
  HTML (once, not per-row) that event-delegates a `click` listener checking
  `event.target.classList.contains('session-follow-btn')`, then POSTs to
  `/admin/sessions/{slug}/{follow|unfollow}` and toggles that button's own
  label/`data-following` in place on success — same request/response shape
  the detail page's existing script already uses, just delegated instead of
  bound to one fixed `id`.
- `admin-ui.ts` passes its already-constructed `sessionFollowService` into
  `registerSessionsListRoutes()`, mirroring how it's already passed into
  `registerSessionFollowRoutes()`.

**APIs / DB:** none — `POST /admin/sessions/:slug/follow` and `/unfollow`
already exist, already enforce member visibility (fail-closed), and already
work from the detail page.

**Test decision:** extend the existing smoke suite
(`admin-ui-sessions-list.smoke.test.ts`), which already has a
`describe("GET /admin/sessions — row actions")` block. Its one existing test
(`"renders a Follow toggle stub per row"`, asserting only that the string
"Follow" appears) is retired and replaced with cases asserting: the button
renders enabled (not `disabled`) with the correct `data-slug`; a session the
user already follows renders `data-following="true"` / label "Following"; a
session they don't follow renders `data-following="false"` / label "Follow".
No unit test needed — this is pure HTTP-render + injected-service behavior,
same layer as SESH-5.3's original detail-page button test.

**Breaking change scan:** none — pure addition/enablement, no renames or
removals, no schema change. Safe to deploy standalone: yes.

**HITL scan:** no tasks require human steps.

## Task

| Task | Depends on | Blocks | HITL |
|---|---|---|---|
| FLW-1.1 | — | — | |

### FLW-1.1 — Wire the Sessions list page Follow button to SessionFollowService

- **Description:** Replace the disabled `follow-toggle-stub` button in
  `admin-ui-sessions-list.ts`'s `sessionRow()` with a live follow/unfollow
  toggle, reusing the existing `POST /admin/sessions/:slug/{follow,unfollow}`
  routes and `SessionFollowService` that already power the session detail
  page (SESH-5.3/SESH-6.2). Batch-resolve per-row follow state via one
  `listByUser()` call per page render; wire click handling via one delegated
  inline `<script>` for the whole page instead of a single fixed-id listener.
- **Acceptance Criteria:**
  - Sessions list page renders each row's Follow button enabled, with
    `data-slug` set to that row's session slug and `data-following`
    reflecting whether the current user already follows it (label "Follow" /
    "Following" to match).
  - Clicking a row's button POSTs to `/admin/sessions/{slug}/follow` or
    `/unfollow` (based on current state) and updates that row's button label
    and `data-following` in place on success, without a full page reload —
    same behavior as the detail page's existing button.
  - `admin-ui-sessions-list.smoke.test.ts`: replace the existing
    `"renders a Follow toggle stub per row"` test (asserted only stub text) with
    cases covering enabled rendering, `data-following="true"` for an
    already-followed session, and `data-following="false"` for one that
    isn't — all via injected `SessionsListDeps.sessionFollowService` doubles,
    no real DB. No unit or integration test needed — this is pure
    HTTP-render + injected-service behavior, already covered at the smoke
    layer.
- **Dependencies:** none
- **Branch:** `feat/flw-1-1-wire-sessions-list-follow`
- **Layer:** Frontend
- **Hours:** 3
- **HITL:** —
- **Complexity:** 3
- **Model:** sonnet

Safe to deploy standalone: yes.
