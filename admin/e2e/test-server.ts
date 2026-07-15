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

import { Hono } from "hono";
import { sign } from "hono/jwt";
import { createAdminUIApp } from "../src/admin-ui.ts";
import type { AdminUIDeps } from "../src/admin-ui.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

export const ADMIN_E2E_PORT = 3490;
export const ADMIN_E2E_SESSION_SECRET =
  process.env.ADMIN_E2E_SESSION_SECRET ?? "e2e-admin-test-secret-32chars!!!";
export const SESSION_COOKIE = "admin_session";

export const ADMIN_E2E_AGENT = {
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
      // these e2e tests omit an `isAdmin` claim, and getSessionUser treats a
      // missing claim as admin (isAdmin !== false) — so the render path always
      // takes the admin branch (prisma.agentMember.findMany), never the
      // non-admin findUnique branch. No members fixture exists, so both
      // resolve to empty/not-found.
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

// ─── Helper: mint a valid session JWT ────────────────────────────────────────

export async function mintAdminSession(
  userId = "google-sub-e2e",
  email = "admin@example.com",
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return sign(
    { userId, email, iat: nowSec, exp: nowSec + 3600 },
    ADMIN_E2E_SESSION_SECRET,
    "HS256",
  );
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
