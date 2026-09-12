/**
 * admin/src/admin-ui-push-test.ts
 * POST /admin/push/test — send a test Web Push to the caller's own devices.
 *
 * The only way to answer "is push actually reaching my phone?" without waiting
 * for a real event (an agent reply, a session entering `waiting`). Sends the
 * same way every real notification does — `PushService.sendToUsers()`, so the
 * VAPID config, the stored subscription, and the service worker's `push`
 * handler are all exercised — and reports how many subscriptions it reached.
 * `delivered: 0` with a 200 means the account has no live subscription: the
 * caller followed a session but never tapped "Enable notifications" on a
 * device (or that device's subscription was pruned as gone).
 *
 * Scoped to `c.var.userEmail` only — a user can test their own devices, never
 * page someone else's. The payload is fixed text and carries no session, agent,
 * or task detail, so it is safe at every detail level.
 */

import type { Hono, MiddlewareHandler } from "hono";
import type { AdminUIEnv } from "./admin-ui.ts";
import type { PushService } from "./push-service.ts";

export const PUSH_TEST_PATH = "/admin/push/test";

/** Fixed payload — shape matches what the service worker's `push` handler reads. */
export const PUSH_TEST_PAYLOAD = {
  title: "Shipwright test notification",
  body: "Push notifications are working on this device.",
  url: "/admin/settings/notifications",
  tag: "shipwright-push-test",
} as const;

export interface PushTestRouteDeps {
  requireAuth: MiddlewareHandler<AdminUIEnv>;
  /** Same derived flag admin-ui.ts uses for the subscribe routes. */
  pushEnabled: boolean;
  pushService?: Pick<PushService, "sendToUsers">;
}

export interface PushTestResponse {
  ok: true;
  delivered: number;
  pruned: number;
}

/** Registers POST /admin/push/test onto `app`. */
export function registerPushTestRoute(
  app: Hono<AdminUIEnv>,
  deps: PushTestRouteDeps,
): void {
  app.post(PUSH_TEST_PATH, deps.requireAuth, async (c) => {
    if (!deps.pushEnabled || !deps.pushService) {
      return c.json({ error: "push_disabled" }, 503);
    }
    const result = await deps.pushService.sendToUsers(
      [c.var.userEmail],
      () => JSON.stringify(PUSH_TEST_PAYLOAD),
    );
    const body: PushTestResponse = { ok: true, ...result };
    return c.json(body, 200);
  });
}

/**
 * The "Send test notification" control for the notification settings page:
 * a button plus the minimal script that POSTs to the route and prints the
 * outcome in plain words. Rendered only when push is enabled (the caller
 * gates on the same flag as the toggle it sits under).
 */
export function renderPushTestControl(): string {
  return `
  <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e5e7eb">
    <button type="button" id="push-test-btn" class="btn btn-secondary">Send test notification</button>
    <span id="push-test-status" style="font-size:12px;color:#6b7280;margin-left:8px"></span>
    <p style="font-size:12px;color:#6b7280;margin:8px 0 0">Following a session does not subscribe this device. Enable notifications above first, then send a test to confirm it reaches this phone.</p>
  </div>
  <script>
  (function() {
    var btn = document.getElementById('push-test-btn');
    var status = document.getElementById('push-test-status');
    if (!btn || !status) return;
    btn.addEventListener('click', function() {
      btn.disabled = true;
      status.textContent = 'Sending…';
      fetch(${JSON.stringify(PUSH_TEST_PATH)}, { method: 'POST', credentials: 'same-origin' })
        .then(function(res) { return res.json().then(function(body) { return { status: res.status, body: body }; }); })
        .then(function(r) {
          if (r.status !== 200 || !r.body || !r.body.ok) {
            status.textContent = 'Push is not enabled on this server.';
          } else if (r.body.delivered === 0) {
            status.textContent = 'No subscribed device on this account — tap Enable notifications first.';
          } else {
            status.textContent = 'Sent to ' + r.body.delivered + ' device' + (r.body.delivered === 1 ? '' : 's') + '.';
          }
        })
        .catch(function() { status.textContent = 'Request failed.'; })
        .then(function() { btn.disabled = false; });
    });
  })();
  </script>`;
}
