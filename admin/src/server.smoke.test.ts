/**
 * admin/src/server.smoke.test.ts
 * Thin composition smoke test for admin/src/server.ts — the Hono entrypoint
 * barrel.
 *
 * Confirms createAdminUIApp + createAdminApp + createAgentRuntimeApp (all
 * imported via the server.ts barrel) are reachable once mounted together the
 * same way main.ts's startServer() composes them. Deliberately does NOT
 * assert on any sub-app's route behavior — that's covered by
 * admin-ui.smoke.test.ts, agents-api.smoke.test.ts, and api.smoke.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import {
  createAdminApp,
  createAdminUIApp,
  createAgentRuntimeApp,
} from "./server.ts";

const SESSION_SECRET = "test-server-smoke-session-secret!!";

const notImplemented = () => {
  throw new Error("not implemented — smoke test only exercises routing");
};

// Shared stub prisma satisfying every prisma-shaped field the three deps
// interfaces require (agent, agentEnv, agentPlugin, agentMember). Unauthenticated
// requests never reach a handler that calls these, so throwing is safe.
const stubPrisma = {
  agent: {
    findMany: notImplemented,
    findUnique: notImplemented,
    create: notImplemented,
    update: notImplemented,
    delete: notImplemented,
  },
  agentEnv: { findMany: notImplemented },
  agentPlugin: { findMany: notImplemented },
  agentMember: {
    findMany: notImplemented,
    findUnique: notImplemented,
    create: notImplemented,
    deleteMany: notImplemented,
  },
} as never;

const stubAgentTokenService = { validate: notImplemented } as never;

function buildComposedApp() {
  const root = new Hono();

  const runtimeApp = createAgentRuntimeApp({
    agentEnvService: { getConfigBundle: notImplemented },
    agentCronJobService: {
      list: notImplemented,
      listWithRunSummary: notImplemented,
    },
    agentService: { getById: notImplemented },
    prisma: stubPrisma,
    sessionSecret: SESSION_SECRET,
    agentTokenService: stubAgentTokenService,
  });
  root.route("/agents", runtimeApp);

  const adminApiApp = createAdminApp({
    agentService: {
      create: notImplemented,
      delete: notImplemented,
      list: notImplemented,
      getSummary: notImplemented,
      getDetail: notImplemented,
      exists: notImplemented,
      updateSelfHosted: notImplemented,
    },
    agentEnvService: {
      upsert: notImplemented,
      patch: notImplemented,
      getByAgentId: notImplemented,
      deleteKey: notImplemented,
    },
    agentCronJobService: {
      list: notImplemented,
      listWithRunSummary: notImplemented,
      create: notImplemented,
      update: notImplemented,
      delete: notImplemented,
      reconcileSystemCrons: notImplemented,
      get: notImplemented,
      setEnabled: notImplemented,
      updatePreCheck: notImplemented,
    },
    agentCronRunService: {
      create: notImplemented,
      list: notImplemented,
      patch: notImplemented,
    },
    agentCronRunStatsService: { query: notImplemented },
    agentToolService: {
      list: notImplemented,
      add: notImplemented,
      remove: notImplemented,
      toggle: notImplemented,
    },
    agentTokenService: {
      create: notImplemented,
      listForAgent: notImplemented,
      revoke: notImplemented,
      validate: notImplemented,
    },
    agentPluginService: {
      list: notImplemented,
      add: notImplemented,
      remove: notImplemented,
      removeByName: notImplemented,
    },
    agentChatTokenService: {
      upsertDailyByModel: notImplemented,
      queryStats: notImplemented,
    },
    agentWorkQueueService: { push: notImplemented, get: notImplemented },
    prisma: stubPrisma,
    provisioner: {
      provision: notImplemented,
      deprovision: notImplemented,
      reconcile: notImplemented,
    },
    taskStore: {
      listTokensForAgent: notImplemented,
      revokeToken: notImplemented,
    },
    chatService: {
      listTokensForAgent: notImplemented,
      revokeToken: notImplemented,
      deleteThreadsForAgent: notImplemented,
    },
    slack: { deleteApp: notImplemented },
    decrypt: notImplemented,
    sessionSecret: SESSION_SECRET,
  });
  root.route("/", adminApiApp);

  const adminUIApp = createAdminUIApp({
    prisma: stubPrisma,
    agentEnvService: {
      getByAgentId: notImplemented,
      upsert: notImplemented,
      patch: notImplemented,
      deleteKey: notImplemented,
      getConfigBundle: notImplemented,
    },
    agentCronJobService: {
      list: notImplemented,
      listWithRunSummary: notImplemented,
      create: notImplemented,
      update: notImplemented,
      setEnabled: notImplemented,
      delete: notImplemented,
      get: notImplemented,
      reconcileSystemCrons: notImplemented,
    },
    agentCronRunService: { listForAgent: notImplemented },
    agentWorkQueueService: { get: notImplemented },
    agentToolService: {
      list: notImplemented,
      add: notImplemented,
      toggle: notImplemented,
      remove: notImplemented,
    },
    agentTokenService: {
      listForAgent: notImplemented,
      create: notImplemented,
      revoke: notImplemented,
    },
    agentPluginService: { list: notImplemented },
    agentMemberService: {
      listByEmail: notImplemented,
      exists: notImplemented,
      add: notImplemented,
      remove: notImplemented,
    },
    provisioner: {
      provision: notImplemented,
      deprovision: notImplemented,
      reconcile: notImplemented,
    },
    taskStore: {
      listTokensForAgent: notImplemented,
      revokeToken: notImplemented,
    },
    chatService: {
      listTokensForAgent: notImplemented,
      revokeToken: notImplemented,
      deleteThreadsForAgent: notImplemented,
    },
    slack: { deleteApp: notImplemented },
    decrypt: notImplemented,
    sessionSecret: SESSION_SECRET,
    googleClient: { exchangeCode: notImplemented, getUserInfo: notImplemented },
    googleClientId: "test-google-client-id",
    googleClientSecret: "test-google-client-secret",
    adminAllowedEmails: ["admin@example.com"],
    slackClient: {
      createAppManifest: notImplemented,
      updateAppManifest: notImplemented,
      exchangeOAuthCode: notImplemented,
    },
    appBaseUrl: "http://localhost:3000",
  });
  root.route("/", adminUIApp);

  return root;
}

describe("server.ts composed app mounts correctly", () => {
  const app = buildComposedApp();

  it("mounts createAdminUIApp — GET /admin/login is reachable (public route)", async () => {
    const res = await app.request("/admin/login");
    expect(res.status).toBe(200);
  });

  it("mounts createAgentRuntimeApp under /agents — GET /agents/:id/config requires auth", async () => {
    const res = await app.request("/agents/agent-test-123/config");
    expect(res.status).toBe(401);
  });

  it("mounts createAdminApp — GET /agents (admin CRUD API) requires auth", async () => {
    const res = await app.request("/agents");
    expect(res.status).toBe(401);
  });
});
