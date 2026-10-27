/**
 * admin/e2e/test-server.ts
 * Admin UI — E2E Test Server (ADM-3.2)
 *
 * Starts a minimal Hono server backed by in-memory mock services so that
 * Playwright tests can exercise the admin UI without a real database or
 * Google OAuth credentials.
 *
 * Usage:
 *   ADMIN_E2E_PORT=3490 bun run admin/e2e/test-server.ts
 *   ADMIN_E2E_AGENTS_MODE=1 ADMIN_E2E_PORT=3490 bun run admin/e2e/test-server.ts
 *
 * The server exposes:
 *   GET /health               → 200 OK
 *   GET /admin/login          → login page
 *   GET /admin/agents         → agents list (requires admin_session cookie)
 *   GET /admin/agents/:id     → agent detail (requires admin_session cookie)
 */

import type { AdminUIDeps } from "@app-vitals/agent-admin/admin-ui";
import { createAdminUIApp } from "@app-vitals/agent-admin/admin-ui";
import { Hono } from "hono";
import { applyShipwrightDefaults } from "../src/main.ts";

// The platform admin resolves its default specialties dir inside
// node_modules; point it at Shipwright's, the way main.ts does at boot (the
// "new agent" page lists them).
applyShipwrightDefaults(process.env);

// ─── Config ───────────────────────────────────────────────────────────────────

const ADMIN_E2E_PORT = 3490;
const ADMIN_E2E_SESSION_SECRET =
  process.env.ADMIN_E2E_SESSION_SECRET ?? "e2e-admin-test-secret-32chars!!!";

const ADMIN_E2E_AGENT = {
  id: "agent-e2e-1",
  name: "Test Agent",
  slackId: "U999TEST",
};

// ─── Mock data ────────────────────────────────────────────────────────────────

