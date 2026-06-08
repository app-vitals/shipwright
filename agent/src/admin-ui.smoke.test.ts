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

const CRON_ID = "cron-test-1";
const TOOL_ID = "tool-test-1";
const TOKEN_ID = "token-test-1";

function makeMockCronJob(overrides?: object) {
  return {
    id: CRON_ID,
    agentId: AGENT_ID,
    schedule: "0 * * * *",
    prompt: "Test prompt",
    channel: null,
    user: null,
    silent: false,
    enabled: true,
    preCheck: null,
    name: null,
    system: false,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

function makeMockTool(overrides?: object) {
  return {
    id: TOOL_ID,
    agentId: AGENT_ID,
    pattern: "Read",
    enabled: true,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

function makeMockToken(overrides?: object) {
  return {
    id: TOKEN_ID,
    agentId: AGENT_ID,
    token: "hashed-token-value",
    label: "test-token",
    revokedAt: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

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
      create: async () => makeMockCronJob(),
      delete: async () => {},
      setEnabled: async () => makeMockCronJob(),
    },
    agentToolService: {
      list: async () => [],
      add: async () => makeMockTool(),
      remove: async () => {},
      toggle: async () => makeMockTool(),
    },
    agentTokenService: {
      listForAgent: async () => [],
      create: async () => ({
        token: makeMockToken(),
        rawToken: "raw-token-abc123",
      }),
      revoke: async () => makeMockToken({ revokedAt: new Date() }),
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

  it("authenticated GET /admin/agents/:id?error=missing_fields renders an error banner", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}?error=missing_fields`,
      {
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("alert-error");
    expect(html).toContain("Required fields are missing");
  });

  it("authenticated GET /admin/agents/:id includes an add-cron form with enabled checkbox", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/admin/agents/');
    expect(html).toContain('name="schedule"');
    expect(html).toContain('name="enabled"');
    expect(html).toContain("Enabled");
  });

  it("authenticated GET /admin/agents/:id?newToken= renders new token notice", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}?newToken=raw-token-abc123`,
      {
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("raw-token-abc123");
  });
});

// ─── Cron job mutation routes ─────────────────────────────────────────────────

describe("admin UI — cron job mutation routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/crons with valid data redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({
      schedule: "0 * * * *",
      prompt: "Test prompt",
      channel: "C123",
      enabled: "true",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/crons`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/crons with missing schedule redirects with error", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ prompt: "Test prompt" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/crons`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=");
  });

  it("POST /admin/agents/:id/crons/:cronId/delete redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/delete`,
      {
        method: "POST",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/crons/:cronId/toggle redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ enabled: "false" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/toggle`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });
});

// ─── Tool mutation routes ─────────────────────────────────────────────────────

describe("admin UI — tool mutation routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/tools with valid pattern redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ pattern: "Read" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/tools`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/tools/:toolId/delete redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/tools/${TOOL_ID}/delete`,
      {
        method: "POST",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/tools/:toolId/toggle redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ enabled: "false" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/tools/${TOOL_ID}/toggle`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });
});

// ─── Token mutation routes ────────────────────────────────────────────────────

describe("admin UI — token mutation routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/tokens creates token and redirects with ?newToken= param", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ label: "my-token" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/tokens`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain(`/admin/agents/${AGENT_ID}`);
    expect(location).toContain("newToken=");
  });

  it("POST /admin/agents/:id/tokens/:tokenId/revoke redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/tokens/${TOKEN_ID}/revoke`,
      {
        method: "POST",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });
});
