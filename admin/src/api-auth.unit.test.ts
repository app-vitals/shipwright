/**
 * admin/src/api-auth.unit.test.ts
 * Unit tests for the combined admin auth middleware (bearer token + session cookie).
 *
 * Pure logic — mocks agentTokenService, injects a known sessionSecret.
 * No real DB, no real JWT library calls beyond what Hono's own helpers do.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { createAdminAuthMiddleware } from "./api-auth.ts";
import type { AgentTokenService, AgentTokenValidated } from "./agent-tokens.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-session-secret-exactly-32-bytes!";
const VALID_RAW_TOKEN = "valid-raw-token-hex-string";
const AGENT_ID = "agent-abc-123";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a valid session JWT */
async function makeSessionJwt(secret = SESSION_SECRET): Promise<string> {
  return sign(
    {
      userId: "user-1",
      email: "admin@example.com",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    "HS256",
  );
}

/** Build a minimal Hono app protected by the middleware under test */
function buildApp(
  validateFn: (raw: string) => Promise<AgentTokenValidated | null>,
): Hono {
  const mockTokenService: Pick<AgentTokenService, "validate"> = {
    validate: validateFn,
  };

  const app = new Hono();
  app.use(
    "*",
    createAdminAuthMiddleware({
      sessionSecret: SESSION_SECRET,
      agentTokenService: mockTokenService,
    }),
  );
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createAdminAuthMiddleware — no auth", () => {
  it("returns 401 when no Authorization header and no cookie", async () => {
    const app = buildApp(async () => null);
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });
});

describe("createAdminAuthMiddleware — session cookie", () => {
  it("passes when a valid session cookie is present", async () => {
    const app = buildApp(async () => null);
    const jwt = await makeSessionJwt();
    const res = await app.request("/test", {
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 401 when session cookie is signed with wrong secret", async () => {
    const app = buildApp(async () => null);
    const jwt = await makeSessionJwt("wrong-secret-32-bytes-exactly!!!");
    const res = await app.request("/test", {
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when session cookie is not a valid JWT", async () => {
    const app = buildApp(async () => null);
    const res = await app.request("/test", {
      headers: { Cookie: "admin_session=not.a.valid.jwt" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when session cookie JWT is missing required fields", async () => {
    // Sign a JWT missing userId/email
    const jwt = await sign(
      { iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
      SESSION_SECRET,
      "HS256",
    );
    const app = buildApp(async () => null);
    const res = await app.request("/test", {
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("createAdminAuthMiddleware — bearer token", () => {
  it("passes when a valid bearer token is provided", async () => {
    const app = buildApp(async (raw) =>
      raw === VALID_RAW_TOKEN ? { agentId: AGENT_ID } : null,
    );
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${VALID_RAW_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 401 when bearer token is invalid (validate returns null)", async () => {
    const app = buildApp(async () => null);
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when bearer token is revoked (validate returns null for revoked)", async () => {
    // validate() returns null for revoked tokens — same branch
    const app = buildApp(async () => null);
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer revoked-token-value" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 immediately when Authorization header is present but invalid — does NOT fall through to cookie", async () => {
    // Authorization header present + invalid → reject, even if a valid cookie is also present
    const jwt = await makeSessionJwt();
    const app = buildApp(async () => null);
    const res = await app.request("/test", {
      headers: {
        Authorization: "Bearer invalid-token",
        Cookie: `admin_session=${jwt}`,
      },
    });
    expect(res.status).toBe(401);
  });

  it("falls through to session cookie when Authorization header is absent", async () => {
    // No Authorization header → try cookie path → should succeed
    const app = buildApp(async () => null);
    const jwt = await makeSessionJwt();
    const res = await app.request("/test", {
      headers: { Cookie: `admin_session=${jwt}` },
    });
    expect(res.status).toBe(200);
  });
});
