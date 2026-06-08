/**
 * agent/src/admin-ui.smoke.test.ts
 * Smoke tests for the Admin UI HTML routes (admin-ui.ts).
 *
 * Uses app.request() — no real server, no real DB.
 * Services are injected as in-memory recorded doubles.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import { createAdminUIApp } from "./admin-ui.ts";
import type { AdminUIDeps, AgentRepository } from "./admin-ui.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const ADMIN_PASSWORD = "hunter2";
const AGENT_ID = "agent-test-123";

// ─── JWT helper ───────────────────────────────────────────────────────────────

async function makeSessionCookie(secret = SESSION_SECRET): Promise<string> {
  return sign(
    {
      userId: "admin",
      email: "admin@example.com",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    "HS256",
  );
}

// ─── Recorded doubles ─────────────────────────────────────────────────────────

function makeAgentRepo(): AgentRepository {
  return {
    list: async () => [
      {
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123",
        createdAt: new Date("2024-01-01"),
        envCount: 3,
        cronCount: 2,
        toolCount: 4,
        tokenCount: 1,
        pluginCount: 2,
      },
    ],
    findById: async (id: string) => {
      if (id !== AGENT_ID) return null;
      return {
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        envVars: { FOO: "bar", SECRET: "value" },
        crons: [
          {
            id: "cron-1",
            schedule: "0 9 * * 1-5",
            prompt: "daily standup",
            channel: "C123",
            user: null,
            enabled: true,
            name: null,
          },
        ],
        tools: [{ id: "tool-1", pattern: "Read", enabled: true }],
        tokens: [{ id: "token-1", label: "deploy token", createdAt: new Date("2024-01-01"), revokedAt: null }],
        plugins: [{ id: "plugin-1", name: "@shipwright/plugin", version: "1.0.0", enabled: true }],
      };
    },
  };
}

function makeMockDeps(): AdminUIDeps {
  return {
    agentRepo: makeAgentRepo(),
    agentEnvService: {
      patch: async () => {},
      deleteKey: async () => {},
      getByAgentId: async () => ({ FOO: "bar" }),
    },
    sessionSecret: SESSION_SECRET,
    adminPassword: ADMIN_PASSWORD,
    baseUrl: "https://example.com",
  };
}

// ─── Auth smoke tests ─────────────────────────────────────────────────────────

describe("admin UI — auth redirects", () => {
  it("unauthenticated GET /admin/agents redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents", { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("/admin/login");
  });

  it("unauthenticated GET /admin/agents/:id redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("/admin/login");
  });
});

// ─── Login tests ──────────────────────────────────────────────────────────────

describe("admin UI — login", () => {
  it("GET /admin/login renders login page (200)", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/login");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<form");
    expect(text).toContain("password");
  });

  it("POST /admin/login with correct password redirects to /admin/agents and sets session cookie", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ password: ADMIN_PASSWORD });
    const res = await app.request("/admin/login", {
      method: "POST",
      body: body.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBe("/admin/agents");
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("admin_session");
    expect(setCookie).toContain("HttpOnly");
  });

  it("POST /admin/login with wrong password renders login page with error", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ password: "wrong-password" });
    const res = await app.request("/admin/login", {
      method: "POST",
      body: body.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // Should show an error indicator
    expect(text.toLowerCase()).toMatch(/invalid|incorrect|error|wrong/);
  });
});

// ─── Authenticated pages ──────────────────────────────────────────────────────

describe("admin UI — authenticated pages", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("authenticated GET /admin/agents returns 200 HTML with agent list", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Test Agent");
    expect(text).toContain(AGENT_ID);
  });

  it("authenticated GET /admin/agents/:id returns 200 with detail sections", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Test Agent");
    // Should contain section headers for all resource types
    expect(text.toLowerCase()).toMatch(/env/);
    expect(text.toLowerCase()).toMatch(/cron/);
    expect(text.toLowerCase()).toMatch(/tool/);
    expect(text.toLowerCase()).toMatch(/token/);
    expect(text.toLowerCase()).toMatch(/plugin/);
  });

  it("authenticated GET /admin/agents/:id for unknown agent returns 404", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents/nonexistent-id", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(404);
  });
});

// ─── Logout ───────────────────────────────────────────────────────────────────

describe("admin UI — logout", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/logout redirects to /admin/login and clears session cookie", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/logout", {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBe("/admin/login");
    const setCookie = res.headers.get("set-cookie");
    // Cookie should be cleared (max-age=0 or expires in the past)
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("admin_session");
  });
});

// ─── Env var mutations ────────────────────────────────────────────────────────

describe("admin UI — env var mutations", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/envs patches env and redirects back", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ key: "NEW_VAR", value: "new-value" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/envs`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain(AGENT_ID);
  });

  it("POST /admin/agents/:id/envs/delete deletes env key and redirects back", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ key: "FOO" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/envs/delete`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain(AGENT_ID);
  });
});
