/**
 * agent/src/agents-api.smoke.test.ts
 * Smoke tests for the admin CRUD API (admin/src/agents-api.ts).
 *
 * Uses app.request() — no real server, no real DB.
 * Services are injected as in-memory mocks.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import type { AgentProvisioner, ProvisionResult } from "./agent-provisioner.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import { createAdminApp, parseAdminApiKeys } from "./agents-api.ts";
import type { AdminDeps } from "./agents-api.ts";

// ─── Recording fake provisioner ───────────────────────────────────────────────

/**
 * In-memory AgentProvisioner double that records every provision/deprovision
 * call. Injected via deps — no mock.module, no global overrides.
 */
class RecordingProvisioner implements AgentProvisioner {
  readonly provisioned: string[] = [];
  readonly deprovisioned: string[] = [];
  reconcileResult: { recreated: string[]; orphans: string[]; failed: Array<{ agentId: string; error: string }> } = {
    recreated: [],
    orphans: [],
    failed: [],
  };

  constructor(private readonly onProvision?: (agentId: string) => void) {}

  async provision(agentId: string): Promise<ProvisionResult> {
    this.onProvision?.(agentId);
    this.provisioned.push(agentId);
    return {
      resourceName: agentId,
      secretName: `${agentId}-token`,
      deploymentName: agentId,
    };
  }

  async deprovision(agentId: string): Promise<void> {
    this.deprovisioned.push(agentId);
  }

  async reconcile(
    _agentIds: string[],
  ): Promise<{ recreated: string[]; orphans: string[]; failed: Array<{ agentId: string; error: string }> }> {
    return this.reconcileResult;
  }
}

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
      get: async (_agentId, _cronId) => ({
        id: CRON_ID,
        agentId: AGENT_ID,
        schedule: "0 9 * * 1-5",
        prompt: "daily standup",
        channel: "C123",
        user: null,
        silent: false,
        enabled: false,
        preCheck: "shipwright:check-dev-task.ts",
        name: null,
        system: false,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      }),
      setEnabled: async (_agentId, _cronId, enabled) => ({
        id: CRON_ID,
        agentId: AGENT_ID,
        schedule: "0 9 * * 1-5",
        prompt: "daily standup",
        channel: "C123",
        user: null,
        silent: false,
        enabled,
        preCheck: null,
        name: null,
        system: false,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      }),
      updatePreCheck: async (_agentId, _cronId, preCheck) => ({
        id: CRON_ID,
        agentId: AGENT_ID,
        schedule: "0 9 * * 1-5",
        prompt: "daily standup",
        channel: "C123",
        user: null,
        silent: false,
        enabled: true,
        preCheck,
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
          name: "shipwright@shipwright",
          version: "1.0.0",
          enabled: true,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ],
      add: async () => ({
        id: PLUGIN_ID,
        agentId: AGENT_ID,
        name: "shipwright@shipwright",
        version: "1.0.0",
        enabled: true,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      }),
      remove: async () => {},
      removeByName: async () => {},
    },
    prisma: {
      agent: {
        create: async (args: {
          data: { name: string; slackId: string | null };
        }) => ({
          id: "agent-new-id",
          name: args.data.name,
          slackId: args.data.slackId,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        }),
        findUnique: async (args: { where: { id: string } }) =>
          args.where.id === AGENT_ID
            ? { id: AGENT_ID, name: "Existing Agent" }
            : null,
        findMany: async () => [{ id: AGENT_ID }, { id: "agent-other-id" }],
        delete: async (args: { where: { id: string } }) => ({
          id: args.where.id,
          name: "Existing Agent",
          slackId: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        }),
      },
    } as unknown as AdminDeps["prisma"],
    provisioner: new RecordingProvisioner(),
    sessionSecret: SESSION_SECRET,
  };
}

// ─── Auth smoke tests ──────────────────────────────────────────────────────────

