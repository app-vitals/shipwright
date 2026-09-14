/**
 * admin/src/admin-ui-push-test.smoke.test.ts
 * Smoke tests for POST /admin/push/test — the "Send test notification" route.
 *
 * app.request() against a minimal Hono<AdminUIEnv> with registerPushTestRoute()
 * applied directly. PushService is an in-memory double exposing only
 * sendToUsers (the route's whole dependency surface) — no real push provider,
 * no global fetch.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
  PUSH_TEST_PATH,
  PUSH_TEST_PAYLOAD,
  type PushTestRouteDeps,
  registerPushTestRoute,
} from "./admin-ui-push-test.ts";
import type { AdminUIEnv } from "./admin-ui.ts";
import type { PushDetailLevel } from "./push-content.ts";

const DEFAULT_EMAIL = "dave@example.com";

function makeFakeRequireAuth(
  { isAdmin = true }: { isAdmin?: boolean } = {},
): MiddlewareHandler<AdminUIEnv> {
  return async (c, next) => {
    c.set("userEmail", c.req.header("x-test-user-email") ?? DEFAULT_EMAIL);
    c.set("isAdmin", isAdmin);
    await next();
  };
}

function fakePushService(subscribedEmails: string[]) {
  const calls: Array<{ emails: string[]; payload: string }> = [];
  return {
    calls,
    pushService: {
      sendToUsers: async (
        emails: string[],
        buildPayload: (level: PushDetailLevel) => string,
      ) => {
        const payload = buildPayload("generic");
        calls.push({ emails, payload });
        const delivered = emails.filter((e) =>
          subscribedEmails.includes(e),
        ).length;
        return { delivered, pruned: 0 };
      },
    },
  };
}

function buildApp(
  overrides: Partial<PushTestRouteDeps> = {},
  authOpts: { isAdmin?: boolean } = {},
): Hono<AdminUIEnv> {
  const app = new Hono<AdminUIEnv>();
  registerPushTestRoute(app, {
    requireAuth: makeFakeRequireAuth(authOpts),
    pushEnabled: true,
    ...overrides,
  });
  return app;
}

describe("POST /admin/push/test", () => {
  it("sends the fixed test payload to the caller's own email only", async () => {
    const { pushService, calls } = fakePushService([DEFAULT_EMAIL]);
    const app = buildApp({ pushService });

    const res = await app.request(PUSH_TEST_PATH, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, delivered: 1, pruned: 0 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.emails).toEqual([DEFAULT_EMAIL]);
    expect(JSON.parse(calls[0]?.payload ?? "{}")).toEqual(PUSH_TEST_PAYLOAD);
  });

  it("reports delivered=0 when the caller has no live subscription", async () => {
    const { pushService } = fakePushService([]); // nobody subscribed
    const app = buildApp({ pushService });

    const res = await app.request(PUSH_TEST_PATH, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, delivered: 0, pruned: 0 });
  });

  it("targets the authenticated user, never a caller-supplied email", async () => {
    const { pushService, calls } = fakePushService(["other@example.com"]);
    const app = buildApp({ pushService });

    const res = await app.request(PUSH_TEST_PATH, {
      method: "POST",
      headers: { "x-test-user-email": "other@example.com" },
      body: JSON.stringify({ emails: ["victim@example.com"] }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]?.emails).toEqual(["other@example.com"]);
  });

  it("returns 503 when push is disabled", async () => {
    const app = buildApp({ pushEnabled: false });
    const res = await app.request(PUSH_TEST_PATH, { method: "POST" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "push_disabled" });
  });

  it("returns 503 when push is enabled but no service was wired", async () => {
    const app = buildApp({ pushEnabled: true, pushService: undefined });
    const res = await app.request(PUSH_TEST_PATH, { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("returns 403 for an authenticated non-admin", async () => {
    const { pushService, calls } = fakePushService([DEFAULT_EMAIL]);
    const app = buildApp({ pushService }, { isAdmin: false });

    const res = await app.request(PUSH_TEST_PATH, { method: "POST" });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
