/**
 * admin/src/admin-ui-sessions.smoke.test.ts
 * Smoke tests for GET/POST /admin/settings/notifications (SESH-6.3).
 *
 * Uses app.request() against a minimal Hono<AdminUIEnv> instance with
 * registerSessionSettingsRoutes() applied directly — no real server, no real
 * DB. SessionFollowService is injected as a plain in-memory object double
 * (per the "no mock.module()" isolation rule), mirroring the validation
 * contract session-follow-service.integration.test.ts already covers against
 * a real DB (this file does not re-test that logic, only the route's
 * translation of it into HTTP responses).
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { PUSH_TEST_PATH } from "./admin-ui-push-test.ts";
import {
  NOTIFICATION_SETTINGS_PATH,
  type SessionSettingsDeps,
  type SessionSettingsFollowService,
  registerSessionSettingsRoutes,
} from "./admin-ui-sessions.ts";
import type { AdminUIEnv } from "./admin-ui.ts";
import { BadRequestError } from "./errors.ts";
import type {
  SessionFollowRow,
  UserNotificationPrefsRow,
} from "./session-follow-service.ts";

// ─── Test doubles ─────────────────────────────────────────────────────────────

const DEFAULT_EMAIL = "dave@example.com";

function makeFollowRow(
  overrides: Partial<SessionFollowRow> = {},
): SessionFollowRow {
  return {
    id: `follow-${overrides.sessionSlug ?? "x"}`,
    userEmail: DEFAULT_EMAIL,
    sessionSlug: "sess-1",
    muted: false,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

/**
 * In-memory double implementing the same [0,23]-integer validation contract
 * as the real SessionFollowService.updatePrefs (tested against a real DB in
 * session-follow-service.integration.test.ts) — needed here so this route
 * layer's BadRequestError → 400 translation can actually be exercised.
 */
function makeFakeSessionFollowService(
  seedFollows: SessionFollowRow[] = [],
): SessionSettingsFollowService {
  let follows = [...seedFollows];
  let prefs: UserNotificationPrefsRow = {
    userEmail: DEFAULT_EMAIL,
    autoFollowSessions: true,
    reminderHourLocal: 9,
    autoFollowSince: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  };

  return {
    async listByUser(userEmail) {
      return follows.filter((f) => f.userEmail === userEmail);
    },
    async getOrCreatePrefs() {
      return prefs;
    },
    async updatePrefs(_userEmail, input) {
      if (input.reminderHourLocal !== undefined) {
        const hour = input.reminderHourLocal;
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          throw new BadRequestError(
            `reminderHourLocal must be an integer in [0, 23], got ${hour}`,
          );
        }
      }
      prefs = {
        ...prefs,
        ...(input.autoFollowSessions !== undefined
          ? { autoFollowSessions: input.autoFollowSessions }
          : {}),
        ...(input.reminderHourLocal !== undefined
          ? { reminderHourLocal: input.reminderHourLocal }
          : {}),
      };
      return prefs;
    },
    async unfollow(userEmail, sessionSlug) {
      follows = follows.filter(
        (f) => !(f.userEmail === userEmail && f.sessionSlug === sessionSlug),
      );
    },
  };
}

