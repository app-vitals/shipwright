/**
 * agent/src/api.smoke.test.ts
 * Smoke tests for the Hono runtime API — GET /:id/config and GET /:id/crons.
 * Routes are registered without the /agents prefix because the sub-app is
 * mounted via root.route("/agents", runtimeApp) — Hono v4 strips the prefix
 * before dispatching, so root-level paths are /agents/:id/config etc.
 * Uses injected mocks — no real DB or encryption needed.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { createAdminApp, parseAdminApiKeys } from "./agents-api.ts";
import type { AgentCronJob } from "./agent-cron-jobs.ts";
import type { AgentEnvBundle } from "./agent-envs.ts";
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
} {
  return {
    async list(id: string): Promise<AgentCronJob[]> {
      return crons.get(id) ?? [];
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
const VALID_API_KEY = "test-internal-key";

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
    makePlugin(KNOWN_AGENT_ID, "@shipwright/plugin"),
  ];
  const crons = opts?.crons ?? [makeCron(KNOWN_AGENT_ID, "cron-1")];

  const agents = new Map<string, MockAgent>();
  const bundles = new Map<string, AgentEnvBundle | null>();
  const pluginMap = new Map<string, MockPlugin[]>();
  const cronMap = new Map<string, AgentCronJob[]>();

  if (hasAgent) {
    agents.set(KNOWN_AGENT_ID, { id: KNOWN_AGENT_ID, name: "Test Agent" });
    bundles.set(KNOWN_AGENT_ID, bundle);
    pluginMap.set(KNOWN_AGENT_ID, plugins);
    cronMap.set(KNOWN_AGENT_ID, crons);
  }

  return createAgentRuntimeApp({
    agentEnvService: makeMockAgentEnvService(bundles),
    agentCronJobService: makeMockAgentCronJobService(cronMap),
    prisma: makeMockPrisma(agents, pluginMap) as never,
    internalApiKey: VALID_API_KEY,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /:id/config (mounted as GET /agents/:id/config from root)", () => {
  test("200 with full bundle when agent exists with env vars, tools, plugins", async () => {
    const app = buildApp();
    const res = await app.request(`/${KNOWN_AGENT_ID}/config`, {
      headers: { Authorization: `Bearer ${VALID_API_KEY}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.env).toEqual({
      SLACK_BOT_TOKEN: "xoxb-secret",
      ANTHROPIC_API_KEY: "sk-ant",
    });
    expect(body.allowedTools).toEqual(["Read", "Write", "Bash"]);
    expect(body.plugins).toEqual([
      { marketplace: "shipwright", plugin: "@shipwright/plugin" },
    ]);
  });

  test("derives marketplace from the plugin namespace, defaulting to shipwright", async () => {
    const app = buildApp({
      plugins: [
        makePlugin(KNOWN_AGENT_ID, "@vitals-os/plugin"),
        makePlugin(KNOWN_AGENT_ID, "@shipwright/plugin"),
        makePlugin(KNOWN_AGENT_ID, "unscoped-plugin"),
      ],
    });
    const res = await app.request(`/${KNOWN_AGENT_ID}/config`, {
      headers: { Authorization: `Bearer ${VALID_API_KEY}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plugins).toEqual([
      { marketplace: "vitals-os", plugin: "@vitals-os/plugin" },
      { marketplace: "shipwright", plugin: "@shipwright/plugin" },
      { marketplace: "shipwright", plugin: "unscoped-plugin" },
    ]);
  });

  test("200 with empty env and tools when agent has no env vars set", async () => {
    const app = buildApp({ bundleOrNull: null });
    const res = await app.request(`/${KNOWN_AGENT_ID}/config`, {
      headers: { Authorization: `Bearer ${VALID_API_KEY}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.env).toEqual({});
    expect(body.allowedTools).toEqual([]);
    // plugins still returned (the agent has them)
    expect(body.plugins).toEqual([
      { marketplace: "shipwright", plugin: "@shipwright/plugin" },
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
      headers: { Authorization: `Bearer ${VALID_API_KEY}` },
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
      headers: { Authorization: `Bearer ${VALID_API_KEY}` },
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
      headers: { Authorization: `Bearer ${VALID_API_KEY}` },
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

const COMBINED_INTERNAL_KEY = "combined-test-internal-key";
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
    },
    prisma: {
      agent: {
        async findUnique() {
          return { id: COMBINED_AGENT_ID };
        },
      },
      agentPlugin: {
        async findMany() {
          return [];
        },
      },
    } as never,
    internalApiKey: COMBINED_INTERNAL_KEY,
  });

  const adminApp = createAdminApp({
    agentEnvService: {
      upsert: async () => {},
      patch: async () => {},
      getByAgentId: async () => ({}),
      deleteKey: async () => {},
    },
    agentCronJobService: {
      list: async () => [],
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
    sessionSecret: COMBINED_SESSION_SECRET,
    adminApiKeys: parseAdminApiKeys(`admin:${COMBINED_ADMIN_KEY}:*`),
  });

  const root = new Hono();
  root.route("/agents", runtimeApp);
  root.route("/", adminApp);
  return root;
}

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
    // Before the fix: runtime app.use("*") intercepted with 401
    // After the fix: per-route middleware means only /:id/config and /:id/crons
    // check the internal key; admin CRUD reaches the admin handler → 201
    expect(res.status).toBe(201);
  });

  test("runtime GET /agents/:id/config still requires internal key (401 without it)", async () => {
    const root = buildCombinedApp();
    const res = await root.request(`/agents/${COMBINED_AGENT_ID}/config`);
    expect(res.status).toBe(401);
  });

  test("runtime GET /agents/:id/config succeeds with correct internal key (200)", async () => {
    const root = buildCombinedApp();
    const res = await root.request(`/agents/${COMBINED_AGENT_ID}/config`, {
      headers: { Authorization: `Bearer ${COMBINED_INTERNAL_KEY}` },
    });
    expect(res.status).toBe(200);
  });
});
