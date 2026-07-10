/**
 * agent/src/api.smoke.test.ts
 * Smoke tests for the Hono runtime API — GET /:id/config and GET /:id/crons.
 * Routes are registered without the /agents prefix because the sub-app is
 * mounted via root.route("/agents", runtimeApp) — Hono v4 strips the prefix
 * before dispatching, so root-level paths are /agents/:id/config etc.
 * Uses injected mocks — no real DB or encryption needed.
 *
 * Auth: routes are now protected by the same admin-key/per-agent-token/cookie
 * auth as the CRUD routes (SHIPWRIGHT_INTERNAL_API_KEY removed, UNI-1.2).
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import type { AgentCronJob } from "./agent-cron-jobs.ts";
import type { AgentEnvBundle } from "./agent-envs.ts";
import { NoopAgentProvisioner } from "./agent-provisioner.ts";
import { createAdminApp, parseAdminApiKeys } from "./agents-api.ts";
import { createAgentRuntimeApp } from "./api.ts";

// ─── Mock types ───────────────────────────────────────────────────────────────

interface MockPlugin {
  id: string;
  agentId: string;
  name: string;
  version: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface MockAgent {
  id: string;
  name: string;
  repos: string[];
}

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeMockAgentEnvService(bundles: Map<string, AgentEnvBundle | null>): {
  getConfigBundle: (id: string) => Promise<AgentEnvBundle | null>;
} {
  return {
    async getConfigBundle(id: string): Promise<AgentEnvBundle | null> {
      if (!bundles.has(id)) return null;
      return bundles.get(id) ?? null;
    },
  };
}

function makeMockAgentCronJobService(crons: Map<string, AgentCronJob[]>): {
  list: (id: string) => Promise<AgentCronJob[]>;
  listWithRunSummary: (
    id: string,
  ) => Promise<(AgentCronJob & { lastRun: null; runCountToday: number })[]>;
} {
  return {
    async list(id: string): Promise<AgentCronJob[]> {
      return crons.get(id) ?? [];
    },
    async listWithRunSummary(
      id: string,
    ): Promise<(AgentCronJob & { lastRun: null; runCountToday: number })[]> {
      const items = crons.get(id) ?? [];
      return items.map((item) => ({
        ...item,
        lastRun: null,
        runCountToday: 0,
      }));
    },
  };
}

function makeMockPrisma(
  agents: Map<string, MockAgent>,
  plugins: Map<string, MockPlugin[]>,
): {
  agent: {
    findUnique: (args: { where: { id: string } }) => Promise<MockAgent | null>;
  };
  agentPlugin: {
    findMany: (args: {
      where: { agentId: string; enabled: boolean };
    }) => Promise<MockPlugin[]>;
  };
} {
  return {
    agent: {
      async findUnique({
        where,
      }: { where: { id: string } }): Promise<MockAgent | null> {
        return agents.get(where.id) ?? null;
      },
    },
    agentPlugin: {
      async findMany({
        where,
      }: {
        where: { agentId: string; enabled: boolean };
      }): Promise<MockPlugin[]> {
        const all = plugins.get(where.agentId) ?? [];
        return all.filter((p) => p.enabled === where.enabled);
      },
    },
  };
}

// ─── Test data helpers ────────────────────────────────────────────────────────

const KNOWN_AGENT_ID = "agent-123";
const UNKNOWN_AGENT_ID = "agent-999";
const VALID_ADMIN_KEY = "test-admin-key";
const SESSION_SECRET = "test-session-secret-32bytes!!!!";

function makeDate(offset = 0): Date {
  return new Date(Date.now() + offset);
}

function makePlugin(agentId: string, name: string): MockPlugin {
  return {
    id: `plugin-${name}`,
    agentId,
    name,
    version: null,
    enabled: true,
    createdAt: makeDate(),
    updatedAt: makeDate(),
  };
}

function makeCron(agentId: string, id: string): AgentCronJob {
  return {
    id,
    agentId,
    schedule: "0 9 * * *",
    prompt: "Good morning",
    channel: "C123",
    user: null,
    silent: false,
    enabled: true,
    preCheck: null,
    name: null,
    system: false,
    createdAt: makeDate(),
    updatedAt: makeDate(),
  };
}

// ─── Shared setup ─────────────────────────────────────────────────────────────

function buildApp(opts?: {
  hasAgent?: boolean;
  bundleOrNull?: AgentEnvBundle | null;
  plugins?: MockPlugin[];
  crons?: AgentCronJob[];
  repos?: string[];
}) {
  const hasAgent = opts?.hasAgent ?? true;
  const bundle: AgentEnvBundle | null =
    opts?.bundleOrNull !== undefined
      ? opts.bundleOrNull
      : {
          agentId: KNOWN_AGENT_ID,
          env: { SLACK_BOT_TOKEN: "xoxb-secret", ANTHROPIC_API_KEY: "sk-ant" },
          allowedTools: ["Read", "Write", "Bash"],
        };
  const plugins = opts?.plugins ?? [
    makePlugin(KNOWN_AGENT_ID, "shipwright@shipwright"),
  ];
  const crons = opts?.crons ?? [makeCron(KNOWN_AGENT_ID, "cron-1")];
  const repos = opts?.repos ?? ["org/repo1", "org/repo2"];

  const agents = new Map<string, MockAgent>();
  const bundles = new Map<string, AgentEnvBundle | null>();
  const pluginMap = new Map<string, MockPlugin[]>();
  const cronMap = new Map<string, AgentCronJob[]>();

  if (hasAgent) {
    agents.set(KNOWN_AGENT_ID, {
      id: KNOWN_AGENT_ID,
      name: "Test Agent",
      repos,
    });
    bundles.set(KNOWN_AGENT_ID, bundle);
    pluginMap.set(KNOWN_AGENT_ID, plugins);
    cronMap.set(KNOWN_AGENT_ID, crons);
  }

  return createAgentRuntimeApp({
    agentEnvService: makeMockAgentEnvService(bundles),
    agentCronJobService: makeMockAgentCronJobService(cronMap),
    prisma: makeMockPrisma(agents, pluginMap) as never,
    adminApiKeys: parseAdminApiKeys(`admin:${VALID_ADMIN_KEY}:*`),
    agentTokenService: { validate: async () => null },
    sessionSecret: SESSION_SECRET,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /:id/config (mounted as GET /agents/:id/config from root)", () => {
  test("200 with full bundle when agent exists with env vars, tools, plugins", async () => {
    const app = buildApp();
    const res = await app.request(`/${KNOWN_AGENT_ID}/config`, {
      headers: { Authorization: `Bearer ${VALID_ADMIN_KEY}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.env).toEqual({
      SLACK_BOT_TOKEN: "xoxb-secret",
      ANTHROPIC_API_KEY: "sk-ant",
    });
    expect(body.allowedTools).toEqual(["Read", "Write", "Bash"]);
    expect(body.plugins).toEqual([
      { marketplace: "shipwright", plugin: "shipwright" },
    ]);
    expect(body.repos).toEqual(["org/repo1", "org/repo2"]);
  });

  test("200 returns repos exactly as stored on the agent, including empty", async () => {
    const app = buildApp({ repos: [] });
    const res = await app.request(`/${KNOWN_AGENT_ID}/config`, {
      headers: { Authorization: `Bearer ${VALID_ADMIN_KEY}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repos).toEqual([]);
  });

  test("parses the canonical plugin@marketplace spec, defaulting bare names to shipwright", async () => {
    const app = buildApp({
      plugins: [
        makePlugin(KNOWN_AGENT_ID, "time-tracker@acme"),
        makePlugin(KNOWN_AGENT_ID, "shipwright@shipwright"),
        makePlugin(KNOWN_AGENT_ID, "unscoped-plugin"),
        makePlugin(KNOWN_AGENT_ID, "my-plugin@org/my-marketplace"),
      ],
    });
    const res = await app.request(`/${KNOWN_AGENT_ID}/config`, {
      headers: { Authorization: `Bearer ${VALID_ADMIN_KEY}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plugins).toEqual([
      { marketplace: "acme", plugin: "time-tracker" },
      { marketplace: "shipwright", plugin: "shipwright" },
      { marketplace: "shipwright", plugin: "unscoped-plugin" },
      // Splits on the first "@" so a marketplace can itself contain a "/".
      { marketplace: "org/my-marketplace", plugin: "my-plugin" },
    ]);
  });

  test("200 with empty env and tools when agent has no env vars set", async () => {
    const app = buildApp({ bundleOrNull: null });
    const res = await app.request(`/${KNOWN_AGENT_ID}/config`, {
      headers: { Authorization: `Bearer ${VALID_ADMIN_KEY}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.env).toEqual({});
    expect(body.allowedTools).toEqual([]);
    // plugins still returned (the agent has them)
    expect(body.plugins).toEqual([
      { marketplace: "shipwright", plugin: "shipwright" },
    ]);
  });

  test("401 when no Authorization header", async () => {
    const app = buildApp();
    const res = await app.request(`/${KNOWN_AGENT_ID}/config`);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("401 when wrong API key", async () => {
    const app = buildApp();
    const res = await app.request(`/${KNOWN_AGENT_ID}/config`, {
      headers: { Authorization: "Bearer wrong-key" },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("404 for unknown agent ID", async () => {
    const app = buildApp();
    const res = await app.request(`/${UNKNOWN_AGENT_ID}/config`, {
      headers: { Authorization: `Bearer ${VALID_ADMIN_KEY}` },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });
});

describe("GET /:id/crons (mounted as GET /agents/:id/crons from root)", () => {
  test("200 with cron list for known agent", async () => {
    const app = buildApp();
    const res = await app.request(`/${KNOWN_AGENT_ID}/crons`, {
      headers: { Authorization: `Bearer ${VALID_ADMIN_KEY}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("cron-1");
    expect(body[0].agentId).toBe(KNOWN_AGENT_ID);
    expect(body[0].schedule).toBe("0 9 * * *");
  });

  test("401 when no Authorization header", async () => {
    const app = buildApp();
    const res = await app.request(`/${KNOWN_AGENT_ID}/crons`);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("401 when wrong API key", async () => {
    const app = buildApp();
    const res = await app.request(`/${KNOWN_AGENT_ID}/crons`, {
      headers: { Authorization: "Bearer wrong-key" },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("404 for unknown agent ID", async () => {
    const app = buildApp();
    const res = await app.request(`/${UNKNOWN_AGENT_ID}/crons`, {
      headers: { Authorization: `Bearer ${VALID_ADMIN_KEY}` },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });
});

// ─── Combined-server mount tests ──────────────────────────────────────────────
//
// Verifies that the runtimeApp's internal key middleware does NOT intercept
// admin CRUD requests when both apps are mounted on root as in main.ts.
// This is the regression guard for the auth middleware defect fixed in this PR:
//   root.route("/agents", runtimeApp) + root.route("/", adminApiApp)
// Before the fix, runtimeApp.use("*") was hoisted as a /agents/* guard in root,
// causing all admin CRUD requests to 401 before reaching adminApiApp handlers.

const COMBINED_ADMIN_KEY = "combined-test-admin-key";
const COMBINED_SESSION_SECRET = "combined-test-session-secret-32b!";
const COMBINED_AGENT_ID = "combined-agent-123";

function buildCombinedApp() {
  const runtimeApp = createAgentRuntimeApp({
    agentEnvService: {
      async getConfigBundle() {
        return { agentId: COMBINED_AGENT_ID, env: {}, allowedTools: [] };
      },
    },
    agentCronJobService: {
      async list() {
        return [];
      },
      async listWithRunSummary() {
        return [];
      },
    },
    prisma: {
      agent: {
        async findUnique() {
          return { id: COMBINED_AGENT_ID, repos: [] };
        },
      },
      agentPlugin: {
        async findMany() {
          return [];
        },
      },
    } as never,
    adminApiKeys: parseAdminApiKeys(`admin:${COMBINED_ADMIN_KEY}:*`),
    agentTokenService: { validate: async () => null },
    sessionSecret: COMBINED_SESSION_SECRET,
  });

  const adminApp = createAdminApp({
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
        id: "c1",
        agentId: COMBINED_AGENT_ID,
        schedule: "",
        prompt: "",
        channel: null,
        user: null,
        silent: false,
        enabled: true,
        preCheck: null,
        name: null,
        system: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      update: async () => ({
        id: "c1",
        agentId: COMBINED_AGENT_ID,
        schedule: "",
        prompt: "",
        channel: null,
        user: null,
        silent: false,
        enabled: true,
        preCheck: null,
        name: null,
        system: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      delete: async () => {},
      setEnabled: async (_agentId, _cronId, enabled) => ({
        id: "c1",
        agentId: COMBINED_AGENT_ID,
        schedule: "",
        prompt: "",
        channel: null,
        user: null,
        silent: false,
        enabled,
        preCheck: null,
        name: null,
        system: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      updatePreCheck: async (_agentId, _cronId, preCheck) => ({
        id: "c1",
        agentId: COMBINED_AGENT_ID,
        schedule: "",
        prompt: "",
        channel: null,
        user: null,
        silent: false,
        enabled: true,
        preCheck,
        name: null,
        system: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      reconcileSystemCrons: async () => ({
        created: 0,
        updated: 0,
        deleted: 0,
      }),
      get: async () => ({
        id: "c1",
        agentId: COMBINED_AGENT_ID,
        schedule: "",
        prompt: "",
        channel: null,
        user: null,
        silent: false,
        enabled: true,
        preCheck: null,
        name: null,
        system: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    },
    agentCronRunService: {
      create: async () => ({
        id: "run-1",
        cronId: "c1",
        agentId: COMBINED_AGENT_ID,
        startedAt: new Date(),
        completedAt: null,
        skipped: false,
        skipReason: null,
        outcome: null,
        error: null,
        phase: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
        model: null,
        createdAt: new Date(),
      }),
      list: async () => ({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
      }),
      patch: async () => ({
        id: "run-1",
        cronId: "c1",
        agentId: COMBINED_AGENT_ID,
        startedAt: new Date(),
        completedAt: null,
        skipped: false,
        skipReason: null,
        outcome: null,
        error: null,
        phase: null,
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
    agentToolService: {
      list: async () => [],
      add: async () => ({
        id: "t1",
        agentId: COMBINED_AGENT_ID,
        pattern: "Read",
        enabled: true,
        createdAt: new Date(),
      }),
      remove: async () => {},
      toggle: async () => ({
        id: "t1",
        agentId: COMBINED_AGENT_ID,
        pattern: "Read",
        enabled: false,
        createdAt: new Date(),
      }),
    },
    agentTokenService: {
      create: async () => ({
        token: {
          id: "tok1",
          agentId: COMBINED_AGENT_ID,
          token: "hash",
          label: null,
          createdAt: new Date(),
          revokedAt: null,
        },
        rawToken: "raw",
      }),
      listForAgent: async () => [],
      revoke: async () => ({
        id: "tok1",
        agentId: COMBINED_AGENT_ID,
        token: "hash",
        label: null,
        createdAt: new Date(),
        revokedAt: new Date(),
      }),
      validate: async () => null,
    },
    agentPluginService: {
      list: async () => [],
      add: async () => ({
        id: "p1",
        agentId: COMBINED_AGENT_ID,
        name: "plugin",
        version: null,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      remove: async () => {},
      removeByName: async () => {},
    },
    agentChatTokenService: {
      upsertDailyByModel: async (
        _agentId: string,
        date: string,
        model: string,
      ) => ({
        id: "daily-id",
        agentId: _agentId,
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
        create: async () => ({
          id: "new-id",
          name: "New",
          slackId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    } as never,
    provisioner: new NoopAgentProvisioner(),
    taskStore: {
      listTokensForAgent: async () => [],
      revokeToken: async () => {},
    },
    chatService: {
      listTokensForAgent: async () => [],
      revokeToken: async () => {},
      deleteThreadsForAgent: async () => ({ deleted: 0 }),
    },
    slack: {
      deleteApp: async () => {},
    },
    decrypt: (value: string) => value,
    sessionSecret: COMBINED_SESSION_SECRET,
    adminApiKeys: parseAdminApiKeys(`admin:${COMBINED_ADMIN_KEY}:*`),
  });

  const root = new Hono();
  root.get("/health", (c) => c.json({ status: "ok" }));
  root.get("/", (c) => c.redirect("/admin/login", 302));
  root.route("/agents", runtimeApp);
  root.route("/", adminApp);
  return root;
}

describe("root redirect — GET / → 302 /admin/login", () => {
  test("GET / returns 302 with Location /admin/login", async () => {
    const root = buildCombinedApp();
    const res = await root.request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });
});

describe("combined server — regression guard: runtime middleware must not block admin CRUD", () => {
  test("POST /agents/:id/envs with admin key reaches admin handler (201, not 401)", async () => {
    const root = buildCombinedApp();
    const res = await root.request(`/agents/${COMBINED_AGENT_ID}/envs`, {
      method: "POST",
      body: JSON.stringify({ FOO: "bar" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${COMBINED_ADMIN_KEY}`,
      },
    });
    // Both runtimeApp and adminApp use the same admin auth — admin key works for all routes.
    expect(res.status).toBe(201);
  });

  test("runtime GET /agents/:id/config still requires auth (401 without it)", async () => {
    const root = buildCombinedApp();
    const res = await root.request(`/agents/${COMBINED_AGENT_ID}/config`);
    expect(res.status).toBe(401);
  });

  test("runtime GET /agents/:id/config succeeds with admin key (200)", async () => {
    const root = buildCombinedApp();
    const res = await root.request(`/agents/${COMBINED_AGENT_ID}/config`, {
      headers: { Authorization: `Bearer ${COMBINED_ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repos).toEqual([]);
  });
});
