/**
 * agent/src/admin-api.smoke.test.ts
 * Smoke tests for the Admin API — Hono in-process request calls.
 *
 * No real database or socket needed. Uses mock service deps.
 */

import { describe, it, expect } from "bun:test";
import { sign } from "hono/jwt";
import { createAdminApp } from "./admin-api.ts";
import type { AdminDeps } from "./admin-api.ts";

const SESSION_SECRET = "test-session-secret-at-least-32-chars-long";
const AGENT_ID = "agent-test-id-001";
const CRON_ID = "cron-test-id-001";
const TOOL_ID = "tool-test-id-001";
const TOKEN_ID = "token-test-id-001";
const PLUGIN_NAME = "test-plugin";

async function makeSessionCookie(): Promise<string> {
  return sign(
    { userId: "user-123", email: "test@example.com", exp: Math.floor(Date.now() / 1000) + 3600 },
    SESSION_SECRET,
    "HS256",
  );
}

function makeMockDeps(): AdminDeps {
  const mockCron = {
    id: CRON_ID,
    agentId: AGENT_ID,
    schedule: "0 * * * *",
    prompt: "Hello",
    channel: null,
    user: null,
    silent: false,
    enabled: true,
    preCheck: null,
    name: "test-cron",
    system: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockTool = {
    id: TOOL_ID,
    agentId: AGENT_ID,
    pattern: "Read",
    enabled: true,
    createdAt: new Date(),
  };

  const mockToken = {
    id: TOKEN_ID,
    agentId: AGENT_ID,
    token: "hashed-token",
    label: "test-token",
    createdAt: new Date(),
    revokedAt: null,
  };

  const mockPlugin = {
    id: "plugin-test-id-001",
    agentId: AGENT_ID,
    name: PLUGIN_NAME,
    version: null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    agentEnvService: {
      upsert: async () => {},
      patch: async () => {},
      getByAgentId: async () => ({ KEY: "value" }),
      deleteKey: async () => {},
    },
    agentCronJobService: {
      list: async () => [mockCron],
      create: async () => mockCron,
      update: async () => mockCron,
      delete: async () => {},
      reconcileSystemCrons: async () => ({ created: 2, updated: 0, deleted: 0 }),
    },
    agentToolService: {
      list: async () => [mockTool],
      add: async () => mockTool,
      remove: async () => {},
      toggle: async () => mockTool,
    },
    agentTokenService: {
      create: async () => ({ token: mockToken, rawToken: "raw-token-value" }),
      listForAgent: async () => [mockToken],
      revoke: async () => mockToken,
    },
    agentPluginService: {
      list: async () => [mockPlugin],
      add: async () => mockPlugin,
      remove: async () => {},
      removeByName: async () => {},
    },
    sessionSecret: SESSION_SECRET,
  };
}

describe("Admin API (smoke)", () => {
  // ─── Auth ────────────────────────────────────────────────────────────────────

  it("returns 401 without a session cookie", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`);
    expect(res.status).toBe(401);
  });

  it("returns 401 with an invalid session cookie", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      headers: { Cookie: "admin_session=this-is-not-a-valid-jwt" },
    });
    expect(res.status).toBe(401);
  });

  // ─── Env vars ────────────────────────────────────────────────────────────────

  it("GET /admin/api/agents/:id/envs returns env object", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("env");
  });

  it("POST /admin/api/agents/:id/envs upserts and returns ok", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      method: "POST",
      headers: {
        Cookie: `admin_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ KEY: "value" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("PATCH /admin/api/agents/:id/envs patches and returns ok", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      method: "PATCH",
      headers: {
        Cookie: `admin_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ KEY: "updated" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("DELETE /admin/api/agents/:id/envs/:key returns 204", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs/KEY`, {
      method: "DELETE",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(204);
  });

  // ─── Cron jobs ───────────────────────────────────────────────────────────────

  it("GET /admin/api/agents/:id/crons returns cron list", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/crons`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("crons");
    expect(Array.isArray(body.crons)).toBe(true);
  });

  it("POST /admin/api/agents/:id/crons creates a cron and returns 201", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/crons`, {
      method: "POST",
      headers: {
        Cookie: `admin_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ schedule: "0 * * * *", prompt: "Hello", silent: true }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("cron");
  });

  it("PATCH /admin/api/agents/:id/crons/:cronId updates and returns cron", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/crons/${CRON_ID}`, {
      method: "PATCH",
      headers: {
        Cookie: `admin_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ schedule: "0 9 * * *", prompt: "Updated" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("cron");
  });

  it("DELETE /admin/api/agents/:id/crons/:cronId returns 204", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/crons/${CRON_ID}`, {
      method: "DELETE",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(204);
  });

  it("POST /admin/api/agents/:id/crons/reconcile returns reconciliation summary", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(
      `/admin/api/agents/${AGENT_ID}/crons/reconcile`,
      {
        method: "POST",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      created: expect.any(Number),
      updated: expect.any(Number),
      deleted: expect.any(Number),
    });
  });

  // ─── Tools ───────────────────────────────────────────────────────────────────

  it("GET /admin/api/agents/:id/tools returns tool list", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/tools`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("tools");
  });

  it("POST /admin/api/agents/:id/tools adds a tool and returns 201", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/tools`, {
      method: "POST",
      headers: {
        Cookie: `admin_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pattern: "Read" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("tool");
  });

  it("PATCH /admin/api/agents/:id/tools/:toolId toggles tool", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/tools/${TOOL_ID}`, {
      method: "PATCH",
      headers: {
        Cookie: `admin_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("tool");
  });

  it("DELETE /admin/api/agents/:id/tools/:toolId returns 204", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/tools/${TOOL_ID}`, {
      method: "DELETE",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(204);
  });

  // ─── Tokens ──────────────────────────────────────────────────────────────────

  it("POST /admin/api/agents/:id/tokens creates a token and returns 201", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/tokens`, {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("rawToken");
    expect(body).toHaveProperty("token");
    // Hashed token must not be exposed
    expect(body.token).not.toHaveProperty("token");
  });

  it("GET /admin/api/agents/:id/tokens returns token list without hashes", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/tokens`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("tokens");
    for (const t of body.tokens) {
      expect(t).not.toHaveProperty("token");
    }
  });

  it("DELETE /admin/api/agents/:id/tokens/:tokenId returns 204", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/tokens/${TOKEN_ID}`, {
      method: "DELETE",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(204);
  });

  // ─── Plugins ─────────────────────────────────────────────────────────────────

  it("GET /admin/api/agents/:id/plugins returns plugin list", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/plugins`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("plugins");
  });

  it("POST /admin/api/agents/:id/plugins adds a plugin and returns 201", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/plugins`, {
      method: "POST",
      headers: {
        Cookie: `admin_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: PLUGIN_NAME }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("plugin");
  });

  it("PATCH /admin/api/agents/:id/plugins/:name updates plugin version", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/plugins/${PLUGIN_NAME}`, {
      method: "PATCH",
      headers: {
        Cookie: `admin_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ version: "1.2.3" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("plugin");
  });

  it("DELETE /admin/api/agents/:id/plugins/:name returns 204", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/plugins/${PLUGIN_NAME}`, {
      method: "DELETE",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(204);
  });
});
