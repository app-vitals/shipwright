# Plan: chat-scroll-reset

Repo: app-vitals/shipwright

## Problem
In the admin chat UI, `poll()` in `admin/src/admin-ui-pages.ts` sets
`container.scrollTop = container.scrollHeight` unconditionally at the end of
every poll (pending branch and idle branch). A user who scrolls up in a thread
is snapped back to the latest message every 2s (pending) / 10s (idle).

## Design
Client-side only (inline script emitted by admin-ui-pages.ts). No API/DB changes.

1. Add `isNearBottom()`: `scrollHeight - scrollTop - clientHeight < 80`.
2. In `poll()`'s success handler, record `stick = isNearBottom()` before any
   DOM insertion (inserting bubbles grows scrollHeight).
3. Replace the two unconditional scrolls with `if (stick) scroll to bottom`.
4. Keep unconditional scroll on user send and initial load. Gate
   `ensureLiveStatusBubble`'s scroll on the same flag when called from poll.

Assumption: when scrolled up and a new message arrives, the view stays put;
no "jump to latest" pill (possible follow-up).

## Tests
Unit test in `admin-ui-pages.unit.test.ts`: extract the emitted script and run
it with an injected stub DOM/fetch (no global overrides). Cases: scrolled up ->
scrollTop unchanged after poll; near bottom -> scrolls to bottom. No tests retired.

## Tasks
| ID | Title | Layer | Hours | Complexity | Model | Deps | HITL |
|---|---|---|---|---|---|---|---|
| CSR-1.1 | Stop chat poll from resetting scroll when user scrolled up | Frontend | 2 | 2 | haiku | — | no |

Safe to deploy standalone: yes (additive guard, no renames/removals).
