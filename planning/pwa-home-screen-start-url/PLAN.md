# Plan: pwa-home-screen-start-url

## Background

The admin console's installable PWA shell (`admin/src/pwa.ts`, added in PR #2935,
`feat: installable PWA shell — manifest, icons, offline service worker`, merged
2026-08-31) serves one `manifest.webmanifest` for the entire `/admin/` scope, with
`start_url` hardcoded to `/admin/chat`. Every `/admin/*` page links this same manifest
via `injectPwaHeadTags` in `admin/src/admin-ui.ts`.

Before PR #2935, "Add to Home Screen" in Chrome/Safari on iOS just created a plain
bookmark of whatever page was open. Since #2935, WebKit (the engine behind both iOS
Safari and iOS Chrome) detects the manifest and installs a proper PWA shortcut instead —
which always launches into `/admin/chat`, regardless of which page (e.g. `/admin/tasks`)
the user tapped "Add to Home Screen" from. Reported internally: a user added a shortcut
from the tasks board and it opened chat instead.

## Design

WebKit reads whatever the manifest `<link>` element's `href` currently is at the moment
"Add to Home Screen" is invoked, and fetches that URL fresh — `shouldCachePwaRequest`
already excludes `/admin/manifest.webmanifest` from the service worker's precache/cache
predicate, so this fetch is never stale. That means a page can hand back a manifest whose
`start_url` matches itself, without needing per-route wiring through the ~24
`render*Page` functions in `admin-ui-pages.ts`.

**`admin/src/pwa.ts`:**
- `buildManifest()` takes an optional `startUrl?: string` param. Omitted/undefined keeps
  today's default, `/admin/chat` — no behavior change for existing callers or the
  existing unit tests that call `buildManifest()` with no args.
- New pure `sanitizeStartUrl(raw: string | undefined | null): string` helper: returns
  `raw` unchanged only if it's a same-origin path starting with `/admin/`, contains no
  `..` traversal, and isn't one of the PWA shell's own non-navigable asset/auth routes
  (`/admin/manifest.webmanifest`, `/admin/sw.js`, `/admin/icons/*`, `/admin/offline.html`,
  `/admin/login`, `/admin/logout`, OAuth callback paths). Anything else — an external URL,
  a bare path with no leading `/admin/`, a malformed value — falls back to `/admin/chat`.
  The manifest's own `scope: "/admin/"` is a second, browser-enforced backstop against
  anything outside `/admin/` regardless of this helper.
- `renderPwaHeadTags()`: gives the `<link rel="manifest">` tag an `id`, and appends a
  small inline script that rewrites its `href` to
  `/admin/manifest.webmanifest?start=<encodeURIComponent(location.pathname)>` — this runs
  synchronously during initial page load, before a user could possibly trigger "Add to
  Home Screen".

**`admin/src/admin-ui.ts`:**
- `GET /admin/manifest.webmanifest` reads `c.req.query("start")`, passes it through
  `sanitizeStartUrl`, and forwards the result into `buildManifest(startUrl)`.

No schema, API-shape, or removal changes — this is additive: the route's existing
behavior when no `?start=` param is present (used by the smoke test's direct
`app.request("/admin/manifest.webmanifest")` call and the SW's own — unqueried — link
tag fallback before the head-tags script runs) is unchanged.

Test change: extend `pwa.unit.test.ts` with a `sanitizeStartUrl` describe block (allow:
`/admin/tasks`, `/admin/agents/abc123`; reject-and-fallback: external URL, `//evil.com`,
protocol-relative, `javascript:`, path traversal, the PWA shell's own asset/auth routes,
missing/undefined) and extend `buildManifest`'s existing describe block with a case
passing a `startUrl` through. Extend `pwa-routes.smoke.test.ts` with cases for
`GET /admin/manifest.webmanifest?start=/admin/tasks` (returns that as `start_url`) and
`?start=https://evil.com` (falls back to `/admin/chat`) — the existing no-query-param
case stays as documentation of the default. No existing tests are retired; the new cases
are additive to established describe blocks.

Safe to deploy standalone: yes — additive only, no renames/removals, no consumers of the
manifest route depend on the absence of a `start` query param.

## Tasks

| ID | Title | Depends on | Branch | Layer | Hours | Complexity | Model | HITL |
|----|-------|-----------|--------|-------|-------|------------|-------|------|
| PWA-1.1 | Make PWA install start_url reflect the current page | — | `feat/pwa-1-1-manifest-start-url` | Frontend | 3 | 3 | sonnet | |

### PWA-1.1

Make the installed home-screen shortcut launch into whatever admin page the user was on
when they tapped "Add to Home Screen", instead of always launching into `/admin/chat`.

**Acceptance criteria:**
- `buildManifest(startUrl?)` accepts an optional `startUrl`; omitted still defaults to
  `/admin/chat` (existing `buildManifest()`-with-no-args unit tests keep passing
  unchanged)
- A new pure `sanitizeStartUrl` helper in `admin/src/pwa.ts` only passes through
  same-origin `/admin/...` paths, rejecting external URLs, protocol-relative/`javascript:`
  values, path traversal, and the PWA shell's own asset/auth routes — falling back to
  `/admin/chat` for anything it rejects
- `renderPwaHeadTags()` emits a manifest `<link>` with a stable `id` plus an inline script
  that rewrites its `href` to include `?start=<current pathname>` at page load
- `GET /admin/manifest.webmanifest` in `admin/src/admin-ui.ts` honors a `start` query
  param (sanitized) and falls back to `/admin/chat` when absent or invalid
- Test change: add unit test coverage in `pwa.unit.test.ts` for `sanitizeStartUrl`'s
  allow/reject cases and `buildManifest(startUrl)`; add smoke test coverage in
  `pwa-routes.smoke.test.ts` for the manifest route with a valid `?start=` value and with
  a malicious/invalid one. No existing tests are removed.
- `task ci` passes (lint, typecheck, test:coverage) with the aggregate coverage gate met

Safe to deploy standalone: yes.

### Dependency Map

```
[START]
  └─ PWA-1.1: Make PWA install start_url reflect the current page (no deps)
```

```
Task     | Depends on | Blocks | HITL
PWA-1.1  | —          | —      |
```

## HITL scan

HITL scan: no tasks require human steps
