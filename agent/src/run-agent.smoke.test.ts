/**
 * agent/src/run-agent.smoke.test.ts
 * Smoke tests for the composed Hono app from run-agent.ts.
 *
 * Tests all route groups in the composed app using app.request() — no real
 * socket, no real DB, no real network. Services are injected as in-memory doubles.
 *
 * No mock.module(), no global.* overrides.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import { createComposedApp } from "./run-agent.ts";
import type { ComposedAppDeps } from "./run-agent.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const ADMIN_PASSWORD = "correct-horse-battery-staple";
const INTERNAL_API_KEY = "test-internal-api-key";
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

// ─── Mock doubles ─────────────────────────────────────────────────────────────

function makeMockDeps(): ComposedAppDeps {
  const mockAgent = {
    id: AGENT_ID,
    name: "Test Agent",
    slackId: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  };

  return {
    prisma: {
      agent: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === AGENT_ID ? mockAgent : null,
        findMany: async () => [mockAgent],
        create: async () => mockAgent,
      },
      agentPlugin: {
        findMany: async () => [],
      },
    } as never,
    agentEnvService: {
      getConfigBundle: async (id: string) =>
        id === AGENT_ID
          ? { agentId: id, env: { FOO: "bar" }, allowedTools: ["Read"] }
          : null,
      getByAgentId: async () => ({ FOO: "bar" }),
      upsert: async () => {},
      patch: async () => {},
      deleteKey: async () => {},
    },
    agentCronJobService: {
      list: async () => [],
      create: async () => {
        throw new Error("not implemented");
      },
      update: async () => {
        throw new Error("not implemented");
      },
      delete: async () => {},
      reconcileSystemCrons: async () => ({
        created: 0,
        updated: 0,
        deleted: 0,
      }),
      get: async () => {
        throw new Error("not implemented");
      },
      setEnabled: async () => {
        throw new Error("not implemented");
      },
    },
    agentToolService: {
      list: async () => [],
      add: async () => {
        throw new Error("not implemented");
      },
      remove: async () => {},
      toggle: async () => {
        throw new Error("not implemented");
      },
    },
    agentTokenService: {
      create: async () => {
        throw new Error("not implemented");
      },
      listForAgent: async () => [],
      revoke: async () => null,
    },
    agentPluginService: {
      list: async () => [],
      add: async () => {
        throw new Error("not implemented");
      },
      remove: async () => {},
      removeByName: async () => {},
    },
    internalApiKey: INTERNAL_API_KEY,
    sessionSecret: SESSION_SECRET,
    adminPassword: ADMIN_PASSWORD,
    slackClient: {
      createAppManifest: async () => ({
        appId: "A123",
        oauthRedirectUrl: "https://slack.com/oauth",
      }),
    },
    appBaseUrl: "http://localhost:3000",
  };
}

// ─── Health route ─────────────────────────────────────────────────────────────

describe("composed app — /health", () => {
  it("GET /health returns 200 { status: 'ok' }", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});

// ─── Runtime API routes (/agents/*) ──────────────────────────────────────────

describe("composed app — /agents/* (runtime API)", () => {
  it("GET /agents/:id/config without Bearer returns 401", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/config`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("GET /agents/:id/config with wrong Bearer returns 401", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/config`, {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /agents/:id/config with valid Bearer returns 200", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/config`, {
      headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.env).toBeDefined();
    expect(body.allowedTools).toBeDefined();
    expect(body.plugins).toBeDefined();
  });
});

// ─── Admin UI routes (/admin/*) ───────────────────────────────────────────────

describe("composed app — /admin/* (admin UI)", () => {
  it("GET /admin/login returns 200 with HTML login form", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request("/admin/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<form");
    expect(html).toContain('type="password"');
  });

  it("GET /admin/agents without session cookie redirects to /admin/login", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request("/admin/agents");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });
});

// ─── Admin API routes (/admin/api/*) ─────────────────────────────────────────

describe("composed app — /admin/api/* (admin API)", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("GET /admin/api/agents/:id/envs without session returns 401", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`);
    expect(res.status).toBe(401);
  });

  it("GET /admin/api/agents/:id/envs with valid session returns 200", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.env).toBeDefined();
  });
});

// ─── Mount order: /admin/api/* must not be shadowed by /admin/* ───────────────

describe("composed app — mount order (no shadowing)", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("/admin/api/* JSON routes are not shadowed by /admin/* HTML routes", async () => {
    const app = createComposedApp(makeMockDeps());

    // The admin API returns JSON, not HTML — confirms it is not caught by admin-ui
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
  });
});
