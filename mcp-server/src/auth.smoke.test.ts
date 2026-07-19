/**
 * mcp-server/src/auth.smoke.test.ts
 *
 * Smoke tests for the inbound bearer auth middleware (TSM-2.6). Tests run
 * in-process via a minimal Hono app — no real HTTP socket, no real token
 * service (mcp-server has no DB; this is a static single-secret comparison,
 * unlike task-store's DB-backed TokenService).
 *
 * Covers:
 *   - missing Authorization header -> 401, WWW-Authenticate: Bearer
 *   - non-"Bearer " scheme (e.g. Basic) -> 401, WWW-Authenticate: Bearer
 *   - malformed header (present but no "Bearer " prefix) -> 401, WWW-Authenticate: Bearer
 *   - wrong/invalid token -> 401, WWW-Authenticate: Bearer error="invalid_token"
 *   - valid token -> 200, request reaches the downstream handler
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createBearerAuthMiddleware } from "./auth.ts";

const VALID_TOKEN = "test-mcp-server-token";

function makeAuthApp() {
  const app = new Hono();
  app.use("*", createBearerAuthMiddleware(VALID_TOKEN));
  app.get("/probe", (c) => c.json({ ok: true }));
  return app;
}

describe("mcp-server bearer auth middleware", () => {
  it("returns 401 with WWW-Authenticate: Bearer when the Authorization header is absent", async () => {
    const app = makeAuthApp();
    const res = await app.request("/probe");

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when the Authorization header is present but not a Bearer scheme", async () => {
    const app = makeAuthApp();
    const res = await app.request("/probe", {
      headers: { Authorization: `Basic ${btoa("user:pass")}` },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("returns 401 when the Authorization header is malformed (missing 'Bearer ' prefix)", async () => {
    const app = makeAuthApp();
    const res = await app.request("/probe", {
      headers: { Authorization: VALID_TOKEN },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("returns 401 with invalid_token error when the token is wrong", async () => {
    const app = makeAuthApp();
    const res = await app.request("/probe", {
      headers: { Authorization: "Bearer not-the-real-token" },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="invalid_token"',
    );
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("accepts a valid token and lets the request through", async () => {
    const app = makeAuthApp();
    const res = await app.request("/probe", {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
