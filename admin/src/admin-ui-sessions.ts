/**
 * admin/src/admin-ui-sessions.ts
 * GET/POST /admin/settings/notifications — per-user session-notification
 * preferences: the Web Push enable toggle (reuses push-toggle.ts), the
 * autoFollowSessions toggle, the reminderHourLocal input (rendered in
 * SHIPWRIGHT_ADMIN_TZ), and the caller's followed-sessions list with
 * unfollow buttons.
 *
 * Registered into admin-ui.ts's app via registerSessionSettingsRoutes() —
 * kept in its own file rather than growing the already-large admin-ui.ts
 * further, following the same "extracted route module" shape as
 * push-toggle.ts (a self-contained render fragment) but for a full page.
 *
 * SessionFollowService itself (SES-6.1) is out of scope here — this module
 * only renders around it and translates its BadRequestError into a 400.
 */

import type { Hono, MiddlewareHandler } from "hono";
import { renderAdminPage } from "./admin-ui-layout.ts";
import { escapeHtml, renderAdminToolbar } from "./admin-ui-styles.ts";
import type { AdminUIEnv } from "./admin-ui.ts";
import { BadRequestError } from "./errors.ts";
import { renderPushToggle } from "./push-toggle.ts";
import type {
  SessionFollowRow,
  SessionFollowService,
  UserNotificationPrefsRow,
} from "./session-follow-service.ts";

export const NOTIFICATION_SETTINGS_PATH = "/admin/settings/notifications";

/** The narrow slice of SessionFollowService this module calls. */
export type SessionSettingsFollowService = Pick<
  SessionFollowService,
  "listByUser" | "getOrCreatePrefs" | "updatePrefs" | "unfollow"
>;

