/**
 * agent/src/admin-ui.smoke.test.ts
 * Smoke tests for the Admin UI shell (admin-ui.ts).
 *
 * Uses app.request() — no real server, no real DB.
 * Services are injected as in-memory test doubles.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import { createAdminUIApp } from "./admin-ui.ts";
import type { AdminUIDeps } from "./admin-ui.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const ADMIN_PASSWORD = "correct-horse-battery-staple";
const AGENT_ID = "agent-test-123";

// ─── JWT helper ───────────────────────────────────────────────────────────────

async function makeSessionCookie(secret = SESSION_SECRET): Promise<string> {
  return sign(
    {
      userId: "admin",
      email: "admin",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    "HS256",
  );
}

// ─── Mock deps ────────────────────────────────────────────────────────────────

function makeMockDeps(): AdminUIDeps {
  return {
    prisma: {
      agent: {
        findMany: async () => [
          {
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
          },
        ],
        findUnique: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        }),
        create: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        }),
      },
      agentPlugin: {
        findMany: async () => [],
      },
    },
    agentEnvService: {
      getByAgentId: async () => ({ FOO: "bar" }),
      upsert: async () => {},
      deleteKey: async () => {},
      getConfigBundle: async () => null,
    },
    agentCronJobService: {
      list: async () => [],
    },
    agentToolService: {
      list: async () => [],
    },
    agentTokenService: {
      listForAgent: async () => [],
    },
    agentPluginService: {
      list: async () => [],
    },
    sessionSecret: SESSION_SECRET,
    adminPassword: ADMIN_PASSWORD,
    slackClient: {
      createAppManifest: async () => ({
        appId: "A123456",
        oauthRedirectUrl: "https://slack.com/oauth/authorize?client_id=123",
      }),
      exchangeCodeForAppToken: async () => ({
        appId: "A123456",
        signingSecret: "abc123signingsecret",
      }),
    },
    appBaseUrl: "https://example.com",
  };
}

// ─── Auth redirect tests ──────────────────────────────────────────────────────

describe("admin UI — unauthenticated redirects", () => {
  it("unauthenticated GET /admin/agents redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });

  it("unauthenticated GET /admin/agents/:id redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });
});

// ─── Login page ───────────────────────────────────────────────────────────────

describe("admin UI — login page", () => {
  it("GET /admin/login returns 200 with login form", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<form");
    expect(html).toContain('type="password"');
  });

  it("POST /admin/login with valid password sets session cookie and redirects to /admin/agents", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ password: ADMIN_PASSWORD });
    const res = await app.request("/admin/login", {
      method: "POST",
      body: body.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents");
    const cookie = res.headers.get("Set-Cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain("admin_session=");
    expect(cookie).toContain("HttpOnly");
  });

  it("POST /admin/login with wrong password returns 401", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ password: "wrong-password" });
    const res = await app.request("/admin/login", {
      method: "POST",
      body: body.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(401);
  });
});

// ─── Authenticated pages ──────────────────────────────────────────────────────

describe("admin UI — authenticated pages", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("authenticated GET /admin/agents returns 200 with agents list", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Test Agent");
  });

  it("authenticated GET /admin/agents/:id returns 200 with agent detail sections", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Env Vars");
    expect(html).toContain("Cron Jobs");
    expect(html).toContain("Tools");
    expect(html).toContain("Tokens");
    expect(html).toContain("Plugins");
  });
});