describe("admin API — auth", () => {
  it("unauthenticated GET /agents/:id/envs returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/envs`);
    expect(res.status).toBe(401);
  });

  it("unauthenticated POST /agents/:id/envs returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      method: "POST",
      body: JSON.stringify({ FOO: "bar" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("unauthenticated DELETE /agents/:id/crons/:cronId returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/crons/${CRON_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("unauthenticated GET /agents/:id/tools returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/tools`);
    expect(res.status).toBe(401);
  });

  it("unauthenticated GET /agents/:id/tokens returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/tokens`);
    expect(res.status).toBe(401);
  });

  it("unauthenticated GET /agents/:id/plugins returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/plugins`);
    expect(res.status).toBe(401);
  });

  it("invalid JWT session cookie returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Cookie: "admin_session=not.a.valid.jwt" },
    });
    expect(res.status).toBe(401);
  });

  it("session cookie signed with wrong secret returns 401", async () => {
    const wrongCookie = await makeSessionCookie(
      "wrong-secret-32-bytes-exactly!!!",
    );
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
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

  it("POST /agents/:id/envs with valid body returns 201", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      method: "POST",
      body: JSON.stringify({ FOO: "bar", BAZ: "qux" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);
  });

  it("GET /agents/:id/envs returns decrypted env vars", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.env).toBeDefined();
    expect(body.env.FOO).toBe("bar");
    expect(body.env.SECRET).toBe("decrypted-value");
  });

  it("PATCH /agents/:id/envs updates specific keys (200)", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      method: "PATCH",
      body: JSON.stringify({ FOO: "updated" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
  });

  it("DELETE /agents/:id/envs/:key returns 204", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/envs/FOO`, {
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

  it("POST /agents/:id/crons creates a cron job (201)", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/crons`, {
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

  it("PATCH /agents/:id/crons/:cronId updates content and returns 200", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/crons/${CRON_ID}`, {
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
    });
    expect(res.status).toBe(200);
  });

  it("PATCH /agents/:id/crons/:cronId with enabled-only toggles and returns 200", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/crons/${CRON_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cron.enabled).toBe(false);
  });

  it("PATCH /agents/:id/crons/:cronId with content+enabled updates both and returns 200", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/crons/${CRON_ID}`, {
      method: "PATCH",
      body: JSON.stringify({
        schedule: "0 10 * * 1-5",
        prompt: "updated standup",
        channel: "C123",
        enabled: false,
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
  });

  it("PATCH /agents/:id/crons/:cronId with preCheck-only sets preCheck and returns 200", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/crons/${CRON_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ preCheck: "shipwright:check-review.ts" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cron.preCheck).toBe("shipwright:check-review.ts");
  });

  it("PATCH /agents/:id/crons/:cronId with preCheck null clears preCheck and returns 200", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/crons/${CRON_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ preCheck: null }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cron.preCheck).toBeNull();
  });

  it("PATCH /agents/:id/crons/:cronId with preCheck+enabled updates both and returns 200", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/crons/${CRON_ID}`, {
      method: "PATCH",
      body: JSON.stringify({
        preCheck: "shipwright:check-dev-task.ts",
        enabled: false,
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Response must come from get() so both writes are reflected
    expect(body.cron.preCheck).toBe("shipwright:check-dev-task.ts");
    expect(body.cron.enabled).toBe(false);
  });

  it("PATCH /agents/:id/crons/:cronId with only schedule returns 400", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/crons/${CRON_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ schedule: "0 10 * * 1-5" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /agents/:id/crons/:cronId with empty body returns 400", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/crons/${CRON_ID}`, {
      method: "PATCH",
      body: JSON.stringify({}),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /agents/:id/crons/:cronId returns 204", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/crons/${CRON_ID}`, {
      method: "DELETE",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(204);
  });

  it("POST /agents/:id/crons/reconcile returns reconciliation summary", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/crons/reconcile`, {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
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

  it("POST /agents/:id/tools creates a tool (201)", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/tools`, {
      method: "POST",
      body: JSON.stringify({ pattern: "Read" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);
  });

  it("GET /agents/:id/tools returns list", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/tools`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tools)).toBe(true);
  });

  it("PATCH /agents/:id/tools/:toolId toggles enabled (200)", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/tools/${TOOL_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
  });

  it("DELETE /agents/:id/tools/:toolId returns 204", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/tools/${TOOL_ID}`, {
      method: "DELETE",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(204);
  });
});

// ─── Token routes ─────────────────────────────────────────────────────────────

describe("admin API — tokens", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /agents/:id/tokens returns 201 with rawToken field", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/tokens`, {
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

  it("GET /agents/:id/tokens returns list WITHOUT rawToken", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/tokens`, {
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

  it("DELETE /agents/:id/tokens/:tokenId returns 204", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/tokens/${TOKEN_ID}`, {
      method: "DELETE",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(204);
  });
});

// ─── Plugin routes ────────────────────────────────────────────────────────────

