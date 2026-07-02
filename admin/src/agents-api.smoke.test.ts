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
  reconcileResult: {
    recreated: string[];
    updated: string[];
    orphans: string[];
    failed: Array<{ agentId: string; error: string }>;
  } = {
    recreated: [],
    updated: [],
    orphans: [],
    failed: [],
  };

  constructor(private readonly onProvision?: (agentId: string) => void) {}

  async provision(
    agentId: string,
    _opts?: { slug?: string },
  ): Promise<ProvisionResult> {
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

  async reconcile(_agents: Array<{ id: string; slug?: string }>): Promise<{
    recreated: string[];
    updated: string[];
    orphans: string[];
    failed: Array<{ agentId: string; error: string }>;
  }> {
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
const RUN_ID = "run-test-111";

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

const MOCK_CRON = {
  id: CRON_ID,
  agentId: AGENT_ID,
  schedule: "0 9 * * 1-5",
  prompt: "daily standup",
  channel: "C123" as string | null,
  user: null as string | null,
  silent: false,
  enabled: true,
  preCheck: null as string | null,
  name: null as string | null,
  system: false,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

function makeMockDeps(): AdminDeps {
  return {
    agentEnvService: {
      upsert: async () => {},
      patch: async () => {},
      getByAgentId: async () => ({ FOO: "bar", SECRET: "decrypted-value" }),
      deleteKey: async () => {},
    },
    agentCronJobService: {
      list: async () => [MOCK_CRON],
      listWithRunSummary: async () => [
        {
          ...MOCK_CRON,
          lastRun: null,
          runCountToday: 0,
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
    agentChatTokenService: {
      upsertDailyByModel: async (_agentId: string, date: string, model: string) => ({
        id: "daily-test-id",
        agentId: _agentId,
        date,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      }),
      queryStats: async () => ({
        totals: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
        byAgent: [],
        byModel: [],
        daily: [],
      }),
    },
    prisma: {
      agent: {
        create: async (args: {
          data: { name: string; slackId: string | null; selfHosted?: boolean };
        }) => ({
          id: "agent-new-id",
          name: args.data.name,
          slackId: args.data.slackId,
          selfHosted: args.data.selfHosted ?? false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        }),
        findUnique: async (args: { where: { id: string } }) =>
          args.where.id === AGENT_ID
            ? {
                id: AGENT_ID,
                name: "Existing Agent",
                slackId: null,
                selfHosted: false,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
              }
            : null,
        findMany: async () => [
          { id: AGENT_ID, name: "Existing Agent", selfHosted: false },
          { id: "agent-other-id", name: "Other Agent", selfHosted: false },
        ],
        delete: async (args: { where: { id: string } }) => ({
          id: args.where.id,
          name: "Existing Agent",
          slackId: null,
          selfHosted: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        }),
        update: async (args: {
          where: { id: string };
          data: { selfHosted?: boolean };
          select?: Record<string, boolean>;
        }) => ({
          id: args.where.id,
          name: "Existing Agent",
          slackId: null,
          selfHosted: args.data.selfHosted ?? false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        }),
      },
    } as unknown as AdminDeps["prisma"],
    agentCronRunService: {
      create: async () => ({
        id: RUN_ID,
        cronId: CRON_ID,
        agentId: AGENT_ID,
        startedAt: new Date("2024-01-01T09:00:00.000Z"),
        completedAt: null,
        skipped: false,
        skipReason: null,
        outcome: "success",
        error: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        createdAt: new Date("2024-01-01T09:00:00.000Z"),
      }),
      list: async () => ({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
      }),
      patch: async () => ({
        id: RUN_ID,
        cronId: CRON_ID,
        agentId: AGENT_ID,
        startedAt: new Date("2024-01-01T09:00:00.000Z"),
        completedAt: null,
        skipped: false,
        skipReason: null,
        outcome: null,
        error: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        createdAt: new Date("2024-01-01T09:00:00.000Z"),
      }),
    },
    agentCronRunStatsService: {
      query: async () => ({
        totals: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
        byAgent: [],
        byCron: [],
        byModel: [],
        daily: [],
        byCronModel: [],
      }),
    },
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

  it("POST /agents/:id/tokens returns 201 with rawToken when no body is sent", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/tokens`, {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
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
        return { recreated: [], updated: [], orphans: [], failed: [] };
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

  it("POST /agents/reconcile with admin session → calls reconcile and returns { recreated, updated, orphans }", async () => {
    const cookie = await makeSessionCookie();
    const provisioner = new RecordingProvisioner();
    provisioner.reconcileResult = {
      recreated: ["agent-abc"],
      updated: ["agent-stale"],
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
      updated: ["agent-stale"],
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

// ─── Zod request-body validation ──────────────────────────────────────────────

describe("admin API — Zod validation", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /agents/:id/crons with missing required fields returns 400 from Zod", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/crons`, {
      method: "POST",
      body: JSON.stringify({ prompt: "missing schedule field" }), // schedule is required
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(400);
  });
});

// ─── Provision agent smoke tests ──────────────────────────────────────────────

describe("admin API — provision agent", () => {
  it("POST /agents/:id/provision without auth → 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/provision`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("POST /agents/:id/provision with per-agent bearer → 403 (no provision call)", async () => {
    const provisioner = new RecordingProvisioner();
    const deps: AdminDeps = {
      ...makeDepsWithTokenValidation(async () => ({ agentId: AGENT_ID })),
      provisioner,
    };
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}/provision`, {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_BEARER_TOKEN}` },
    });
    expect(res.status).toBe(403);
    expect(provisioner.provisioned).toEqual([]);
  });

  it("POST /agents/does-not-exist/provision with session cookie → 404 (no provision call)", async () => {
    const cookie = await makeSessionCookie();
    const provisioner = new RecordingProvisioner();
    const deps: AdminDeps = { ...makeMockDeps(), provisioner };
    const app = createAdminApp(deps);
    const res = await app.request("/agents/does-not-exist/provision", {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(404);
    expect(provisioner.provisioned).toEqual([]);
  });

  it("POST /agents/:id/provision with admin bearer → 200 with provision result", async () => {
    const provisioner = new RecordingProvisioner();
    const deps: AdminDeps = {
      ...makeMockDeps(),
      provisioner,
      adminApiKeys: parseAdminApiKeys(`admin:${ADMIN_API_KEY}:*`),
    };
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}/provision`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      resourceName: AGENT_ID,
      secretName: `${AGENT_ID}-token`,
      deploymentName: AGENT_ID,
    });
    expect(provisioner.provisioned).toEqual([AGENT_ID]);
  });

  it("POST /agents/:id/provision on self-hosted agent returns 200 { skipped: true } without calling provisioner", async () => {
    const cookie = await makeSessionCookie();
    const provisioner = new RecordingProvisioner();
    const base = makeMockDeps();
    const deps: AdminDeps = {
      ...base,
      provisioner,
      prisma: {
        agent: {
          ...base.prisma.agent,
          findUnique: async (args: { where: { id: string } }) =>
            args.where.id === AGENT_ID
              ? {
                  id: AGENT_ID,
                  name: "Self-Hosted Agent",
                  selfHosted: true,
                }
              : null,
        },
      } as unknown as AdminDeps["prisma"],
    };
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}/provision`, {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ skipped: true, reason: "self-hosted" });
    expect(provisioner.provisioned).toEqual([]);
  });
});

// ─── selfHosted field smoke tests ─────────────────────────────────────────────

describe("admin API — selfHosted field", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /agents with selfHosted:true stores and returns flag (201)", async () => {
    const base = makeMockDeps();
    const deps: AdminDeps = {
      ...base,
      prisma: {
        agent: {
          ...base.prisma.agent,
          create: async (args: {
            data: { name: string; slackId: string | null; selfHosted: boolean };
          }) => ({
            id: "agent-new-id",
            name: args.data.name,
            slackId: args.data.slackId,
            selfHosted: args.data.selfHosted,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          }),
        },
      } as unknown as AdminDeps["prisma"],
    };
    const app = createAdminApp(deps);
    const res = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Self-Hosted Agent", selfHosted: true }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.selfHosted).toBe(true);
  });

  it("POST /agents without selfHosted defaults to false (201)", async () => {
    const base = makeMockDeps();
    const deps: AdminDeps = {
      ...base,
      prisma: {
        agent: {
          ...base.prisma.agent,
          create: async (args: {
            data: { name: string; slackId: string | null; selfHosted: boolean };
          }) => ({
            id: "agent-new-id",
            name: args.data.name,
            slackId: args.data.slackId,
            selfHosted: args.data.selfHosted ?? false,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          }),
        },
      } as unknown as AdminDeps["prisma"],
    };
    const app = createAdminApp(deps);
    const res = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Regular Agent" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.selfHosted).toBe(false);
  });

  it("GET /agents includes selfHosted in response", async () => {
    const base = makeMockDeps();
    const deps: AdminDeps = {
      ...base,
      prisma: {
        agent: {
          ...base.prisma.agent,
          findMany: async () => [
            { id: AGENT_ID, name: "Existing Agent", selfHosted: false },
            { id: "agent-other-id", name: "Other Agent", selfHosted: true },
          ],
        },
      } as unknown as AdminDeps["prisma"],
    };
    const app = createAdminApp(deps);
    const res = await app.request("/agents", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].selfHosted).toBeDefined();
    expect(typeof body[0].selfHosted).toBe("boolean");
  });

  it("GET /agents/:id returns full agent record with selfHosted", async () => {
    const base = makeMockDeps();
    const deps: AdminDeps = {
      ...base,
      prisma: {
        agent: {
          ...base.prisma.agent,
          findUnique: async (args: { where: { id: string } }) =>
            args.where.id === AGENT_ID
              ? {
                  id: AGENT_ID,
                  name: "Existing Agent",
                  slackId: null,
                  selfHosted: false,
                  createdAt: new Date("2024-01-01"),
                  updatedAt: new Date("2024-01-01"),
                }
              : null,
        },
      } as unknown as AdminDeps["prisma"],
    };
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(AGENT_ID);
    expect(typeof body.selfHosted).toBe("boolean");
  });

  it("GET /agents/:id unknown id → 404", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request("/agents/does-not-exist", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(404);
  });

  it("PATCH /agents/:id with {selfHosted: true} updates flag and returns 200", async () => {
    const base = makeMockDeps();
    const deps: AdminDeps = {
      ...base,
      prisma: {
        agent: {
          ...base.prisma.agent,
          findUnique: async (args: { where: { id: string } }) =>
            args.where.id === AGENT_ID
              ? {
                  id: AGENT_ID,
                  name: "Existing Agent",
                  slackId: null,
                  selfHosted: false,
                  createdAt: new Date("2024-01-01"),
                  updatedAt: new Date("2024-01-01"),
                }
              : null,
          update: async (args: {
            where: { id: string };
            data: { selfHosted?: boolean };
          }) => ({
            id: args.where.id,
            name: "Existing Agent",
            slackId: null,
            selfHosted: args.data.selfHosted ?? false,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          }),
        },
      } as unknown as AdminDeps["prisma"],
    };
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ selfHosted: true }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.selfHosted).toBe(true);
  });

  it("PATCH /agents/:id unknown id → 404", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request("/agents/does-not-exist", {
      method: "PATCH",
      body: JSON.stringify({ selfHosted: true }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(404);
  });

  it("POST /agents/reconcile excludes self-hosted agents and response includes updated field", async () => {
    const provisioner = new RecordingProvisioner();
    provisioner.reconcileResult = {
      recreated: [],
      updated: [],
      orphans: [],
      failed: [],
    };

    // Track which agents are passed to reconcile
    const agentsPassed: Array<{ id: string; slug?: string }> = [];
    const trackingProvisioner: AdminDeps["provisioner"] = {
      async provision(agentId, opts) {
        return provisioner.provision(agentId, opts);
      },
      async deprovision(agentId) {
        return provisioner.deprovision(agentId);
      },
      async reconcile(agents) {
        agentsPassed.push(...agents);
        return provisioner.reconcileResult;
      },
    };

    const base = makeMockDeps();
    const deps: AdminDeps = {
      ...base,
      provisioner: trackingProvisioner,
      prisma: {
        agent: {
          ...base.prisma.agent,
          findMany: async () => [
            { id: AGENT_ID, name: "Regular Agent", selfHosted: false },
            {
              id: "self-hosted-id",
              name: "Self-Hosted Agent",
              selfHosted: true,
            },
          ],
        },
      } as unknown as AdminDeps["prisma"],
    };
    const app = createAdminApp(deps);
    const res = await app.request("/agents/reconcile", {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Response must include updated field
    expect(body).toHaveProperty("updated");
    expect(Array.isArray(body.updated)).toBe(true);
    // Self-hosted agent must NOT be passed to the provisioner
    expect(agentsPassed.map((a) => a.id)).not.toContain("self-hosted-id");
    // Regular agent IS passed
    expect(agentsPassed.map((a) => a.id)).toContain(AGENT_ID);
  });
});

// ─── repos field smoke tests ──────────────────────────────────────────────────

describe("admin API — repos field", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("PATCH /agents/:id with repos: ['my-repo'] returns 400 (missing org)", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ repos: ["my-repo"] }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/org\/repo/i);
  });

  it("PATCH /agents/:id with repos: ['my-org/my-repo'] returns 200", async () => {
    const base = makeMockDeps();
    const deps: AdminDeps = {
      ...base,
      prisma: {
        agent: {
          ...base.prisma.agent,
          findUnique: async (args: { where: { id: string } }) =>
            args.where.id === AGENT_ID
              ? {
                  id: AGENT_ID,
                  name: "Existing Agent",
                  slackId: null,
                  selfHosted: false,
                  repos: [],
                  createdAt: new Date("2024-01-01"),
                  updatedAt: new Date("2024-01-01"),
                }
              : null,
          update: async (args: {
            where: { id: string };
            data: { selfHosted?: boolean; repos?: string[] };
          }) => ({
            id: args.where.id,
            name: "Existing Agent",
            slackId: null,
            selfHosted: args.data.selfHosted ?? false,
            repos: args.data.repos ?? [],
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          }),
        },
      } as unknown as AdminDeps["prisma"],
    };
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ repos: ["my-org/my-repo"] }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repos).toEqual(["my-org/my-repo"]);
  });

  it("PATCH /agents/:id with repos: [] clears repos and returns 200 with repos: []", async () => {
    const base = makeMockDeps();
    const deps: AdminDeps = {
      ...base,
      prisma: {
        agent: {
          ...base.prisma.agent,
          findUnique: async (args: { where: { id: string } }) =>
            args.where.id === AGENT_ID
              ? {
                  id: AGENT_ID,
                  name: "Existing Agent",
                  slackId: null,
                  selfHosted: false,
                  repos: ["my-org/my-repo"],
                  createdAt: new Date("2024-01-01"),
                  updatedAt: new Date("2024-01-01"),
                }
              : null,
          update: async (args: {
            where: { id: string };
            data: { selfHosted?: boolean; repos?: string[] };
          }) => ({
            id: args.where.id,
            name: "Existing Agent",
            slackId: null,
            selfHosted: args.data.selfHosted ?? false,
            repos: args.data.repos ?? [],
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          }),
        },
      } as unknown as AdminDeps["prisma"],
    };
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ repos: [] }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repos).toEqual([]);
  });

  it("GET /agents/:id returns repos field (empty array for existing agents)", async () => {
    const base = makeMockDeps();
    const deps: AdminDeps = {
      ...base,
      prisma: {
        agent: {
          ...base.prisma.agent,
          findUnique: async (args: { where: { id: string } }) =>
            args.where.id === AGENT_ID
              ? {
                  id: AGENT_ID,
                  name: "Existing Agent",
                  slackId: null,
                  selfHosted: false,
                  repos: [],
                  createdAt: new Date("2024-01-01"),
                  updatedAt: new Date("2024-01-01"),
                }
              : null,
        },
      } as unknown as AdminDeps["prisma"],
    };
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.repos)).toBe(true);
    expect(body.repos).toEqual([]);
  });
});

