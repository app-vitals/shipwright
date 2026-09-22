# Plan: hitl-notification-deeplink

## Problem

Mobile push notifications for a session going HITL (human-in-the-loop) deep-link to
the generic `/admin/chat` agent-picker instead of the specific session. The working
"agent replied" chat notification correctly deep-links to `/admin/chat/{agentId}/threads/{threadId}`
because it goes through `buildNotificationPayload()`; the session-follow notification
does not have an equivalent wired up.

## Root cause

`admin/src/push-service.ts`'s `PushService.notifySession()` builds an ad-hoc
`{kind, slug, level}` JSON payload with no `title`/`body`/`url`/`tag`. The service
worker (`admin/src/pwa.ts`) merges the incoming push payload over a hardcoded default
(`url: "/admin/chat"`); since the session payload never sets `url`, the default
survives and every HITL/session push lands on the generic chat page.

`admin/src/push-content.ts` already has `buildSessionNotificationPayload()`
(correctly building `{title, body, url: /admin/sessions/:slug, tag, kind}`), but
`notifySession()` never calls it — a stale code comment on `notifySession()` cites a
"future task (SESH-7.2)" that in fact already shipped the content builder; nobody
wired the two together.

## Design

**Business logic** — `PushService.notifySession()` (`admin/src/push-service.ts`)
switches from building its own placeholder JSON to calling
`buildSessionNotificationPayload()` from `push-content.ts`, mirroring the pattern
`notifyThreadReply()` already uses with `buildNotificationPayload()`.

**Views/UX** — none. `admin/src/pwa.ts`'s service worker already reads `url` off the
payload correctly; it has just never received one from the session path.

**API / DB** — none.

**Files:**
- `admin/src/push-service.ts` — extend the local `NotificationSession` interface
  (currently `{slug, emails}`) with `title?: string | null`; rewrite `notifySession()`
  to call `buildSessionNotificationPayload()`.
- `admin/src/session-alert-sweeper.ts` — thread `title: session.title` into the two
  `notifySession()` call sites (the `sweepWaitingSession` and `sweepClosedSession`
  paths). `SessionForAlert` already carries `title`; it's just not passed through today.

**Assumption (soft ambiguity, defaulted):** `SessionForAlert` has no `reason` field, so
`buildSessionNotificationPayload()`'s `reason` param stays `undefined` on every call —
the "preview" detail level falls back to `title`, matching current behavior. No schema
change needed to close this bug.

## Decision Log

- Whether to add a `reason` field to `SessionForAlert`/task-store sessions: defaulted to
  no — out of scope for a deep-link fix; `title` fallback already produces a sane preview.

## Testing Strategy

- `push-service.unit.test.ts`'s `PushService.notifySession` suite currently only
  asserts delivery counts (`{delivered, pruned}`), never inspects the payload JSON sent
  to `fetchImpl` — that's why the missing `url` shipped unnoticed. Add a unit assertion
  on the actual payload body (specifically that `url` is `/admin/sessions/{slug}`).
- `session-alert-sweeper.unit.test.ts` — extend an existing case (or add one) asserting
  the session's `title` is passed through to the `pushService.notifySession()` call.
- No integration/smoke/e2e changes — this is pure payload-shape logic with existing
  injected-double coverage.

## Tasks

| Task | Depends on | Blocks | HITL |
|------|-----------|--------|------|
| HND-1.1 | — | — | |

**HND-1.1 — Wire notifySession() to buildSessionNotificationPayload()**

- **Description**: Fix `PushService.notifySession()` so HITL/session push notifications
  carry a real deep-link `url` (to `/admin/sessions/{slug}`) instead of falling back to
  the service worker's generic `/admin/chat` default.
- **Acceptance Criteria**:
  - `notifySession()` in `admin/src/push-service.ts` calls
    `buildSessionNotificationPayload(level, kind, session)` instead of hand-building
    `{kind, slug, level}`.
  - `NotificationSession` in `push-service.ts` gains `title?: string | null`;
    `session-alert-sweeper.ts` passes `title: session.title` at both call sites.
  - Unit test: extend `push-service.unit.test.ts`'s `notifySession` describe block to
    assert the sent payload includes `url: "/admin/sessions/{slug}"` (not just delivery
    counts). Extend `session-alert-sweeper.unit.test.ts` to assert `title` is forwarded.
  - No existing test is retired — the delivery-count assertions stay; payload-shape
    assertions are additive.
- **Dependencies**: none
- **Branch**: `feat/hnd-1-1-wire-notifysession`
- **Layer**: Background
- **Hours**: 2
- **HITL**: no
- **Complexity**: 2
- **Model**: sonnet
- **Safe to deploy standalone**: yes (pure additive fix, no renames/removals/constraints)

## Dependency Map

```
[START]
  └─ HND-1.1: Wire notifySession() to buildSessionNotificationPayload() (no deps)
```
