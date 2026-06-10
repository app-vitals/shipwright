/**
 * agent/src/admin-api.smoke.test.ts
 * Smoke tests for the admin CRUD API (admin/src/admin-api.ts).
 *
 * Uses app.request() — no real server, no real DB.
 * Services are injected as in-memory mocks.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import { createAdminApp } from "./admin-api.ts";
import type { AdminDeps } from "./admin-api.ts";
import type { AgentTokenService } from "./agent-tokens.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const AGENT_ID = "agent-test-123";
const CRON_ID = "cron-test-456";
const TOKEN_ID = "token-test-789";
const TOOL_ID = "tool-test-abc";
const PLUGIN_ID = "plugin-test-def";

// ─── JWT helper ───────────────────────────────────────────────────────────────

async function makeSessionCookie(secret = SESSION_SECRET): Promise<string> {
  return sign(
    {
      userId: "user-123",
      email: "admin@example.com",
      name: "Admin User",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    "HS256",
  );
}

// ─── Mock services ────────────────────────────────────────────────────────────

function makeMockDeps(): AdminDeps {
  return {
    agentEnvService: {
      upsert: async () => {},
      patch: async () => {},
      getByAgentId: async () => ({ FOO: "bar", SECRET: "decrypted-value" }),
      deleteKey: async () => {},
    },
    agentCronJobService: {
      list: async () => [
        {
          id: CRON_ID,
          agentId: AGENT_ID,
          schedule: "0 9 * * 1-5",
          prompt: "daily standup",
          channel: "C123",
          user: null,
          silent: false,
          enabled: true,
          preCheck: null,
          name: null,
          system: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ],
      create: async () => ({
        id: CRON_ID,
        agentId: AGENT_ID,
        schedule: "0 9 * * 1-5",
        prompt: "daily standup",
        channel: "C123",
        user: null,
        silent: false,
        enabled: true,
        preCheck: null,
        name: null,
        system: false,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      }),
      update: async () => ({
        id: CRON_ID,
        agentId: AGENT_ID,
        schedule: "0 10 * * 1-5",
        prompt: "updated standup",
        channel: "C123",
        user: null,
        silent: false,
        enabled: true,
        preCheck: null,
        name: null,
        system: false,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      }),
      delete: async () => {},
      get: async () => ({
        id: CRON_ID,
        agentId: AGENT_ID,
        schedule: "0 9 * * 1-5",
        prompt: "daily standup",
        channel: "C123",
        user: null,
        silent: false,
        enabled: true,
        preCheck: null,
        name: null,
        system: false,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      }),
      reconcileSystemCrons: async () => ({
        created: 2,
        updated: 0,
        deleted: 0,
      }),
    },
    agentToolService: {
      list: async () => [
        {
          id: TOOL_ID,
          agentId: AGENT_ID,
          pattern: "Read",
          enabled: true,
          createdAt: new Date("2024-01-01"),
        },
      ],
      add: async () => ({
        id: TOOL_ID,
        agentId: AGENT_ID,
        pattern: "Read",
        enabled: true,
        createdAt: new Date("2024-01-01"),
      }),
      toggle: async () => ({
        id: TOOL_ID,
        agentId: AGENT_ID,
        pattern: "Read",
        enabled: false,
        createdAt: new Date("2024-01-01"),
      }),
      remove: async () => {},
    },
    agentTokenService: {
      create: async () => ({
        token: {
          id: TOKEN_ID,
          agentId: AGENT_ID,
          token: "sha256hash",
          label: "test token",
          createdAt: new Date("2024-01-01"),
          revokedAt: null,
        },
        rawToken:
          "raw-hex-token-64chars-placeholder-pad-pad-pad-pad-pad-pad-pad",
      }),
      listForAgent: async () => [
        {
          id: TOKEN_ID,
          agentId: AGENT_ID,
          token: "sha256hashvalue",
          label: "test token",
          createdAt: new Date("2024-01-01"),
          revokedAt: null,
        },
      ],
      revoke: async () => ({
        id: TOKEN_ID,
        agentId: AGENT_ID,
        token: "sha256hashvalue",
        label: "test token",
        createdAt: new Date("2024-01-01"),
        revokedAt: new Date("2024-01-02"),
      }),
      validate: async () => ({ agentId: AGENT_ID }),
    },
    agentPluginService: {
      list: async () => [
        {
          id: PLUGIN_ID,
          agentId: AGENT_ID,
          name: "@shipwright/plugin",
          version: "1.0.0",
          enabled: true,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ],
      add: async () => ({
        id: PLUGIN_ID,
        agentId: AGENT_ID,
        name: "@shipwright/plugin",
        version: "1.0.0",
        enabled: true,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      }),
      remove: async () => {},
      removeByName: async () => {},
    },
    sessionSecret: SESSION_SECRET,
  };
}

// ─── Auth smoke tests ──────────────────────────────────────────────────────────

describe("admin API — auth", () => {
  it("unauthenticated GET /admin/api/agents/:id/envs returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`);
    expect(res.status).toBe(401);
  });

  it("unauthenticated POST /admin/api/agents/:id/envs returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      method: "POST",
      body: JSON.stringify({ FOO: "bar" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("unauthenticated GET /admin/api/agents/:id/crons returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/crons`);
    expect(res.status).toBe(401);
  });

  it("unauthenticated DELETE /admin/api/agents/:id/crons/:cronId returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(
      `/admin/api/agents/${AGENT_ID}/crons/${CRON_ID}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(401);
  });

  it("unauthenticated GET /admin/api/agents/:id/tools returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/tools`);
    expect(res.status).toBe(401);
  });

  it("unauthenticated GET /admin/api/agents/:id/tokens returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/tokens`);
    expect(res.status).toBe(401);
  });

  it("unauthenticated GET /admin/api/agents/:id/plugins returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/plugins`);
    expect(res.status).toBe(401);
  });

  it("invalid JWT session cookie returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      headers: { Cookie: "admin_session=not.a.valid.jwt" },
    });
    expect(res.status).toBe(401);
  });

  it("session cookie signed with wrong secret returns 401", async () => {
    const wrongCookie = await makeSessionCookie(
      "wrong-secret-32-bytes-exactly!!!",
    );
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      headers: { Cookie: `admin_session=${wrongCookie}` },
    });
    expect(res.status).toBe(401);
  });
});

// ─── Env vars routes ──────────────────────────────────────────────────────────

describe("admin API — env vars", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/api/agents/:id/envs with valid body returns 201", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      method: "POST",
      body: JSON.stringify({ FOO: "bar", BAZ: "qux" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);
  });

  it("GET /admin/api/agents/:id/envs returns decrypted env vars", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.env).toBeDefined();
    expect(body.env.FOO).toBe("bar");
    expect(body.env.SECRET).toBe("decrypted-value");
  });

  it("PATCH /admin/api/agents/:id/envs updates specific keys (200)", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      method: "PATCH",
      body: JSON.stringify({ FOO: "updated" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
  });

  it("DELETE /admin/api/agents/:id/envs/:key returns 204", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs/FOO`, {
      method: "DELETE",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(204);
  });
});

// ─── Cron job routes ──────────────────────────────────────────────────────────

describe("admin API — cron jobs", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/api/agents/:id/crons creates a cron job (201)", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/crons`, {
      method: "POST",
      body: JSON.stringify({
        schedule: "0 9 * * 1-5",
        prompt: "daily standup",
        channel: "C123",
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);
  });

  it("GET /admin/api/agents/:id/crons returns list", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/crons`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.crons)).toBe(true);
    expect(body.crons).toHaveLength(1);
  });

  it("PATCH /admin/api/agents/:id/crons/:cronId updates and returns 200", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(
      `/admin/api/agents/${AGENT_ID}/crons/${CRON_ID}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          schedule: "0 10 * * 1-5",
          prompt: "updated standup",
          channel: "C123",
        }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(200);
  });

  it("DELETE /admin/api/agents/:id/crons/:cronId returns 204", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(
      `/admin/api/agents/${AGENT_ID}/crons/${CRON_ID}`,
      {
        method: "DELETE",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(204);
  });

  it("POST /admin/api/agents/:id/crons/reconcile returns reconciliation summary", async () => {
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
});

// ─── Tool routes ──────────────────────────────────────────────────────────────

describe("admin API — tools", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/api/agents/:id/tools creates a tool (201)", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/tools`, {
      method: "POST",
      body: JSON.stringify({ pattern: "Read" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);
  });

  it("GET /admin/api/agents/:id/tools returns list", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/tools`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tools)).toBe(true);
  });

  it("PATCH /admin/api/agents/:id/tools/:toolId toggles enabled (200)", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(
      `/admin/api/agents/${AGENT_ID}/tools/${TOOL_ID}`,
      {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(200);
  });

  it("DELETE /admin/api/agents/:id/tools/:toolId returns 204", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(
      `/admin/api/agents/${AGENT_ID}/tools/${TOOL_ID}`,
      {
        method: "DELETE",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(204);
  });
});

// ─── Token routes ─────────────────────────────────────────────────────────────

describe("admin API — tokens", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/api/agents/:id/tokens returns 201 with rawToken field", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/tokens`, {
      method: "POST",
      body: JSON.stringify({ label: "test token" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.rawToken).toBeDefined();
    expect(typeof body.rawToken).toBe("string");
    expect(body.token).toBeDefined();
  });

  it("GET /admin/api/agents/:id/tokens returns list WITHOUT rawToken", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/tokens`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tokens)).toBe(true);
    // Each token should not expose rawToken
    for (const t of body.tokens) {
      expect(t.rawToken).toBeUndefined();
    }
  });

  it("DELETE /admin/api/agents/:id/tokens/:tokenId returns 204", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(
      `/admin/api/agents/${AGENT_ID}/tokens/${TOKEN_ID}`,
      {
        method: "DELETE",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(204);
  });
});

// ─── Plugin routes ────────────────────────────────────────────────────────────

describe("admin API — plugins", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/api/agents/:id/plugins adds a plugin (201)", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/plugins`, {
      method: "POST",
      body: JSON.stringify({ name: "@shipwright/plugin", version: "1.0.0" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);
  });

  it("GET /admin/api/agents/:id/plugins returns list", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/plugins`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.plugins)).toBe(true);
    expect(body.plugins).toHaveLength(1);
  });

  it("PATCH /admin/api/agents/:id/plugins?name=<name> updates version (200)", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(
      `/admin/api/agents/${AGENT_ID}/plugins?name=${encodeURIComponent("@shipwright/plugin")}`,
      {
        method: "PATCH",
        body: JSON.stringify({ version: "2.0.0" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(200);
  });

  it("PATCH /admin/api/agents/:id/plugins without name param returns 400", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/plugins`, {
      method: "PATCH",
      body: JSON.stringify({ version: "2.0.0" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /admin/api/agents/:id/plugins?name=<name> returns 204", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(
      `/admin/api/agents/${AGENT_ID}/plugins?name=${encodeURIComponent("@shipwright/plugin")}`,
      {
        method: "DELETE",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(204);
  });

  it("DELETE /admin/api/agents/:id/plugins without name param returns 400", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/plugins`, {
      method: "DELETE",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(400);
  });
});

// ─── Bearer token auth smoke tests ───────────────────────────────────────────

const VALID_BEARER_TOKEN = "valid-bearer-token-value";

function makeDepsWithTokenValidation(
  validateFn: AgentTokenService["validate"],
): AdminDeps {
  return {
    ...makeMockDeps(),
    agentTokenService: {
      ...makeMockDeps().agentTokenService,
      validate: validateFn,
    },
  };
}

describe("admin API — bearer token auth", () => {
  it("GET /admin/api/agents/:id/envs accepts a valid bearer token (200)", async () => {
    const deps = makeDepsWithTokenValidation(async () => ({ agentId: AGENT_ID }));
    const app = createAdminApp(deps);
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      headers: { Authorization: `Bearer ${VALID_BEARER_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("GET /admin/api/agents/:id/crons accepts a valid bearer token (200)", async () => {
    const deps = makeDepsWithTokenValidation(async () => ({ agentId: AGENT_ID }));
    const app = createAdminApp(deps);
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/crons`, {
      headers: { Authorization: `Bearer ${VALID_BEARER_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 when bearer token is invalid (validate returns null)", async () => {
    const deps = makeDepsWithTokenValidation(async () => null);
    const app = createAdminApp(deps);
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(401);
  });

  it("does NOT fall through to cookie when Authorization header is present but invalid", async () => {
    // Valid session cookie present, but invalid bearer → should still 401
    const cookie = await makeSessionCookie();
    const deps = makeDepsWithTokenValidation(async () => null);
    const app = createAdminApp(deps);
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      headers: {
        Authorization: "Bearer invalid-token",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(401);
  });

  it("session cookie auth still works after middleware update", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/admin/api/agents/${AGENT_ID}/envs`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
  });
});