describe("admin API — plugins", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /agents/:id/plugins adds a plugin (201)", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/plugins`, {
      method: "POST",
      body: JSON.stringify({ name: "shipwright@shipwright", version: "1.0.0" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);
  });

  it("GET /agents/:id/plugins returns list", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/plugins`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.plugins)).toBe(true);
    expect(body.plugins).toHaveLength(1);
  });

  it("PATCH /agents/:id/plugins?name=<name> updates version (200)", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(
      `/agents/${AGENT_ID}/plugins?name=${encodeURIComponent("shipwright@shipwright")}`,
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

  it("PATCH /agents/:id/plugins without name param returns 400", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/plugins`, {
      method: "PATCH",
      body: JSON.stringify({ version: "2.0.0" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /agents/:id/plugins?name=<name> returns 204", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(
      `/agents/${AGENT_ID}/plugins?name=${encodeURIComponent("shipwright@shipwright")}`,
      {
        method: "DELETE",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(204);
  });

  it("DELETE /agents/:id/plugins without name param returns 400", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/plugins`, {
      method: "DELETE",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(400);
  });
});

// ─── Create agent smoke tests ─────────────────────────────────────────────────

const ADMIN_API_KEY = "admin-key-for-create-tests";

describe("admin API — create agent", () => {
  it("POST /admin/api/agents with admin bearer → 201 with agent object + provisions", async () => {
    const provisioner = new RecordingProvisioner();
    const deps: AdminDeps = {
      ...makeMockDeps(),
      provisioner,
      adminApiKeys: parseAdminApiKeys(`admin:${ADMIN_API_KEY}:*`),
    };
    const app = createAdminApp(deps);
    const res = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Test Agent", slackId: "U123456" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_API_KEY}`,
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: "agent-new-id", name: "Test Agent" });
    // Provisioner invoked with the newly-created agent id.
    expect(provisioner.provisioned).toEqual(["agent-new-id"]);
  });

  it("POST /admin/api/agents with the Noop provisioner still returns 201 (default path)", async () => {
    // The default makeMockDeps wires a recording provisioner; here we assert the
    // contract that a never-throwing provisioner preserves today's 201 behavior.
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Noop Agent" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: "agent-new-id", name: "Noop Agent" });
  });

  it("POST /admin/api/agents rolls back the agent row and 500s when provision throws", async () => {
    const cookie = await makeSessionCookie();
    const deleted: string[] = [];
    const provisioner = new RecordingProvisioner(() => {
      throw new Error("cluster unavailable");
    });
    const base = makeMockDeps();
    const deps: AdminDeps = {
      ...base,
      provisioner,
      prisma: {
        agent: {
          create: async (args: {
            data: { name: string; slackId: string | null };
          }) => ({
            id: "agent-new-id",
            name: args.data.name,
            slackId: args.data.slackId,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          }),
          delete: async (args: { where: { id: string } }) => {
            deleted.push(args.where.id);
            return {
              id: args.where.id,
              name: "rolled-back",
              slackId: null,
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            };
          },
        },
      } as unknown as AdminDeps["prisma"],
    };
    const app = createAdminApp(deps);
    const res = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Doomed Agent" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(500);
    // The half-created agent row was rolled back.
    expect(deleted).toEqual(["agent-new-id"]);
  });

  it("POST /admin/api/agents with per-agent bearer → 403", async () => {
    const deps = makeDepsWithTokenValidation(async () => ({
      agentId: AGENT_ID,
    }));
    const app = createAdminApp(deps);
    const res = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Test Agent" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VALID_BEARER_TOKEN}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("POST /admin/api/agents with valid session cookie → 201", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Cookie Agent" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: "agent-new-id", name: "Cookie Agent" });
  });

  it("POST /admin/api/agents missing name → 400", async () => {
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeMockDeps());
    const res = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ slackId: "U999" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(400);
  });
});

// ─── Delete agent smoke tests ─────────────────────────────────────────────────