// ─── Cron runs smoke tests ────────────────────────────────────────────────────

describe("admin API — cron runs", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /agents/:id/crons/:cronId/runs returns 201 with run record", async () => {
    const deps = makeMockDepsWithRunService();
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}/crons/${CRON_ID}/runs`, {
      method: "POST",
      body: JSON.stringify({
        startedAt: "2026-01-01T08:00:00.000Z",
        skipped: false,
        outcome: "success",
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.run).toBeDefined();
    expect(body.run.id).toBeDefined();
    expect(body.run.cronId).toBe(CRON_ID);
    expect(body.run.agentId).toBe(AGENT_ID);
  });

  it("POST /agents/:id/crons/:cronId/runs returns 404 for unknown cronId", async () => {
    const deps = makeMockDepsWithRunService({ notFound: true });
    const app = createAdminApp(deps);
    const res = await app.request(
      `/agents/${AGENT_ID}/crons/nonexistent-cron/runs`,
      {
        method: "POST",
        body: JSON.stringify({
          startedAt: "2026-01-01T08:00:00.000Z",
          skipped: false,
        }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("GET /agents/:id/crons/:cronId/runs returns 200 with paginated list", async () => {
    const deps = makeMockDepsWithRunService();
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}/crons/${CRON_ID}/runs`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.limit).toBe("number");
    expect(typeof body.offset).toBe("number");
  });

  it("PATCH /agents/:id/crons/:cronId/runs/:runId returns 200 with updated run including token fields", async () => {
    const deps = makeMockDepsWithRunService();
    const app = createAdminApp(deps);
    const res = await app.request(
      `/agents/${AGENT_ID}/crons/${CRON_ID}/runs/${RUN_ID}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          completedAt: "2026-01-01T08:05:00.000Z",
          outcome: "success",
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 100,
          cacheCreationTokens: 50,
        }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toBeDefined();
    expect(body.run.id).toBe(RUN_ID);
    expect(body.run.inputTokens).toBe(1000);
    expect(body.run.outputTokens).toBe(500);
  });

  it("PATCH /agents/:id/crons/:cronId/runs/:runId returns 404 when ownership check fails", async () => {
    const deps = makeMockDepsWithRunService({ notFound: true });
    const app = createAdminApp(deps);
    const res = await app.request(
      `/agents/${AGENT_ID}/crons/${CRON_ID}/runs/${RUN_ID}`,
      {
        method: "PATCH",
        body: JSON.stringify({ outcome: "success" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("PATCH /agents/:id/crons/:cronId/runs/:runId returns 404 when runId belongs to a different cronId (cross-cron access)", async () => {
    // Run belongs to CRON_ID, but the request URL uses a different cronId (cron-other-999).
    // The service must enforce cronId ownership and throw NotFoundError.
    const CRON_OTHER_ID = "cron-other-999";
    const deps = makeMockDepsWithRunService({ wrongCronId: CRON_OTHER_ID });
    const app = createAdminApp(deps);
    const res = await app.request(
      `/agents/${AGENT_ID}/crons/${CRON_OTHER_ID}/runs/${RUN_ID}`,
      {
        method: "PATCH",
        body: JSON.stringify({ outcome: "success" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    // cronId in URL doesn't match the run's actual cronId — must 404
    expect(res.status).toBe(404);
  });

  it("PATCH /agents/:id/crons/:cronId/runs/:runId with empty body returns 400", async () => {
    const deps = makeMockDepsWithRunService();
    const app = createAdminApp(deps);
    const res = await app.request(
      `/agents/${AGENT_ID}/crons/${CRON_ID}/runs/${RUN_ID}`,
      {
        method: "PATCH",
        body: JSON.stringify({}),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(400);
  });

  it("GET /agents/:id/crons/summary response includes lastRun and runCountToday", async () => {
    const deps = makeMockDepsWithRunSummary();
    const app = createAdminApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}/crons/summary`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.crons)).toBe(true);
    expect(body.crons).toHaveLength(1);
    const cron = body.crons[0];
    expect("lastRun" in cron).toBe(true);
    expect("runCountToday" in cron).toBe(true);
    expect(typeof cron.runCountToday).toBe("number");
  });
});