const MOCK_CRON = {
  id: "cron-e2e-1",
  agentId: ADMIN_E2E_AGENT.id,
  schedule: "0 9 * * 1",
  prompt: "Send the weekly standup summary to the team channel",
  channel: "#general",
  user: null,
  enabled: true,
  name: null,
  system: false,
  silent: false,
  preCheck: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const MOCK_TOOL = {
  id: "tool-e2e-1",
  agentId: ADMIN_E2E_AGENT.id,
  pattern: "Bash(git:*)",
  enabled: true,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const MOCK_TOKEN = {
  id: "token-e2e-1",
  agentId: ADMIN_E2E_AGENT.id,
  token: "hashed-token-value",
  label: "Production token",
  createdAt: new Date("2024-01-01"),
  revokedAt: null,
};

// ─── Mock deps factory ────────────────────────────────────────────────────────

function buildMockDeps(): AdminUIDeps {
  return {
    prisma: {
      agent: {
        findMany: async () => [
          {
            id: ADMIN_E2E_AGENT.id,
            name: ADMIN_E2E_AGENT.name,
            slackId: ADMIN_E2E_AGENT.slackId,
            createdAt: new Date("2024-01-01"),
          },
        ],
        findUnique: async () => ({
          id: ADMIN_E2E_AGENT.id,
          name: ADMIN_E2E_AGENT.name,
          slackId: ADMIN_E2E_AGENT.slackId,
          selfHosted: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        create: async () => ({
          id: ADMIN_E2E_AGENT.id,
          name: ADMIN_E2E_AGENT.name,
          slackId: ADMIN_E2E_AGENT.slackId,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
      },
      agentPlugin: {
        findMany: async () => [],
      },
      // Referenced by the agent detail page's admin-only member list and by
      // assertAgentAccess's non-admin membership check. Sessions minted for
      // these e2e tests explicitly set `isAdmin: true`,
      // so the render path deliberately takes the admin branch
      // (prisma.agentMember.findMany), never the non-admin findUnique branch.
      // No members fixture exists, so both resolve to empty/not-found. A
      // non-admin session case isn't exercised here — that's an intentional
      // test-coverage gap, not a fixture bug.
      agentMember: {
        findMany: async () => [],
        findUnique: async () => null,
        create: async () => {
          throw new Error("not used in e2e tests");
        },
        deleteMany: async () => ({ count: 0 }),
      },
    },
    agentEnvService: {
      getByAgentId: async () => ({
        SLACK_BOT_TOKEN: "xoxb-secret-value",
        OPENAI_API_KEY: "sk-secret-value",
      }),
      upsert: async () => {},
      patch: async () => {},
      deleteKey: async () => {},
      getConfigBundle: async () => null,
    },
    agentCronJobService: {
      list: async () => [MOCK_CRON],
      // Mirrors AgentCronJobService.listWithRunSummary: same rows as list(),
      // plus a per-cron lastRun summary (null = "never run") and a
      // runCountToday count. MOCK_CRON has never run, so both are the
      // "no runs yet" defaults — the agent detail page renders that as
      // "never" in the cron table, which doesn't affect the schedule/prompt
      // assertions the existing e2e tests make.
      listWithRunSummary: async () => [
        { ...MOCK_CRON, lastRun: null, runCountToday: 0 },
      ],
      get: async () => MOCK_CRON,
      create: async () => MOCK_CRON,
      update: async () => MOCK_CRON,
      setEnabled: async () => MOCK_CRON,
      delete: async () => {},
      reconcileSystemCrons: async () => ({
        created: 0,
        updated: 0,
        deleted: 0,
      }),
    },
    agentToolService: {
      list: async () => [MOCK_TOOL],
      add: async () => MOCK_TOOL,
      toggle: async () => MOCK_TOOL,
      remove: async () => {},
    },
    agentTokenService: {
      listForAgent: async () => [MOCK_TOKEN],
      create: async () => ({
        token: MOCK_TOKEN,
        rawToken: "sw_e2erawtokenvalue",
      }),
      revoke: async () => MOCK_TOKEN,
    },
    agentPluginService: {
      list: async () => [],
      add: async (agentId: string, name: string) => ({
        id: "plugin-e2e-1",
        agentId,
        name,
        version: null,
        enabled: true,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      }),
    },
    agentMemberService: {
      listByEmail: async () => [],
      exists: async () => false,
      add: async (agentId: string, email: string) => ({
        id: "m1",
        agentId,
        email,
      }),
      remove: async () => {},
      listByAgentId: async () => [],
    },
    agentService: {
      listAll: async () => [
        {
          id: ADMIN_E2E_AGENT.id,
          name: ADMIN_E2E_AGENT.name,
          slackId: ADMIN_E2E_AGENT.slackId,
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ],
      listByIds: async () => [],
      searchByName: async () => [],
      listOptions: async () => [
        { id: ADMIN_E2E_AGENT.id, name: ADMIN_E2E_AGENT.name },
      ],
      create: async (input: { name: string; typeName?: string }) => ({
        id: ADMIN_E2E_AGENT.id,
        name: input.name ?? ADMIN_E2E_AGENT.name,
        slackId: ADMIN_E2E_AGENT.slackId,
        selfHosted: false,
        typeName: input.typeName ?? "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      }),
      delete: async () => {},
      getDetail: async () => ({
        id: ADMIN_E2E_AGENT.id,
        name: ADMIN_E2E_AGENT.name,
        slackId: ADMIN_E2E_AGENT.slackId,
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        missingRequiredEnv: [],
      }),
      updateFields: async () => ({
        id: ADMIN_E2E_AGENT.id,
        name: ADMIN_E2E_AGENT.name,
        slackId: ADMIN_E2E_AGENT.slackId,
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        missingRequiredEnv: [],
      }),
    },
    provisioner: {
      canProvision: false,
      provision: async () => ({
        resourceName: "r",
        secretName: "s",
        deploymentName: "d",
      }),
      deprovision: async () => {},
      reconcile: async () => ({
        recreated: [],
        updated: [],
        orphans: [],
        failed: [],
      }),
    },
    sessionSecret: ADMIN_E2E_SESSION_SECRET,
    googleClientId: "e2e-google-client-id",
    googleClientSecret: "e2e-google-client-secret",
    adminAllowedEmails: ["admin@example.com"],
    googleClient: {
      exchangeCode: () => Promise.reject(new Error("not used in e2e tests")),
      getUserInfo: () => Promise.reject(new Error("not used in e2e tests")),
    },
    slackClient: {
      createAppManifest: async () => ({
        appId: "A_E2E_TEST",
        oauthRedirectUrl: "https://slack.com/oauth/authorize?client_id=e2e",
      }),
    },
    appBaseUrl: `http://localhost:${ADMIN_E2E_PORT}`,
  };
}

// ─── Build app ────────────────────────────────────────────────────────────────

function buildTestApp(): Hono {
  const app = new Hono();

  // Health check
  app.get("/health", (c) => c.text("ok"));

  // Mount the admin UI
  const adminApp = createAdminUIApp(buildMockDeps());
  app.route("/", adminApp);

  return app;
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

const port = Number.parseInt(
  process.env.ADMIN_E2E_PORT ?? String(ADMIN_E2E_PORT),
  10,
);

// Re-read secret at runtime in case it was overridden via env
const app = buildTestApp();
Bun.serve({ port, fetch: app.fetch });
console.log(
  `[admin-e2e-server] Test server running on http://localhost:${port}`,
);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