function fakeHtml(content: string, opts?: { status?: number }): Response {
  return new Response(content, {
    status: opts?.status ?? 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function makeFakeRequireAuth(): MiddlewareHandler<AdminUIEnv> {
  return async (c, next) => {
    c.set("userEmail", c.req.header("x-test-user-email") ?? DEFAULT_EMAIL);
    c.set("isAdmin", c.req.header("x-test-is-admin") !== "false");
    await next();
  };
}

function buildApp(
  overrides: Partial<SessionSettingsDeps> = {},
): Hono<AdminUIEnv> {
  const app = new Hono<AdminUIEnv>();
  const deps: SessionSettingsDeps = {
    requireAuth: makeFakeRequireAuth(),
    sessionFollowService: makeFakeSessionFollowService(),
    pushEnabled: false,
    vapidPublicKey: "",
    timezone: "America/Los_Angeles",
    html: fakeHtml,
    ...overrides,
  };
  registerSessionSettingsRoutes(app, deps);
  return app;
}

function formBody(fields: Record<string, string>): {
  body: string;
  headers: Record<string, string>;
} {
  return {
    body: new URLSearchParams(fields).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  };
}

// ─── GET — auth ─────────────────────────────────────────────────────────────

describe("GET /admin/settings/notifications — auth", () => {
  it("returns 403 for a non-admin user", async () => {
    const app = buildApp();
    const res = await app.request(NOTIFICATION_SETTINGS_PATH, {
      headers: { "x-test-is-admin": "false" },
    });
    expect(res.status).toBe(403);
  });
});

// ─── GET — push toggle gating ───────────────────────────────────────────────

describe("GET /admin/settings/notifications — push toggle gating", () => {
  it("renders the push toggle when VAPID is configured", async () => {
    const app = buildApp({ pushEnabled: true, vapidPublicKey: "BPUBLICKEY" });
    const res = await app.request(NOTIFICATION_SETTINGS_PATH);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("push-toggle-btn");
    expect(text).toContain("BPUBLICKEY");
  });

  it("renders the Send test notification control alongside the toggle", async () => {
    const app = buildApp({ pushEnabled: true, vapidPublicKey: "BPUBLICKEY" });
    const text = await (await app.request(NOTIFICATION_SETTINGS_PATH)).text();
    expect(text).toContain("push-test-btn");
    expect(text).toContain(PUSH_TEST_PATH);
    expect(text).toContain("Following a session does not subscribe this device");
  });

  it("omits the Send test notification control when push is disabled", async () => {
    const app = buildApp({ pushEnabled: false, vapidPublicKey: "" });
    const text = await (await app.request(NOTIFICATION_SETTINGS_PATH)).text();
    expect(text).not.toContain("push-test-btn");
  });

  it("omits the push toggle when VAPID is not configured", async () => {
    const app = buildApp({ pushEnabled: false, vapidPublicKey: "" });
    const res = await app.request(NOTIFICATION_SETTINGS_PATH);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("push-toggle-btn");
    expect(text.toLowerCase()).toContain("not configured");
  });
});

// ─── GET — followed sessions list ──────────────────────────────────────────

describe("GET /admin/settings/notifications — followed sessions list", () => {
  it("lists non-muted follows and excludes muted ones", async () => {
    const app = buildApp({
      sessionFollowService: makeFakeSessionFollowService([
        makeFollowRow({ sessionSlug: "sess-active", muted: false }),
        makeFollowRow({ sessionSlug: "sess-muted", muted: true }),
      ]),
    });
    const res = await app.request(NOTIFICATION_SETTINGS_PATH);
    const text = await res.text();
    expect(text).toContain("sess-active");
    expect(text).not.toContain("sess-muted");
  });

  it("shows an empty-state message when there are no follows", async () => {
    const app = buildApp({
      sessionFollowService: makeFakeSessionFollowService([]),
    });
    const res = await app.request(NOTIFICATION_SETTINGS_PATH);
    const text = await res.text();
    expect(text.toLowerCase()).toContain("not following any sessions");
  });

  it("renders the current reminderHourLocal value from prefs", async () => {
    const app = buildApp();
    const res = await app.request(NOTIFICATION_SETTINGS_PATH);
    const text = await res.text();
    expect(text).toContain('value="9"');
    expect(text).toContain("America/Los_Angeles");
  });
});

// ─── POST — validation boundary ────────────────────────────────────────────

/**
 * Valid range note: the authoritative range is [0, 23] — an hour-of-day.
 * It is set by SessionFollowService.updatePrefs (SES-6.1) and mirrored by the
 * rendered input's min=0/max=23.
 *
 * SESH-6.3's acceptance criteria describe the boundary as "24 valid, 25
 * invalid", which is a typo — that same task's description says "validating
 * reminderHourLocal 0-23", and 24 is not a valid hour-of-day. These tests
 * assert the real contract (23 is the last valid hour, 24 and 25 both reject)
 * and additionally cover the literal value 25 named in the AC, so both
 * readings are exercised and the discrepancy doesn't resurface as confusion.
 */
describe("POST /admin/settings/notifications — reminderHourLocal validation", () => {
  it("rejects reminderHourLocal = 24 with 400", async () => {
    const app = buildApp();
    const { body, headers } = formBody({
      reminderHourLocal: "24",
      autoFollowSessions: "on",
    });
    const res = await app.request(NOTIFICATION_SETTINGS_PATH, {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(400);
  });

  it("rejects reminderHourLocal = 25 with 400 (the literal value named in the AC)", async () => {
    const app = buildApp();
    const { body, headers } = formBody({
      reminderHourLocal: "25",
      autoFollowSessions: "on",
    });
    const res = await app.request(NOTIFICATION_SETTINGS_PATH, {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(400);
  });

  it("accepts reminderHourLocal = 23 as the upper valid boundary value", async () => {
    const service = makeFakeSessionFollowService();
    const app = buildApp({ sessionFollowService: service });
    const { body, headers } = formBody({ reminderHourLocal: "23" });
    const res = await app.request(NOTIFICATION_SETTINGS_PATH, {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('value="23"');
  });

  it("accepts reminderHourLocal = 7, persists it, and re-renders showing the new value", async () => {
    const service = makeFakeSessionFollowService();
    const app = buildApp({ sessionFollowService: service });
    const { body, headers } = formBody({
      reminderHourLocal: "7",
      autoFollowSessions: "on",
    });
    const res = await app.request(NOTIFICATION_SETTINGS_PATH, {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('value="7"');

    // Persisted — a subsequent GET reflects the same value.
    const getRes = await app.request(NOTIFICATION_SETTINGS_PATH);
    const getText = await getRes.text();
    expect(getText).toContain('value="7"');
  });

  it("accepts reminderHourLocal = 0 as a valid boundary value", async () => {
    const app = buildApp();
    const { body, headers } = formBody({ reminderHourLocal: "0" });
    const res = await app.request(NOTIFICATION_SETTINGS_PATH, {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(200);
  });

  it("rejects a negative reminderHourLocal with 400", async () => {
    const app = buildApp();
    const { body, headers } = formBody({ reminderHourLocal: "-1" });
    const res = await app.request(NOTIFICATION_SETTINGS_PATH, {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(400);
  });

  it("returns 403 for a non-admin POST", async () => {
    const app = buildApp();
    const { body, headers } = formBody({ reminderHourLocal: "7" });
    const res = await app.request(NOTIFICATION_SETTINGS_PATH, {
      method: "POST",
      body,
      headers: { ...headers, "x-test-is-admin": "false" },
    });
    expect(res.status).toBe(403);
  });
});

// ─── POST — unfollow ────────────────────────────────────────────────────────

describe("POST /admin/settings/notifications/unfollow", () => {
  it("removes the SessionFollow row and redirects back", async () => {
    const service = makeFakeSessionFollowService([
      makeFollowRow({ sessionSlug: "sess-1" }),
    ]);
    const app = buildApp({ sessionFollowService: service });

    const { body, headers } = formBody({ sessionSlug: "sess-1" });
    const res = await app.request(`${NOTIFICATION_SETTINGS_PATH}/unfollow`, {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(NOTIFICATION_SETTINGS_PATH);

    const getRes = await app.request(NOTIFICATION_SETTINGS_PATH);
    const getText = await getRes.text();
    expect(getText).not.toContain("sess-1");
    expect(getText.toLowerCase()).toContain("not following any sessions");
  });

  it("is a no-op when unfollowing a session not currently followed", async () => {
    const service = makeFakeSessionFollowService([
      makeFollowRow({ sessionSlug: "sess-1" }),
    ]);
    const app = buildApp({ sessionFollowService: service });

    const { body, headers } = formBody({ sessionSlug: "never-followed" });
    const res = await app.request(`${NOTIFICATION_SETTINGS_PATH}/unfollow`, {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(302);

    const getRes = await app.request(NOTIFICATION_SETTINGS_PATH);
    const getText = await getRes.text();
    expect(getText).toContain("sess-1");
  });
});
