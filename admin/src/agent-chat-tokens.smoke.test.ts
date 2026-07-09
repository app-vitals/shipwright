/**
 * admin/src/agent-chat-tokens.smoke.test.ts
 * Smoke tests for POST /agents/:agentId/chat-tokens/daily.
 *
 * Uses app.request() — no real server, no real DB.
 * Services are injected as in-memory mocks.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import type { AgentProvisioner, ProvisionResult } from "./agent-provisioner.ts";
import { createAdminApp } from "./agents-api.ts";
import type { AdminDeps } from "./agents-api.ts";
import { NotFoundError } from "./errors.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const AGENT_ID = "agent-smoke-test-123";
const UNKNOWN_AGENT_ID = "agent-does-not-exist";

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

// ─── Minimal provisioner stub ─────────────────────────────────────────────────

const noopProvisioner: AgentProvisioner = {
  async provision(agentId: string): Promise<ProvisionResult> {
    return {
      resourceName: agentId,
      secretName: `${agentId}-token`,
      deploymentName: agentId,
    };
  },
  async deprovision(): Promise<void> {},
  async reconcile() {
    return { recreated: [], updated: [], orphans: [], failed: [] };
  },
};

// ─── Mock row returned by upsertDailyByModel ──────────────────────────────────

const MOCK_DAILY_ROW = {
  id: "cld_test_001",
  agentId: AGENT_ID,
  date: "2026-01-15",
  model: "claude-sonnet-4-5",
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 10,
  cacheCreationTokens: 5,
  costUsd: 0.0012,
  createdAt: new Date("2026-01-15T00:00:00.000Z"),
  updatedAt: new Date("2026-01-15T12:00:00.000Z"),
};

// ─── Mock stats result ────────────────────────────────────────────────────────

const MOCK_STATS_RESULT = {
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
      key: AGENT_ID,
      input: 600,
      output: 300,
      cacheRead: 60,
      cacheCreation: 30,
      total: 990,
      costUsd: 0.006,
    },
  ],
  byModel: [
    {
      key1: AGENT_ID,
      key2: "claude-sonnet-4-5",
      input: 600,
      output: 300,
      cacheRead: 60,
      cacheCreation: 30,
      total: 990,
      costUsd: 0.006,
    },
  ],
  daily: [
    {
      period: "2026-01-15",
      input: 600,
      output: 300,
      cacheRead: 60,
      cacheCreation: 30,
      total: 990,
      costUsd: 0.006,
    },
  ],
};

// ─── Mock deps factory ────────────────────────────────────────────────────────

function makeMockDeps(opts?: {
  agentChatTokenServiceThrows?: boolean;
}): AdminDeps {
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
      create: async () => {
        throw new Error("not implemented");
      },
      update: async () => {
        throw new Error("not implemented");
      },
      delete: async () => {},
      get: async () => {
        throw new Error("not implemented");
      },
      setEnabled: async () => {
        throw new Error("not implemented");
      },
      updatePreCheck: async () => {
        throw new Error("not implemented");
      },
      reconcileSystemCrons: async () => ({
        created: 0,
        updated: 0,
        deleted: 0,
      }),
    },
    agentCronRunService: {
      create: async () => {
        throw new Error("not implemented");
      },
      list: async () => ({ items: [], total: 0, limit: 20, offset: 0 }),
      patch: async () => {
        throw new Error("not implemented");
      },
    },
    agentToolService: {
      list: async () => [],
      add: async () => {
        throw new Error("not implemented");
      },
      toggle: async () => {
        throw new Error("not implemented");
      },
      remove: async () => {},
    },
    agentTokenService: {
      create: async () => {
        throw new Error("not implemented");
      },
      listForAgent: async () => [],
      revoke: async () => null,
      validate: async () => null,
    },
    agentPluginService: {
      list: async () => [],
      add: async () => {
        throw new Error("not implemented");
      },
      remove: async () => {},
      removeByName: async () => {},
    },
    agentChatTokenService: {
      upsertDailyByModel: opts?.agentChatTokenServiceThrows
        ? async (_agentId: string) => {
            throw new NotFoundError(`agent ${_agentId} not found`);
          }
        : async () => MOCK_DAILY_ROW,
      queryStats: async () => MOCK_STATS_RESULT,
    },
    agentCronRunStatsService: {
      query: async () => ({
        totals: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreation: 0,
          total: 0,
        },
        byAgent: [],
        byCron: [],
        byModel: [],
        daily: [],
        byCronModel: [],
        byPhase: [],
      }),
    },
    prisma: {
      agent: {
        create: async () => {
          throw new Error("not implemented");
        },
        findUnique: async (args: { where: { id: string } }) =>
          args.where.id === AGENT_ID
            ? {
                id: AGENT_ID,
                name: "Test Agent",
                slackId: null,
                selfHosted: false,
                repos: [],
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
              }
            : null,
        findMany: async () => [],
        delete: async () => {
          throw new Error("not implemented");
        },
        update: async () => {
          throw new Error("not implemented");
        },
      },
    } as unknown as AdminDeps["prisma"],
    provisioner: noopProvisioner,
    sessionSecret: SESSION_SECRET,
  };
}

// ─── Smoke tests ──────────────────────────────────────────────────────────────

describe("admin API — POST /agents/:agentId/chat-tokens/daily", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("returns 404 when agentId does not exist", async () => {
    const deps = makeMockDeps({ agentChatTokenServiceThrows: true });
    const app = createAdminApp(deps);

    const res = await app.request(
      `/agents/${UNKNOWN_AGENT_ID}/chat-tokens/daily`,
      {
        method: "POST",
        body: JSON.stringify({
          date: "2026-01-15",
          modelBreakdown: [
            {
              model: "claude-sonnet-4-5",
              inputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 10,
              cacheCreationTokens: 5,
              costUsd: 0.001,
            },
          ],
        }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("returns 200 with the updated rows for a valid request", async () => {
    const deps = makeMockDeps();
    const app = createAdminApp(deps);

    const res = await app.request(`/agents/${AGENT_ID}/chat-tokens/daily`, {
      method: "POST",
      body: JSON.stringify({
        date: "2026-01-15",
        modelBreakdown: [
          {
            model: "claude-sonnet-4-5",
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheCreationTokens: 5,
            costUsd: 0.0012,
          },
        ],
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Response is an array of upserted rows
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].id).toBe(MOCK_DAILY_ROW.id);
    expect(body[0].agentId).toBe(AGENT_ID);
    expect(body[0].date).toBe("2026-01-15");
    expect(body[0].model).toBe("claude-sonnet-4-5");
    expect(body[0].inputTokens).toBe(100);
    expect(body[0].outputTokens).toBe(50);
    expect(body[0].cacheReadTokens).toBe(10);
    expect(body[0].cacheCreationTokens).toBe(5);
    expect(typeof body[0].costUsd).toBe("number");
  });

  it("returns 400 when body is missing required fields", async () => {
    const deps = makeMockDeps();
    const app = createAdminApp(deps);

    const res = await app.request(`/agents/${AGENT_ID}/chat-tokens/daily`, {
      method: "POST",
      body: JSON.stringify({
        // missing date
        modelBreakdown: [],
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });

    expect(res.status).toBe(400);
  });

  it("returns 401 when unauthenticated", async () => {
    const deps = makeMockDeps();
    const app = createAdminApp(deps);

    const res = await app.request(`/agents/${AGENT_ID}/chat-tokens/daily`, {
      method: "POST",
      body: JSON.stringify({
        date: "2026-01-15",
        modelBreakdown: [
          {
            model: "claude-sonnet-4-5",
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheCreationTokens: 5,
            costUsd: 0.001,
          },
        ],
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(401);
  });
});

// ─── GET /agents/chat-tokens/daily/stats smoke tests ─────────────────────────

// Agent-scoped API key for smoke tests (scope tied to a specific agentId)
const SCOPED_API_KEY = "sk_scoped_test_key";
const SCOPED_AGENT_ID = "agent-some-other-agent";

describe("admin API — GET /agents/chat-tokens/daily/stats", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  function makeDepsWithScopedKey(opts?: {
    agentChatTokenServiceThrows?: boolean;
  }): AdminDeps {
    const deps = makeMockDeps(opts);
    // Add a scoped admin API key (not admin scope)
    deps.adminApiKeys = new Map([
      [SCOPED_API_KEY, { name: "scoped-agent", scope: SCOPED_AGENT_ID }],
    ]);
    return deps;
  }

  it("returns 200 with correct ChatTokenStats shape for authenticated admin", async () => {
    const deps = makeMockDeps();
    const app = createAdminApp(deps);

    const res = await app.request("/agents/chat-tokens/daily/stats", {
      method: "GET",
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // totals shape
    expect(typeof body.totals.input).toBe("number");
    expect(typeof body.totals.output).toBe("number");
    expect(typeof body.totals.cacheRead).toBe("number");
    expect(typeof body.totals.cacheCreation).toBe("number");
    expect(typeof body.totals.total).toBe("number");

    // byAgent is an array with at least one entry having a key
    expect(Array.isArray(body.byAgent)).toBe(true);
    if (body.byAgent.length > 0) {
      expect(typeof body.byAgent[0].key).toBe("string");
    }

    // byModel is an array with entries having key1 (agentId) and key2 (model)
    expect(Array.isArray(body.byModel)).toBe(true);
    if (body.byModel.length > 0) {
      expect(typeof body.byModel[0].key1).toBe("string");
      expect(typeof body.byModel[0].key2).toBe("string");
    }

    // daily is an array with at least one entry having a period
    expect(Array.isArray(body.daily)).toBe(true);
    if (body.daily.length > 0) {
      expect(typeof body.daily[0].period).toBe("string");
    }
  });

  it("returns 401 when unauthenticated", async () => {
    const deps = makeMockDeps();
    const app = createAdminApp(deps);

    const res = await app.request("/agents/chat-tokens/daily/stats", {
      method: "GET",
    });

    expect(res.status).toBe(401);
  });

  it("returns 403 when using an agent-scoped API key (not admin scope)", async () => {
    // Agent-scoped keys (scope = agentId, not "*") are not admin — stats route requires admin.
    // The scoped key matches the route path segment "chat-tokens" against its scope, which
    // differs → 403 from auth middleware before reaching the handler.
    const deps = makeDepsWithScopedKey();
    const app = createAdminApp(deps);

    const res = await app.request("/agents/chat-tokens/daily/stats", {
      method: "GET",
      headers: { Authorization: `Bearer ${SCOPED_API_KEY}` },
    });

    expect(res.status).toBe(403);
  });

  it("passes from/to query params through to the service", async () => {
    let capturedFrom: string | undefined;
    let capturedTo: string | undefined;

    const deps = makeMockDeps();
    deps.agentChatTokenService.queryStats = async (from, to) => {
      capturedFrom = from;
      capturedTo = to;
      return MOCK_STATS_RESULT;
    };
    const app = createAdminApp(deps);

    const res = await app.request(
      "/agents/chat-tokens/daily/stats?from=2026-01-01&to=2026-02-01",
      {
        method: "GET",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );

    expect(res.status).toBe(200);
    expect(capturedFrom).toBe("2026-01-01");
    expect(capturedTo).toBe("2026-02-01");
  });
});