// ─── Mock factories for run service tests ────────────────────────────────────

function makeMockDepsWithRunService(opts?: {
  notFound?: boolean;
  /** If set, patch() throws NotFoundError when called with this cronId (simulates cross-cron access). */
  wrongCronId?: string;
}): AdminDeps {
  const mockRun = {
    id: RUN_ID,
    cronId: CRON_ID,
    agentId: AGENT_ID,
    startedAt: new Date("2026-01-01T08:00:00.000Z"),
    completedAt: null,
    skipped: false,
    skipReason: null,
    outcome: "success",
    error: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    createdAt: new Date("2026-01-01T08:00:00.000Z"),
  };

  const base = makeMockDeps();
  return {
    ...base,
    agentCronRunService: {
      create: opts?.notFound
        ? async () => {
            throw new (await import("./errors.ts")).NotFoundError(
              "cron not found",
            );
          }
        : async () => mockRun,
      list: async () => ({
        items: [mockRun],
        total: 1,
        limit: 20,
        offset: 0,
      }),
      patch: opts?.notFound
        ? async () => {
            throw new (await import("./errors.ts")).NotFoundError(
              "run not found",
            );
          }
        : opts?.wrongCronId !== undefined
          ? async (_runId: string, _agentId: string, cronId: string) => {
              // Simulate cronId validation: run belongs to CRON_ID; any other cronId → 404
              if (cronId !== CRON_ID) {
                throw new (await import("./errors.ts")).NotFoundError(
                  `cron run ${_runId} not found`,
                );
              }
              return { ...mockRun };
            }
          : async () => ({
              ...mockRun,
              completedAt: new Date("2026-01-01T08:05:00.000Z"),
              outcome: "success",
              inputTokens: 1000,
              outputTokens: 500,
              cacheReadTokens: 100,
              cacheCreationTokens: 50,
            }),
    },
  };
}

function makeMockDepsWithRunSummary(): AdminDeps {
  const base = makeMockDeps();
  return {
    ...base,
    agentCronJobService: {
      ...base.agentCronJobService,
      listWithRunSummary: async () => [
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
          lastRun: {
            startedAt: new Date("2024-01-01T09:00:00.000Z"),
            completedAt: new Date("2024-01-01T09:00:05.000Z"),
            skipped: false,
            outcome: "success",
          },
          runCountToday: 3,
        },
      ],
    },
  };
}