describe("admin API — delete agent", () => {
  it("DELETE /agents/:id with session cookie → 204 + deprovisions", async () => {
    const cookie = await makeSessionCookie();
    const provisioner = new RecordingProvisioner();
    const deps: AdminDeps = { ...makeMockDeps(), provisioner };
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}`, {
      method: "DELETE",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(204);
    expect(provisioner.deprovisioned).toEqual([AGENT_ID]);
  });

  it("DELETE /agents/:id with admin bearer → 204", async () => {
    const provisioner = new RecordingProvisioner();
    const deps: AdminDeps = {
      ...makeMockDeps(),
      provisioner,
      adminApiKeys: parseAdminApiKeys(`admin:${ADMIN_API_KEY}:*`),
    };
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
    });
    expect(res.status).toBe(204);
    expect(provisioner.deprovisioned).toEqual([AGENT_ID]);
  });

  it("DELETE /agents/:id returns 500 and preserves the row when deprovision throws", async () => {
    const cookie = await makeSessionCookie();
    const deleted: string[] = [];
    // Provisioner whose deprovision() rejects with a non-NotFound error. The
    // throw must propagate (→ 500) BEFORE the agent row is deleted, leaving the
    // row intact so the delete is retry-safe.
    const provisioner: AgentProvisioner = {
      async provision(agentId: string): Promise<ProvisionResult> {
        return {
          resourceName: agentId,
          secretName: `${agentId}-token`,
          deploymentName: agentId,
        };
      },
      async deprovision(): Promise<void> {
        throw new Error("k8s API timeout");
      },
      async reconcile() {
        return { recreated: [], orphans: [], failed: [] };
      },
    };
    const base = makeMockDeps();
    const deps: AdminDeps = {
      ...base,
      provisioner,
      prisma: {
        agent: {
          findUnique: async (args: { where: { id: string } }) =>
            args.where.id === AGENT_ID
              ? { id: AGENT_ID, name: "Existing Agent" }
              : null,
          delete: async (args: { where: { id: string } }) => {
            deleted.push(args.where.id);
            return {
              id: args.where.id,
              name: "Existing Agent",
              slackId: null,
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            };
          },
        },
      } as unknown as AdminDeps["prisma"],
    };
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}`, {
      method: "DELETE",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(500);
    // The deprovision error surfaced before the row was deleted — row preserved.
    expect(deleted).toEqual([]);
  });

  it("DELETE /agents/:id unknown id → 404 (no deprovision)", async () => {
    const cookie = await makeSessionCookie();
    const provisioner = new RecordingProvisioner();
    const deps: AdminDeps = { ...makeMockDeps(), provisioner };
    const app = createAdminApp(deps);
    const res = await app.request("/agents/does-not-exist", {
      method: "DELETE",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(404);
    expect(provisioner.deprovisioned).toEqual([]);
  });

  it("DELETE /agents/:id without auth → 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("DELETE /agents/:id with per-agent bearer → 403", async () => {
    const provisioner = new RecordingProvisioner();
    const deps: AdminDeps = {
      ...makeDepsWithTokenValidation(async () => ({ agentId: AGENT_ID })),
      provisioner,
    };
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${VALID_BEARER_TOKEN}` },
    });
    expect(res.status).toBe(403);
    expect(provisioner.deprovisioned).toEqual([]);
  });
});

// ─── Reconcile route smoke tests ─────────────────────────────────────────────

describe("admin API — POST /agents/reconcile", () => {
  it("POST /agents/reconcile without auth → 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request("/agents/reconcile", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("POST /agents/reconcile with per-agent bearer → 403", async () => {
    const deps = makeDepsWithTokenValidation(async () => ({
      agentId: AGENT_ID,
    }));
    const app = createAdminApp(deps);
    const res = await app.request("/agents/reconcile", {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_BEARER_TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it("POST /agents/reconcile with admin session → calls reconcile and returns { recreated, orphans }", async () => {
    const cookie = await makeSessionCookie();
    const provisioner = new RecordingProvisioner();
    provisioner.reconcileResult = {
      recreated: ["agent-abc"],
      orphans: ["agent-orphan"],
      failed: [],
    };
    const deps: AdminDeps = { ...makeMockDeps(), provisioner };
    const app = createAdminApp(deps);
    const res = await app.request("/agents/reconcile", {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      recreated: ["agent-abc"],
      orphans: ["agent-orphan"],
    });
  });

  it("POST /agents/reconcile with admin bearer → 200", async () => {
    const provisioner = new RecordingProvisioner();
    const deps: AdminDeps = {
      ...makeMockDeps(),
      provisioner,
      adminApiKeys: parseAdminApiKeys(`admin:${ADMIN_API_KEY}:*`),
    };
    const app = createAdminApp(deps);
    const res = await app.request("/agents/reconcile", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("recreated");
    expect(body).toHaveProperty("orphans");
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
  it("GET /agents/:id/envs accepts a valid bearer token (200)", async () => {
    const deps = makeDepsWithTokenValidation(async () => ({
      agentId: AGENT_ID,
    }));
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Authorization: `Bearer ${VALID_BEARER_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("GET /agents/:id/tools accepts a valid bearer token (200)", async () => {
    const deps = makeDepsWithTokenValidation(async () => ({
      agentId: AGENT_ID,
    }));
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}/tools`, {
      headers: { Authorization: `Bearer ${VALID_BEARER_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 when bearer token is invalid (validate returns null)", async () => {
    const deps = makeDepsWithTokenValidation(async () => null);
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(401);
  });

  it("does NOT fall through to cookie when Authorization header is present but invalid", async () => {
    // Valid session cookie present, but invalid bearer → should still 401
    const cookie = await makeSessionCookie();
    const deps = makeDepsWithTokenValidation(async () => null);
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
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
    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
  });
});