export interface SessionSettingsDeps {
  requireAuth: MiddlewareHandler<AdminUIEnv>;
  sessionFollowService: SessionSettingsFollowService;
  /** Same derived flag admin-ui.ts uses to gate the chat push toggle. */
  pushEnabled: boolean;
  vapidPublicKey: string;
  /** SHIPWRIGHT_ADMIN_TZ (validated at startup), or its default. */
  timezone: string;
  /** admin-ui.ts's shared response helper (headers + PWA head-tag injection). */
  html: (content: string, opts?: { status?: number }) => Response;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function formatHour12(hour: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:00 ${period}`;
}

function renderFollowRow(follow: SessionFollowRow): string {
  return `<tr>
    <td><a href="/admin/sessions/${encodeURIComponent(follow.sessionSlug)}" style="color:#6366f1;text-decoration:none">${escapeHtml(follow.sessionSlug)}</a></td>
    <td style="text-align:right">
      <form method="POST" action="${NOTIFICATION_SETTINGS_PATH}/unfollow" style="margin:0">
        <input type="hidden" name="sessionSlug" value="${escapeHtml(follow.sessionSlug)}" />
        <button type="submit" class="btn btn-secondary" style="font-size:12px">Unfollow</button>
      </form>
    </td>
  </tr>`;
}

function renderNotificationSettingsPage(opts: {
  userEmail: string;
  prefs: UserNotificationPrefsRow;
  follows: SessionFollowRow[];
  pushEnabled: boolean;
  vapidPublicKey: string;
  timezone: string;
  error?: string;
}): string {
  const errorHtml = opts.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";

  // Push subscriptions are stored keyed by userEmail — see admin-ui.ts's
  // POST /admin/chat/:agentId/push/subscribe handler, which never reads its
  // own :agentId or the toggle's threadId, only c.var.userEmail. Those path
  // segments are structural, not semantic, so this page (which isn't scoped
  // to any one chat thread) can reuse the existing subscribe/unsubscribe
  // endpoints and renderPushToggle fragment verbatim with placeholder values.
  const pushToggleHtml = renderPushToggle({
    pushEnabled: opts.pushEnabled,
    vapidPublicKey: opts.vapidPublicKey,
    agentId: "settings",
    threadId: "notifications",
  });

  const followRows =
    opts.follows.length === 0
      ? `<tr><td colspan="2" class="empty-state">You are not following any sessions.</td></tr>`
      : opts.follows.map(renderFollowRow).join("\n");

  return renderAdminPage({
    title: "Notification Settings — Shipwright Admin",
    body: `${renderAdminToolbar(opts.userEmail, NOTIFICATION_SETTINGS_PATH)}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Notification settings</h1>
    </div>
    ${errorHtml}
    <div class="card">
      <div class="card-title">Push notifications</div>
      ${
        pushToggleHtml ||
        `<p style="font-size:13px;color:#6b7280;margin:0">Push notifications are not configured on this server.</p>`
      }
    </div>
    <div class="card">
      <div class="card-title">Session follow preferences</div>
      <form method="POST" action="${NOTIFICATION_SETTINGS_PATH}">
        <div class="form-group" style="display:flex;align-items:center;gap:6px">
          <input
            id="autoFollowSessions"
            name="autoFollowSessions"
            type="checkbox"
            value="on"
            ${opts.prefs.autoFollowSessions ? "checked" : ""}
          />
          <label class="form-label" for="autoFollowSessions" style="margin-bottom:0">Automatically follow sessions I start</label>
        </div>
        <div class="form-group">
          <label class="form-label" for="reminderHourLocal">Reminder hour (0–23, ${escapeHtml(opts.timezone)} time)</label>
          <input
            id="reminderHourLocal"
            name="reminderHourLocal"
            type="number"
            min="0"
            max="23"
            step="1"
            class="form-input"
            style="max-width:120px"
            value="${opts.prefs.reminderHourLocal}"
          />
          <p style="font-size:12px;color:#6b7280;margin:4px 0 0">Currently ${formatHour12(opts.prefs.reminderHourLocal)} ${escapeHtml(opts.timezone)}.</p>
        </div>
        <button type="submit" class="btn btn-primary">Save</button>
      </form>
    </div>
    <div class="card">
      <div class="card-title">Followed sessions</div>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Session</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${followRows}
          </tbody>
        </table>
      </div>
    </div>
  </div>`,
  });
}

// ─── Route registration ────────────────────────────────────────────────────────

/**
 * Registers GET/POST /admin/settings/notifications (+ its unfollow action)
 * onto the given app. Called from admin-ui.ts's createAdminUIApp() alongside
 * its other route-registration blocks.
 */
export function registerSessionSettingsRoutes(
  app: Hono<AdminUIEnv>,
  deps: SessionSettingsDeps,
): void {
  async function loadPageData(userEmail: string) {
    const [prefs, allFollows] = await Promise.all([
      deps.sessionFollowService.getOrCreatePrefs(userEmail),
      deps.sessionFollowService.listByUser(userEmail),
    ]);
    return { prefs, follows: allFollows.filter((f) => !f.muted) };
  }

  app.get(NOTIFICATION_SETTINGS_PATH, deps.requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const userEmail = c.var.userEmail;
    const { prefs, follows } = await loadPageData(userEmail);
    return deps.html(
      renderNotificationSettingsPage({
        userEmail,
        prefs,
        follows,
        pushEnabled: deps.pushEnabled,
        vapidPublicKey: deps.vapidPublicKey,
        timezone: deps.timezone,
      }),
    );
  });

  app.post(NOTIFICATION_SETTINGS_PATH, deps.requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const userEmail = c.var.userEmail;

    let autoFollowSessions = false;
    let reminderHourLocalRaw = "";
    try {
      const formData = await c.req.formData();
      const rawAuto = formData.get("autoFollowSessions");
      autoFollowSessions = rawAuto === "on" || rawAuto === "true";
      reminderHourLocalRaw = (
        formData.get("reminderHourLocal")?.toString() ?? ""
      ).trim();
    } catch {
      // Malformed body — treated as "no changes to reminderHourLocal, follow
      // toggle unchecked" below, and updatePrefs still runs so
      // autoFollowSessions=false is persisted consistently with an unchecked
      // checkbox submission.
    }

    const reminderHourLocal =
      reminderHourLocalRaw === "" ? undefined : Number(reminderHourLocalRaw);

    let error: string | undefined;
    try {
      await deps.sessionFollowService.updatePrefs(userEmail, {
        autoFollowSessions,
        reminderHourLocal,
      });
    } catch (err) {
      if (err instanceof BadRequestError) {
        error = err.message;
      } else {
        throw err;
      }
    }

    const { prefs, follows } = await loadPageData(userEmail);
    return deps.html(
      renderNotificationSettingsPage({
        userEmail,
        prefs,
        follows,
        pushEnabled: deps.pushEnabled,
        vapidPublicKey: deps.vapidPublicKey,
        timezone: deps.timezone,
        error,
      }),
      { status: error ? 400 : 200 },
    );
  });

  app.post(
    `${NOTIFICATION_SETTINGS_PATH}/unfollow`,
    deps.requireAuth,
    async (c) => {
      if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
      const userEmail = c.var.userEmail;

      let sessionSlug: string | undefined;
      try {
        const formData = await c.req.formData();
        sessionSlug = formData.get("sessionSlug")?.toString();
      } catch {
        // fall through — no-op unfollow below when sessionSlug is unset
      }

      if (sessionSlug) {
        await deps.sessionFollowService.unfollow(userEmail, sessionSlug);
      }

      return c.redirect(NOTIFICATION_SETTINGS_PATH, 302);
    },
  );
}
