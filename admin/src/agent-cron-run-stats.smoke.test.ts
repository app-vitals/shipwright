/**
 * admin/src/agent-cron-run-stats.smoke.test.ts
 * Smoke tests for GET /agents/all/cron-runs/stats.
 *
 * Uses app.request() — no real server, no real DB.
 * AgentCronRunStatsService is injected as an in-memory mock.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import type { AgentCronRunStatsService } from "./agent-cron-run-stats.ts";
import { createAdminApp, parseAdminApiKeys } from "./agents-api.ts";
import type { AdminDeps } from "./agents-api.ts";

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const AGENT_ID = "agent-test-123";
const ADMIN_API_KEY = "admin-stats-key-for-tests";
const VALID_BEARER_TOKEN = "valid-bearer-token-value";

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

// Minimal mock stats response matching CronRunTokenStats shape
const MOCK_STATS = {
  totals: {
    input: 600,
    output: 300,
    cacheRead: 60,
    cacheCreation: 30,
    total: 990,
    costUsd: 0.006,
  },
  byAgent: [
    {
      key: "agent-1",
      input: 400,
      output: 200,
      cacheRead: 40,
      cacheCreation: 20,
      total: 660,
      costUsd: 0.004,
    },
    {
      key: "agent-2",
      input: 200,
      output: 100,
      cacheRead: 20,
      cacheCreation: 10,
      total: 330,
      costUsd: 0.002,
    },
  ],
  byCron: [
    {
      key1: "agent-1",
      key2: "cron-alpha",
      input: 400,
      output: 200,
      cacheRead: 40,
      cacheCreation: 20,
      total: 660,
      costUsd: 0.004,
    },
    {
      key1: "agent-2",
      key2: "cron-beta",
      input: 200,
      output: 100,
      cacheRead: 20,
      cacheCreation: 10,
      total: 330,
      costUsd: 0.002,
    },
  ],
  byModel: [
    {
      key1: "agent-1",
      key2: "claude-sonnet-4-5",
      input: 400,
      output: 200,
      cacheRead: 40,
      cacheCreation: 20,
      total: 660,
      costUsd: 0.004,
    },
    {
      key1: "agent-2",
      key2: "claude-opus-4-5",
      input: 200,
      output: 100,
      cacheRead: 20,
      cacheCreation: 10,
      total: 330,
      costUsd: 0.002,
    },
  ],
  daily: [
    {
      period: "2026-01-10",
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheCreation: 5,
      total: 165,
      costUsd: 0.001,
    },
    {
      period: "2026-01-11",
      input: 200,
      output: 100,
      cacheRead: 20,
      cacheCreation: 10,
      total: 330,
      costUsd: 0.002,
    },
    {
      period: "2026-01-12",
      input: 300,
      output: 150,
      cacheRead: 30,
      cacheCreation: 15,
      total: 495,
      costUsd: 0.003,
    },
  ],
  byCronModel: [],
};

function makeMockStatsService(): Pick<AgentCronRunStatsService, "query"> {
  return {
    query: async (_from?: string, _to?: string) => MOCK_STATS,
  };
}

function makeMockDeps(): AdminDeps {
  return {
    agentEnvService: {
      upsert: async () => {},
      patch: async () => {},
      getByAgentId: async () => ({ env: {}, secretKeys: [] }),
      deleteKey: async () => {},
    },
    agentCronJobService: {
      list: async () => [],
      listWithRunSummary: async () => [],
      create: async () => ({
        id: "cron-id",
        agentId: AGENT_ID,
        schedule: "0 9 * * *",
        prompt: "test",
        channel: null,
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
        id: "cron-id",
        agentId: AGENT_ID,
        schedule: "0 9 * * *",
        prompt: "test",
        channel: null,
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
        id: "cron-id",
        agentId: AGENT_ID,
        schedule: "0 9 * * *",
        prompt: "test",
        channel: null,
        user: null,
        silent: false,
        enabled: true,
        preCheck: null,
        name: null,
        system: false,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      }),
      setEnabled: async (_agentId, _cronId, enabled) => ({
        id: "cron-id",
        agentId: AGENT_ID,
        schedule: "0 9 * * *",
        prompt: "test",
        channel: null,
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
        id: "cron-id",
        agentId: AGENT_ID,
        schedule: "0 9 * * *",
        prompt: "test",
        channel: null,
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
        created: 0,
        updated: 0,
        deleted: 0,
      }),
    },
    agentToolService: {
      list: async () => [],
      add: async () => ({
        id: "tool-id",
        agentId: AGENT_ID,
        pattern: "Read",
        enabled: true,
        createdAt: new Date(),
      }),
      toggle: async () => ({
        id: "tool-id",
        agentId: AGENT_ID,
        pattern: "Read",
        enabled: false,
        createdAt: new Date(),
      }),
      remove: async () => {},
    },
    agentTokenService: {
      create: async () => ({
        token: {
          id: "token-id",
          agentId: AGENT_ID,
          token: "sha256hash",
          label: null,
          createdAt: new Date(),
          revokedAt: null,
        },
        rawToken:
          "raw-hex-token-64chars-placeholder-pad-pad-pad-pad-pad-pad-pad",
      }),
      listForAgent: async () => [],
      revoke: async () => ({
        id: "token-id",
        agentId: AGENT_ID,
        token: "sha256hash",
        label: null,
        createdAt: new Date(),
        revokedAt: new Date(),
      }),
      validate: async () => null,
    },
    agentPluginService: {
      list: async () => [],
      add: async () => ({
        id: "plugin-id",
        agentId: AGENT_ID,
        name: "test",
        version: "1.0.0",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      remove: async () => {},
      removeByName: async () => {},
    },
    agentChatTokenService: {
      upsertDailyByModel: async (
        agentId: string,
        date: string,
        model: string,
      ) => ({
        id: "daily-id",
        agentId,
        date,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      queryStats: async () => ({
        totals: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreation: 0,
          total: 0,
        },
        byAgent: [],
        byModel: [],
        daily: [],
      }),
    },
    agentCronRunService: {
      create: async () => ({
        id: "run-id",
        cronId: "cron-id",
        agentId: AGENT_ID,
        startedAt: new Date(),
        completedAt: null,
        skipped: false,
        skipReason: null,
        outcome: null,
        error: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
        model: null,
        createdAt: new Date(),
      }),
      list: async () => ({ items: [], total: 0, limit: 20, offset: 0 }),
      patch: async () => ({
        id: "run-id",
        cronId: "cron-id",
        agentId: AGENT_ID,
        startedAt: new Date(),
        completedAt: null,
        skipped: false,
        skipReason: null,
        outcome: null,
        error: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
        model: null,
        createdAt: new Date(),
        modelBreakdown: [],
      }),
    },
    agentCronRunStatsService: makeMockStatsService(),
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
                name: "Test Agent",
                slackId: null,
                selfHosted: false,
                createdAt: new Date(),
                updatedAt: new Date(),
              }
            : null,
        findMany: async () => [],
        delete: async (args: { where: { id: string } }) => ({
          id: args.where.id,
          name: "Test Agent",
          slackId: null,
          selfHosted: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        update: async (args: { where: { id: string }; data: unknown }) => ({
          id: args.where.id,
          name: "Test Agent",
          slackId: null,
          selfHosted: false,
          repos: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    } as unknown as AdminDeps["prisma"],
    provisioner: {
      provision: async (agentId) => ({
        resourceName: agentId,
        secretName: `${agentId}-token`,
        deploymentName: agentId,
      }),
      deprovision: async () => {},
      reconcile: async () => ({
        recreated: [],
        updated: [],
        orphans: [],
        failed: [],
      }),
    },
    sessionSecret: SESSION_SECRET,
  };
}

// ─── Stats route smoke tests ─────────────────────────────────────────────────

describe("admin API — GET /agents/all/cron-runs/stats", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("returns 200 with correct CronRunTokenStats shape (session auth)", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request("/agents/all/cron-runs/stats", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Check all five dimensions are present
    expect(body.totals).toBeDefined();
    expect(body.byAgent).toBeDefined();
    expect(body.byCron).toBeDefined();
    expect(body.byModel).toBeDefined();
    expect(body.daily).toBeDefined();

    // Verify totals shape
    expect(typeof body.totals.input).toBe("number");
    expect(typeof body.totals.output).toBe("number");
    expect(typeof body.totals.cacheRead).toBe("number");
    expect(typeof body.totals.cacheCreation).toBe("number");
    expect(typeof body.totals.total).toBe("number");

    // Verify arrays
    expect(Array.isArray(body.byAgent)).toBe(true);
    expect(Array.isArray(body.byCron)).toBe(true);
    expect(Array.isArray(body.byModel)).toBe(true);
    expect(Array.isArray(body.daily)).toBe(true);

    // Verify keyed shapes
    if (body.byAgent.length > 0) {
      expect(body.byAgent[0].key).toBeDefined();
      expect(typeof body.byAgent[0].input).toBe("number");
    }
    if (body.byCron.length > 0) {
      expect(body.byCron[0].key1).toBeDefined();
      expect(body.byCron[0].key2).toBeDefined();
    }
    if (body.byModel.length > 0) {
      expect(body.byModel[0].key1).toBeDefined();
      expect(body.byModel[0].key2).toBeDefined();
    }
    if (body.daily.length > 0) {
      expect(body.daily[0].period).toBeDefined();
      expect(typeof body.daily[0].input).toBe("number");
    }
  });

  it("returns correct mock data values", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request("/agents/all/cron-runs/stats", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.totals.input).toBe(600);
    expect(body.totals.total).toBe(990);
    expect(body.byAgent).toHaveLength(2);
    expect(body.byCron).toHaveLength(2);
    expect(body.byModel).toHaveLength(2);
    expect(body.daily).toHaveLength(3);
  });

  it("accepts from/to query params without error", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request(
      "/agents/all/cron-runs/stats?from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z",
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
  });

  it("returns 200 with admin bearer token", async () => {
    const deps: AdminDeps = {
      ...makeMockDeps(),
      adminApiKeys: parseAdminApiKeys(`admin:${ADMIN_API_KEY}:*`),
    };
    const app = createAdminApp(deps);
    const res = await app.request("/agents/all/cron-runs/stats", {
      headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
    });
    expect(res.status).toBe(200);
  });

  it("unauthenticated request returns 401", async () => {
    const app = createAdminApp(makeMockDeps());
    const res = await app.request("/agents/all/cron-runs/stats");
    expect(res.status).toBe(401);
  });

  it("agent-scoped bearer token returns 403", async () => {
    const deps: AdminDeps = {
      ...makeMockDeps(),
      agentTokenService: {
        ...makeMockDeps().agentTokenService,
        // Returns a per-agent token (not admin)
        validate: async () => ({ agentId: AGENT_ID }),
      },
    };
    const app = createAdminApp(deps);
    const res = await app.request("/agents/all/cron-runs/stats", {
      headers: { Authorization: `Bearer ${VALID_BEARER_TOKEN}` },
    });
    expect(res.status).toBe(403);
  });
});
