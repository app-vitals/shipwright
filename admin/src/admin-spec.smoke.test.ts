/**
 * admin/src/admin-spec.smoke.test.ts
 * Smoke test: GET /doc returns 200 with a valid OpenAPI 3.1.0 document.
 *
 * Verifies that a locally-assembled root app (runtime + admin + /doc) returns a
 * valid 3.1.0 spec. `buildSpecApp()` wires the /doc endpoint directly — this test
 * does NOT verify that production `main.ts` exposes /doc (it does not today;
 * wiring /doc in the factory is a planned follow-up).
 *
 * Also guards the committed generated artifact `admin/openapi.json` against
 * drift: its path+method set must match the live spec, so a route removed from
 * (or added to) the Hono registrations can't be left behind in the checked-in
 * spec (and therefore in the `lib/admin-types.ts` generated from it).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    agentService: {
      async getById() {
        return null;
      },
    },
    agentPluginService: {
      async listEnabled() {
        return [];
      },
    },
    adminApiKeys: parseAdminApiKeys(`admin:${ADMIN_API_KEY}:*`),
    agentTokenService: { validate: async () => null },
    sessionSecret: SESSION_SECRET,
  });

  const adminApp = createAdminApp({
    agentService: {
      create: async () => ({
        id: "a1",
        name: "",
        slackId: null,
        selfHosted: false,
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        typeName: "coding",
        createdAt: new Date(),
        updatedAt: new Date(),
        missingRequiredEnv: [],
      }),
      delete: async () => {},
      list: async () => [],
      getSummary: async () => null,
      getDetail: async () => null,
      exists: async () => false,
      updateSelfHosted: async () => ({
        id: "a1",
        name: "",
        slackId: null,
        selfHosted: false,
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        typeName: "coding",
        createdAt: new Date(),
        updatedAt: new Date(),
        missingRequiredEnv: [],
      }),
      updateFields: async () => {
        throw new Error("not implemented");
      },
      runTransaction: async (fn) => fn(undefined as never),
    },
    agentTypeRegistry: {
      getManifest: () => {
        throw new Error("not implemented");
      },
      tryGetManifest: () => undefined,
      listTypes: () => [],
    },
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
        parentCronId: null,
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
        parentCronId: null,
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
        parentCronId: null,
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
        parentCronId: null,
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
        parentCronId: null,
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
        itemType: null,
        itemId: null,
        sessionId: null,
        lastHeartbeatAt: null,
        phaseId: null,
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
        itemType: null,
        itemId: null,
        sessionId: null,
        lastHeartbeatAt: null,
        phaseId: null,
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
    agentMemberService: {
      add: async (agentId: string, email: string) => ({
        id: "member-1",
        agentId,
        email,
        createdAt: new Date(),
      }),
      listByAgentId: async () => [],
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
    agentWorkQueueService: {
      push: async () => {
        throw new Error("not implemented");
      },
      get: async () => null,
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
      agentEnv: {
        findMany: async () => [],
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

  it("spec covers admin routes (GET /agents, POST /agents, GET /agents/{id}/envs)", async () => {
    const app = buildSpecApp();
    const res = await app.request("/doc");
    const body = await res.json();
    expect(body.paths["/agents"]).toBeDefined();
    expect(body.paths["/agents"].get).toBeDefined();
    expect(body.paths["/agents/{id}/envs"]).toBeDefined();
  });

  it("documents the POST /agents creation route (APA-2.1)", async () => {
    const app = buildSpecApp();
    const res = await app.request("/doc");
    const body = await res.json();
    // ABF-3.2 retired the JSON creation API (no caller existed at the time);
    // APA-2.1 reinstates it once createAgent() (APA-1.1) made agent creation a
    // single, injectable function multiple callers — the web UI form and this
    // route — can both call.
    expect(body.paths["/agents"].post).toBeDefined();
    expect(body.components?.schemas?.CreateAgentBody).toBeDefined();
  });

  it("committed admin/openapi.json matches the live spec's routes", async () => {
    const app = buildSpecApp();
    const res = await app.request("/doc");
    const live = await res.json();
    const committed = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../openapi.json"), "utf8"),
    ) as { paths: Record<string, Record<string, unknown>> };

    // The live /doc keeps Hono colon params (`:id`); generate-admin-spec.ts
    // rewrites them to OpenAPI braces before writing the artifact.
    const operations = (paths: Record<string, Record<string, unknown>>) =>
      Object.entries(paths)
        .flatMap(([path, def]) =>
          Object.keys(def).map(
            (method) =>
              `${method.toUpperCase()} ${path.replace(/:(\w+)/g, "{$1}")}`,
          ),
        )
        .sort();

    // If this fails, run `bun run generate:admin-spec && bun run generate:admin-types`.
    expect(operations(committed.paths)).toEqual(operations(live.paths));
  });
});
