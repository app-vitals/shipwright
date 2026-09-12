# Session Notifications

Session-follow lets a user follow a task-store [Session](./task-store.md) and receive a Web Push notification about it — the session-lifecycle sibling of the chat "your agent replied" push flow documented in [`docs/agent.md`](./agent.md)'s "PWA shell" section (service worker, VAPID env vars, and the `PushSubscription` model). It reuses that same `PushSubscription`/VAPID infrastructure, but adds its own business-domain state: follow/mute per user per session, per-user notification prefs, and a per-user/per-session alert cooldown.

Implemented across `admin/src/session-follow-service.ts` (CRUD), `admin/src/push-content.ts` (session notification content policy), `admin/src/push-service.ts`'s `notifySession()` (delivery), `admin/src/session-alert-sweeper.ts` (the background job that calls `notifySession()`, stamps `SessionAlertState.lastAlertedAt`, and prunes followers who lose visibility), `admin/src/admin-ui-sessions.ts` (the settings page), `admin/src/admin-ui-session-follow.ts` (follow/unfollow routes), and `admin/src/session-scope.ts` (the visibility model). Per-file detail: [agent-key-files.md](./agent-key-files.md). Prisma models: [agent.md's Data model table](./agent.md#data-model).

---

## Data model

Three models, all in `admin/prisma/schema.prisma`, none tied to an `Agent` (no cascade on agent deletion):

| Model | Purpose | Key fields |
|---|---|---|
| `SessionFollow` | A user following a session | `userEmail`, `sessionSlug`, `muted` (boolean). Unique on `[userEmail, sessionSlug]`. |
| `UserNotificationPrefs` | Per-user notification settings | `userEmail` (primary key — one row per user, not per session), `autoFollowSessions` (default `true`), `reminderHourLocal` (default `9`, validated to an integer in `[0, 23]`), `autoFollowSince`. |
| `SessionAlertState` | Per-user/per-session alert cooldown | `userEmail`, `sessionSlug`, `lastAlertedAt`. Unique on `[userEmail, sessionSlug]`. |

`SessionAlertState.lastAlertedAt` is written by `session-alert-sweeper.ts`'s `stampAlertState()` (an upsert, keyed per user/session) after every immediate/reminder/completed push it sends — the cooldown state the model was built to hold. `SessionFollowService.unfollow()` additionally deletes the caller's `SessionAlertState` row for the slug as cleanup, so a stale cooldown timestamp doesn't linger past unfollowing.

`SessionFollowService` (`admin/src/session-follow-service.ts`) is the sole entry point — routes never touch these three Prisma models directly:

- `follow(userEmail, sessionSlug)` — idempotent upsert. Re-following an already-followed (possibly muted) session un-mutes it rather than erroring.
- `unfollow(userEmail, sessionSlug)` — idempotent delete of both the `SessionFollow` row and the matching `SessionAlertState` row.
- `listByUser(userEmail)` — all sessions a user follows, muted or not.
- `getOrCreatePrefs(userEmail)` / `updatePrefs(userEmail, input)` — read/write `UserNotificationPrefs`, upserting a default row on first access. `updatePrefs` throws `BadRequestError` (mapped to HTTP 400 by callers) if `reminderHourLocal` is outside `[0, 23]`.

## Notification detail-level policy

Session notifications reuse the same three-tier detail levels as the chat-reply push flow (`PushDetailLevel`: `"generic" | "title" | "preview"`), and the same effective-level formula, in `admin/src/push-content.ts`:

```
effective level = min(operator ceiling, per-subscription opt-in, per-call ceiling)
```

- **Operator ceiling** — `SHIPWRIGHT_ADMIN_PUSH_MAX_DETAIL` (defaults to `"title"`), a server-wide hard cap.
- **Per-subscription opt-in** — `PushSubscription.detailOptIn` (defaults to `"generic"`, the safest level), set per browser/device.
- **Per-call ceiling** — the `level` argument `PushService.notifySession(session, level, kind)` is called with. A caller can ask for less detail than the subscription allows, never more; `resolveDetailLevel` is applied twice (once against the operator ceiling inside `sendToUsers`, once against the caller's `level`) so the invariant holds regardless of call site.

`buildSessionNotificationPayload(level, kind, session)` renders the payload for one of three lifecycle kinds — `"immediate"` ("A session needs you"), `"reminder"` ("Still waiting on you"), `"completed"` ("Session completed") — with the same austerity rule as chat replies:

| Level | Body content |
|---|---|
| `generic` | Empty body — title only. |
| `title` | The session's title, sanitized. |
| `preview` | The `reason` field (why the session needs attention) if present, else the title — sanitized, truncated to 120 chars. |

`sanitizePublic()` scrubs id/repo/path/cost-shaped substrings (Prisma cuids, `owner/repo`-style slugs, `agt_...`-style ids, `$1,234.56`-style costs) out of the user-authored title/reason before either can reach a locked screen — conservative by design, so an innocuous slash-word being redacted is preferred over a real leak. The deep link (`url: /admin/sessions/:slug`) and the coalescing `tag` (`shipwright-session-:slug`) are the only fields allowed to carry the session slug; neither is rendered on the lock screen.

`PushService.notifySession()` (`admin/src/push-service.ts`) is called by `session-alert-sweeper.ts` — the session-lifecycle event source this payload logic was built for — once per non-muted, still-visible follower: with kind `"immediate"`/`"reminder"` for a session still waiting on them, and `"completed"` when the session closes.

## `/admin/settings/notifications` page

`admin/src/admin-ui-sessions.ts` registers three routes, mounted by `admin-ui.ts`. All three are **admin-only** — a non-admin caller gets `403 Forbidden` (unlike the follow/unfollow routes below, which apply the session-visibility check instead of an admin gate):

| Method | Path | Description |
|---|---|---|
| GET | `/admin/settings/notifications` | Renders the page: the shared Web Push subscribe/unsubscribe toggle (reused verbatim from the chat push flow, with placeholder `agentId`/`threadId` values since the page isn't scoped to one thread), the `autoFollowSessions` checkbox and `reminderHourLocal` number input (rendered in `SHIPWRIGHT_ADMIN_TZ`), and a table of the caller's non-muted followed sessions with per-row Unfollow buttons. |
| POST | `/admin/settings/notifications` | Saves prefs from a form body (`autoFollowSessions`, `reminderHourLocal`). Calls `updatePrefs()`; a `BadRequestError` (bad `reminderHourLocal`) re-renders the page with a `400` and an inline error instead of throwing. |
| POST | `/admin/settings/notifications/unfollow` | Form POST with `sessionSlug`; calls `unfollow()` and redirects back to the settings page (`302`). Missing `sessionSlug` is a silent no-op redirect. |

The followed-sessions list filters out muted rows (`follows.filter(f => !f.muted)`) — a muted-but-still-followed session (not currently reachable from any UI, since nothing sets `muted` outside `follow()`'s un-mute-on-refollow path) would not appear here.

## Follow / unfollow a session

`admin/src/admin-ui-session-follow.ts` registers two routes, mounted next to the settings routes:

| Method | Path | Description |
|---|---|---|
| POST | `/admin/sessions/:slug/follow` | Admins may follow any session. Non-admins must pass the [visibility check](#session-visibility-model-session-scopets) — a session the caller can't see returns `404` (not `403`, to avoid confirming the session's existence). Returns `{ sessionSlug, following: true }` (`200`). |
| POST | `/admin/sessions/:slug/unfollow` | No visibility check — removing your own follow state doesn't require re-proving visibility, mirroring the settings page's unfollow route. Returns `{ sessionSlug, following: false }` (`200`). |

## Session visibility model (`session-scope.ts`)

`admin/src/session-scope.ts` is a pure, no-I/O module deciding which sessions a caller may see:

```ts
visibleAgentIdsFor(isAdmin, memberships): "all" | string[]
isSessionVisible(session, scope): boolean
```

- **Admin** (`isAdmin = true`) → `visibleAgentIdsFor` resolves to `"all"`, and `isSessionVisible` always returns `true` regardless of the session's `agentIds`/`repos`.
- **Member** (non-admin) → resolves to the list of `agentId`s the caller has an `AgentMember` row for (empty list for a member with zero memberships — not an error). `isSessionVisible` then returns `true` iff the session's `agentIds` intersects the scope's `agentIds`, **or** the session's `repos` intersects the scope's `repos` (repos are resolved by the caller from the accessible agents' own `repos[]` field, not by this module).

The module deliberately takes already-resolved `isAdmin`/`memberships`/session data as plain arguments rather than performing its own email lookup or task-store fetch — every real caller already has `isAdmin` from its own auth context and can resolve the rest itself, which keeps this module trivially unit-testable against plain fixtures.

**As of 2026-09-12, this visibility model is wired into `POST /admin/sessions/:slug/follow`** (via `memberCanSeeSession()` in `admin-ui-session-follow.ts`, which fails closed — returns not-visible — whenever `fetchTaskStoreSession` is unconfigured, the session lookup fails, or the session doesn't exist) **and into the session-alert-sweeper background job** (`session-alert-sweeper.ts` imports `isSessionVisible`/`visibleAgentIdsFor` directly to prune any follower who has lost visibility of a session before sending it a push). It is **not yet wired into**:

- The session detail page (`GET /admin/sessions/:id`) — currently gated admin-only (`requireAuth` plus an `isAdmin` check returning `403 Forbidden`), so it is *more* restrictive than this model rather than more permissive: a non-admin member can't reach their own visible sessions here at all
- `/admin/sessions/:slug/unfollow` (skips the check by design — see above)
- `/admin/settings/notifications` (admin-only gate instead; a non-admin member never reaches a place that would need this check)

Wiring the remaining routes to this same visibility model is tracked as follow-up work, not part of this doc's scope.
