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
import type { AgentTokenService, AgentTokenValidated } from "./agent-tokens.ts";
import { createAdminAuthMiddleware, parseAdminApiKeys } from "./api-auth.ts";

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
  adminApiKeys?: Map<string, { name: string; scope: string }>,
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
      adminApiKeys,
    }),
  );
  app.get("/test", (c) => c.json({ ok: true }));
  // Scoped agent route — mirrors real admin API pattern
  app.get("/agents/:id/envs", (c) => c.json({ agentId: c.req.param("id") }));
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
      {
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
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

  it("returns 401 with WWW-Authenticate when Authorization header is malformed", async () => {
    const app = buildApp(async () => null);
    const res = await app.request("/test", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("returns 401 with WWW-Authenticate when bearer token is invalid", async () => {
    const app = buildApp(async () => null);
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer bad-token" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="invalid_token"',
    );
  });
});

describe("createAdminAuthMiddleware — bearer token scope enforcement", () => {
  it("passes when token agentId matches the :id route param", async () => {
    const app = buildApp(async (raw) =>
      raw === VALID_RAW_TOKEN ? { agentId: AGENT_ID } : null,
    );
    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Authorization: `Bearer ${VALID_RAW_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentId).toBe(AGENT_ID);
  });

  it("returns 403 when token agentId does not match the :id route param", async () => {
    const app = buildApp(async (raw) =>
      raw === VALID_RAW_TOKEN ? { agentId: AGENT_ID } : null,
    );
    const res = await app.request("/agents/agent-different-id/envs", {
      headers: { Authorization: `Bearer ${VALID_RAW_TOKEN}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("passes for routes without an :id param (no scope to enforce)", async () => {
    // Unscoped route — token is valid, no :id to compare against
    const app = buildApp(async (raw) =>
      raw === VALID_RAW_TOKEN ? { agentId: AGENT_ID } : null,
    );
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${VALID_RAW_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

// ─── Admin API key tests ───────────────────────────────────────────────────────

const ADMIN_TOKEN = "admin-key-scope-star";
const SCOPED_TOKEN = "scoped-key-for-agent";

describe("parseAdminApiKeys", () => {
  it("returns empty map for undefined input", () => {
    const map = parseAdminApiKeys(undefined);
    expect(map.size).toBe(0);
  });

  it("returns empty map for empty string", () => {
    const map = parseAdminApiKeys("");
    expect(map.size).toBe(0);
  });

  it("parses a single admin key with scope=*", () => {
    const map = parseAdminApiKeys("admin:admin-key-scope-star:*");
    expect(map.size).toBe(1);
    const entry = map.get("admin-key-scope-star");
    expect(entry).toEqual({ name: "admin", scope: "*" });
  });

  it("parses a scoped key with agentId scope", () => {
    const map = parseAdminApiKeys(`svc:${SCOPED_TOKEN}:${AGENT_ID}`);
    expect(map.size).toBe(1);
    expect(map.get(SCOPED_TOKEN)).toEqual({ name: "svc", scope: AGENT_ID });
  });

  it("parses multiple keys from comma-separated string", () => {
    const map = parseAdminApiKeys(
      `admin:${ADMIN_TOKEN}:*,svc:${SCOPED_TOKEN}:${AGENT_ID}`,
    );
    expect(map.size).toBe(2);
    expect(map.get(ADMIN_TOKEN)).toEqual({ name: "admin", scope: "*" });
    expect(map.get(SCOPED_TOKEN)).toEqual({ name: "svc", scope: AGENT_ID });
  });

  it("handles tokens with embedded colons", () => {
    const map = parseAdminApiKeys("admin:sk:abc:def:*");
    expect(map.size).toBe(1);
    expect(map.get("sk:abc:def")).toEqual({ name: "admin", scope: "*" });
  });

  it("skips malformed entries with fewer than 3 parts", () => {
    const map = parseAdminApiKeys("bad-entry,admin:token:*");
    expect(map.size).toBe(1);
    expect(map.get("token")).toEqual({ name: "admin", scope: "*" });
  });
});

describe("createAdminAuthMiddleware — admin API keys", () => {
  it("admin key with scope=* bypasses all scope enforcement", async () => {
    const adminApiKeys = new Map([
      [ADMIN_TOKEN, { name: "admin", scope: "*" }],
    ]);
    // validateFn always returns null — should NOT be called
    let validateCalled = false;
    const app = buildApp(async () => {
      validateCalled = true;
      return null;
    }, adminApiKeys);

    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(validateCalled).toBe(false);
  });

  it("admin key accepted for any route (no agent ID in path)", async () => {
    const adminApiKeys = new Map([
      [ADMIN_TOKEN, { name: "admin", scope: "*" }],
    ]);
    const app = buildApp(async () => null, adminApiKeys);

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("scoped admin key enforces agentId match on agent routes", async () => {
    const adminApiKeys = new Map([
      [SCOPED_TOKEN, { name: "svc", scope: AGENT_ID }],
    ]);
    const app = buildApp(async () => null, adminApiKeys);

    const res = await app.request("/agents/different-agent/envs", {
      headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("scoped admin key allows access when agentId matches scope", async () => {
    const adminApiKeys = new Map([
      [SCOPED_TOKEN, { name: "svc", scope: AGENT_ID }],
    ]);
    const app = buildApp(async () => null, adminApiKeys);

    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentId).toBe(AGENT_ID);
  });

  it("invalid bearer 401 when neither env key nor DB token matches", async () => {
    const adminApiKeys = new Map([
      [ADMIN_TOKEN, { name: "admin", scope: "*" }],
    ]);
    const app = buildApp(async () => null, adminApiKeys);

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer unknown-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("absent SHIPWRIGHT_ADMIN_API_KEYS env var is a no-op (falls through to DB path)", async () => {
    // No adminApiKeys provided — should fall through to validateFn (DB path)
    let validateCalled = false;
    const app = buildApp(async (raw) => {
      validateCalled = true;
      return raw === VALID_RAW_TOKEN ? { agentId: AGENT_ID } : null;
    });

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${VALID_RAW_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(validateCalled).toBe(true);
  });
});
