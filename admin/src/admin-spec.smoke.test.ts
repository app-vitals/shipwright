/**
 * admin/src/admin-spec.smoke.test.ts
 * Smoke test: GET /doc returns 200 with a valid OpenAPI 3.1.0 document.
 *
 * Verifies that a locally-assembled root app (runtime + admin + /doc) returns a
 * valid 3.1.0 spec. `buildSpecApp()` wires the /doc endpoint directly — this test
 * does NOT verify that production `main.ts` exposes /doc (it does not today;
 * wiring /doc in the factory is a planned follow-up).
 */

import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { NoopAgentProvisioner } from "./agent-provisioner.ts";
import { createAdminApp, parseAdminApiKeys } from "./agents-api.ts";
import { createAgentRuntimeApp } from "./api.ts";

const SESSION_SECRET = "spec-test-session-secret-32bytes!";
const ADMIN_API_KEY = "spec-test-admin-key";

function buildSpecApp() {
  const runtimeApp = createAgentRuntimeApp({
    agentEnvService: {
      async getConfigBundle() {
        return null;
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
          return null;
        },
      },
      agentPlugin: {
        async findMany() {
          return [];
        },
      },
    } as never,
    adminApiKeys: parseAdminApiKeys(`admin:${ADMIN_API_KEY}:*`),
    agentTokenService: { validate: async () => null },
    sessionSecret: SESSION_SECRET,
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
      create: async () => ({
        id: "c1",
        agentId: "a1",
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
        agentId: "a1",
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
      get: async () => ({
        id: "c1",
        agentId: "a1",
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
      setEnabled: async (_a, _c, enabled) => ({
        id: "c1",
        agentId: "a1",
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
      updatePreCheck: async (_a, _c, preCheck) => ({
        id: "c1",
        agentId: "a1",
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
      listWithRunSummary: async () => [],
    },
    agentCronRunService: {
      create: async () => ({
        id: "run1",
        cronId: "c1",
        agentId: "a1",
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
        id: "run1",
        cronId: "c1",
        agentId: "a1",
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
    agentToolService: {
      list: async () => [],
      add: async () => ({
        id: "t1",
        agentId: "a1",
        pattern: "Read",
        enabled: true,
        createdAt: new Date(),
      }),
      remove: async () => {},
      toggle: async () => ({
        id: "t1",
        agentId: "a1",
        pattern: "Read",
        enabled: false,
        createdAt: new Date(),
      }),
    },
    agentTokenService: {
      create: async () => ({
        token: {
          id: "tok1",
          agentId: "a1",
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
        agentId: "a1",
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
        agentId: "a1",
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
        findUnique: async () => null,
        findMany: async () => [],
        delete: async () => ({
          id: "id",
          name: "Name",
          slackId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    } as never,
    provisioner: new NoopAgentProvisioner(),
    sessionSecret: SESSION_SECRET,
    adminApiKeys: parseAdminApiKeys(`admin:${ADMIN_API_KEY}:*`),
  });

  const root = new OpenAPIHono();
  root.route("/agents", runtimeApp);
  root.route("/", adminApp);
  root.doc("/doc", {
    openapi: "3.1.0",
    info: { title: "Shipwright Admin API", version: "0.1.0" },
  });

  return root;
}

describe("GET /doc — OpenAPI spec endpoint", () => {
  it("returns 200 with a JSON body containing openapi: '3.1.0'", async () => {
    const app = buildSpecApp();
    const res = await app.request("/doc");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toBe("3.1.0");
    expect(body.info).toBeDefined();
    expect(body.info.title).toBe("Shipwright Admin API");
    expect(body.paths).toBeDefined();
  });

  it("spec covers runtime routes (GET /agents/:id/config and /agents/:id/crons)", async () => {
    const app = buildSpecApp();
    const res = await app.request("/doc");
    const body = await res.json();
    // Runtime routes mounted via root.route("/agents", runtimeApp) appear with
    // Hono colon notation (:id) in the live /doc output — NOT curly-brace OAS
    // notation ({id}). The committed admin/openapi.json and lib/admin-types.ts
    // use {id} because generate-admin-spec.ts rewrites colons before writing the
    // artifact. Both are correct for their context; these assertions must match
    // the live Hono format, not the committed spec file.
    expect(body.paths["/agents/:id/config"]).toBeDefined();
    expect(body.paths["/agents/:id/crons"]).toBeDefined();
  });

  it("spec covers admin routes (POST /agents, GET /agents/{id}/envs)", async () => {
    const app = buildSpecApp();
    const res = await app.request("/doc");
    const body = await res.json();
    expect(body.paths["/agents"]).toBeDefined();
    expect(body.paths["/agents/{id}/envs"]).toBeDefined();
  });
});
