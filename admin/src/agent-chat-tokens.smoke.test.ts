/**
 * admin/src/agent-chat-tokens.smoke.test.ts
 * Smoke tests for POST /agents/:agentId/chat-tokens/daily.
 *
 * Uses app.request() — no real server, no real DB.
 * Services are injected as in-memory mocks.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import { createAdminApp } from "./agents-api.ts";
import type { AdminDeps } from "./agents-api.ts";
import type { AgentProvisioner, ProvisionResult } from "./agent-provisioner.ts";
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

// ─── Mock row returned by upsertDaily ─────────────────────────────────────────

const MOCK_DAILY_ROW = {
  id: "cld_test_001",
  agentId: AGENT_ID,
  date: "2026-01-15",
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 10,
  cacheCreationTokens: 5,
  costUsd: 0.0012,
  createdAt: new Date("2026-01-15T00:00:00.000Z"),
  updatedAt: new Date("2026-01-15T12:00:00.000Z"),
};

// ─── Mock deps factory ────────────────────────────────────────────────────────

function makeMockDeps(opts?: { agentChatTokenServiceThrows?: boolean }): AdminDeps {
  return {
    agentEnvService: {
      upsert: async () => {},
      patch: async () => {},
      getByAgentId: async () => ({}),
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
      reconcileSystemCrons: async () => ({ created: 0, updated: 0, deleted: 0 }),
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
      upsertDaily: opts?.agentChatTokenServiceThrows
        ? async (_agentId: string) => {
            throw new NotFoundError(`agent ${_agentId} not found`);
          }
        : async () => MOCK_DAILY_ROW,
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
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheCreationTokens: 5,
          costUsd: 0.001,
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

  it("returns 200 with the updated row for a valid request", async () => {
    const deps = makeMockDeps();
    const app = createAdminApp(deps);

    const res = await app.request(`/agents/${AGENT_ID}/chat-tokens/daily`, {
      method: "POST",
      body: JSON.stringify({
        date: "2026-01-15",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costUsd: 0.0012,
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(MOCK_DAILY_ROW.id);
    expect(body.agentId).toBe(AGENT_ID);
    expect(body.date).toBe("2026-01-15");
    expect(body.inputTokens).toBe(100);
    expect(body.outputTokens).toBe(50);
    expect(body.cacheReadTokens).toBe(10);
    expect(body.cacheCreationTokens).toBe(5);
    expect(typeof body.costUsd).toBe("number");
  });

  it("returns 400 when body is missing required fields", async () => {
    const deps = makeMockDeps();
    const app = createAdminApp(deps);

    const res = await app.request(`/agents/${AGENT_ID}/chat-tokens/daily`, {
      method: "POST",
      body: JSON.stringify({
        // missing date
        inputTokens: 100,
        outputTokens: 50,
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
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costUsd: 0.001,
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(401);
  });
});
