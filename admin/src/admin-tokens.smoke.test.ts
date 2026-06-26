/**
 * admin/src/admin-tokens.smoke.test.ts
 * Smoke tests for the /admin/tokens proxy routes.
 *
 * Uses app.request() — no real server, no real task-store.
 * The three task-store fetchers are injected as in-memory doubles.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import { createAdminUIApp } from "./admin-ui.ts";
import type { AdminUIDeps, AdminUISlackClient } from "./admin-ui.ts";
import type { GoogleAuthClient } from "./google-auth-client.ts";

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const AGENT_ID = "agent-test-123";
const TOKEN_ID = "ts-token-abc";

const MOCK_TS_TOKEN = {
  id: TOKEN_ID,
  label: "ci-token",
  agentId: AGENT_ID,
  token: "hashed",
  createdAt: new Date("2024-01-01"),
  revokedAt: null,
};

async function makeSessionCookie(): Promise<string> {
  return sign(
    {
      userId: "google-sub-123",
      email: "admin@example.com",
      isAdmin: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SESSION_SECRET,
    "HS256",
  );
}

const BASE_SLACK_CLIENT: AdminUISlackClient = {
  createAppManifest: async () => ({
    appId: "A123456",
    oauthRedirectUrl: "https://slack.com/oauth/authorize?client_id=123",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    signingSecret: "test-signing-secret",
  }),
  updateAppManifest: async () => {},
  exchangeOAuthCode: async () => ({ botToken: "xoxb-mock" }),
};

function makeGoogleClient(): GoogleAuthClient {
  return {
    exchangeCode: async () => ({
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      expiresIn: 3600,
    }),
    getUserInfo: async () => ({
      sub: "google-sub-123",
      email: "admin@example.com",
      email_verified: true,
      name: "Admin User",
    }),
  };
}

function makeMockDeps(overrides?: Partial<AdminUIDeps>): AdminUIDeps {
  return {
    prisma: {
      agent: {
        findMany: async () => [
          {
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
          },
        ],
        findUnique: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        create: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        update: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        delete: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
      },
      agentPlugin: { findMany: async () => [] },
      agentMember: {
        findMany: async () => [],
        findUnique: async () => null,
        create: async () => ({ id: "m1", agentId: AGENT_ID, email: "m@example.com" }),
        deleteMany: async () => ({ count: 0 }),
      },
    },
    agentEnvService: {
      getByAgentId: async () => ({}),
      upsert: async () => {},
      deleteKey: async () => {},
      getConfigBundle: async () => null,
    },
    agentCronJobService: {
      list: async () => [],
      listWithRunSummary: async () => [],
      get: async () => ({
        id: "c1", agentId: AGENT_ID, schedule: "0 * * * *", prompt: "test",
        channel: "C1", user: null, enabled: true, name: null, system: false,
        silent: false, preCheck: null, createdAt: new Date("2024-01-01"), updatedAt: new Date("2024-01-01"),
      }),
      create: async () => ({
        id: "c1",
        agentId: AGENT_ID,
        schedule: "0 * * * *",
        prompt: "test",
        channel: "C1",
        user: null,
        enabled: true,
        name: null,
        system: false,
        silent: false,
        preCheck: null,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      }),
      setEnabled: async () => ({
        id: "c1", agentId: AGENT_ID, schedule: "0 * * * *", prompt: "test",
        channel: "C1", user: null, enabled: true, name: null, system: false,
        silent: false, preCheck: null, createdAt: new Date("2024-01-01"), updatedAt: new Date("2024-01-01"),
      }),
      update: async () => ({
        id: "c1", agentId: AGENT_ID, schedule: "0 * * * *", prompt: "test",
        channel: "C1", user: null, enabled: true, name: null, system: false,
        silent: false, preCheck: null, createdAt: new Date("2024-01-01"), updatedAt: new Date("2024-01-01"),
      }),
      delete: async () => {},
      reconcileSystemCrons: async () => ({ created: 0, updated: 0, deleted: 0 }),
    },
    agentToolService: {
      list: async () => [],
      add: async () => ({ id: "t1", agentId: AGENT_ID, pattern: "*", enabled: true, createdAt: new Date("2024-01-01"), updatedAt: new Date("2024-01-01") }),
      toggle: async () => ({ id: "t1", agentId: AGENT_ID, pattern: "*", enabled: false, createdAt: new Date("2024-01-01"), updatedAt: new Date("2024-01-01") }),
      remove: async () => {},
    },
    agentTokenService: {
      listForAgent: async () => [],
      create: async () => ({
        token: { id: "tok1", agentId: AGENT_ID, token: "h", label: null, createdAt: new Date("2024-01-01"), revokedAt: null },
        rawToken: "raw123",
      }),
      revoke: async () => null,
    },
    agentPluginService: { list: async () => [] },
    provisioner: {
      provision: async () => ({ resourceName: "r", secretName: "s", deploymentName: "d" }),
      deprovision: async () => {},
      reconcile: async () => ({ recreated: [], updated: [], orphans: [], failed: [] }),
    },
    sessionSecret: SESSION_SECRET,
    googleClientId: "test-google-client-id",
    googleClientSecret: "test-google-client-secret",
    adminAllowedEmails: ["admin@example.com"],
    googleClient: makeGoogleClient(),
    slackClient: BASE_SLACK_CLIENT,
    appBaseUrl: "https://example.com",
    ...overrides,
  };
}

describe("admin UI — /admin/tokens routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  // ─── GET /admin/tokens ────────────────────────────────────────────────────

  it("GET /admin/tokens returns 200 with token list when adminListTokens is wired", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        adminListTokens: async () => [MOCK_TS_TOKEN],
      }),
    );
    const res = await app.request("/admin/tokens", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("ci-token");
    expect(html).toContain("Tokens");
  });

  it("GET /admin/tokens returns 200 in degraded mode when adminListTokens is absent", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/tokens", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("unavailable");
  });

  it("GET /admin/tokens unauthenticated redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/tokens");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });

  it("GET /admin/tokens returns 403 for non-admin user", async () => {
    const nonAdminCookie = await sign(
      { userId: "u2", email: "user@example.com", isAdmin: false, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
      SESSION_SECRET,
      "HS256",
    );
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/tokens", {
      headers: { Cookie: `admin_session=${nonAdminCookie}` },
    });
    expect(res.status).toBe(403);
  });

  // ─── POST /admin/tokens ───────────────────────────────────────────────────

  it("POST /admin/tokens creates token and renders success page with rawToken", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        adminCreateToken: async () => ({ ...MOCK_TS_TOKEN, rawToken: "sw_raw_abc123" }),
      }),
    );
    const body = new URLSearchParams({ label: "ci-token" });
    const res = await app.request("/admin/tokens", {
      method: "POST",
      headers: {
        Cookie: `admin_session=${cookie}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("sw_raw_abc123");
  });

  it("POST /admin/tokens redirects with error when label is empty", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        adminCreateToken: async () => ({ ...MOCK_TS_TOKEN, rawToken: "sw_raw_abc123" }),
      }),
    );
    const body = new URLSearchParams({ label: "" });
    const res = await app.request("/admin/tokens", {
      method: "POST",
      headers: {
        Cookie: `admin_session=${cookie}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/admin/tokens?error=");
  });

  it("POST /admin/tokens returns 503 when adminCreateToken is absent", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ label: "my-token" });
    const res = await app.request("/admin/tokens", {
      method: "POST",
      headers: {
        Cookie: `admin_session=${cookie}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    expect(res.status).toBe(503);
  });

  // ─── POST /admin/tokens/:id/revoke ────────────────────────────────────────

  it("POST /admin/tokens/:id/revoke calls adminRevokeToken and redirects to list", async () => {
    let revokedId: string | undefined;
    const app = createAdminUIApp(
      makeMockDeps({
        adminRevokeToken: async (id: string) => {
          revokedId = id;
        },
      }),
    );
    const res = await app.request(`/admin/tokens/${TOKEN_ID}/revoke`, {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/tokens");
    expect(revokedId).toBe(TOKEN_ID);
  });

  it("POST /admin/tokens/:id/revoke returns 503 when adminRevokeToken is absent", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/tokens/${TOKEN_ID}/revoke`, {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(503);
  });

  // ─── Agent pre-select ─────────────────────────────────────────────────────

  it("GET /admin/tokens?agentId=agent-test-123 pre-selects agent in dropdown", async () => {
    const app = createAdminUIApp(makeMockDeps({ adminListTokens: async () => [] }));
    const res = await app.request("/admin/tokens?agentId=agent-test-123", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('value="agent-test-123" selected');
  });

  // ─── Env block in success banner ──────────────────────────────────────────

  it("POST /admin/tokens success renders env block with taskStoreBaseUrl", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        adminCreateToken: async () => ({ ...MOCK_TS_TOKEN, rawToken: "sw_raw_abc123" }),
        taskStoreBaseUrl: "https://tasks.example.com",
      }),
    );
    const body = new URLSearchParams({ label: "ci-token" });
    const res = await app.request("/admin/tokens", {
      method: "POST",
      headers: {
        Cookie: `admin_session=${cookie}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("SHIPWRIGHT_TASK_STORE_URL=https://tasks.example.com");
    expect(html).toContain("SHIPWRIGHT_TASK_STORE_TOKEN=sw_raw_abc123");
  });
});
