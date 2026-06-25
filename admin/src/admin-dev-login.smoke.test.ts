/**
 * admin/src/admin-dev-login.smoke.test.ts
 *
 * Smoke tests for the GET /admin/dev-login route.
 * Uses app.request() — no real server, no real DB.
 */

import { describe, expect, it } from "bun:test";
import { verify } from "hono/jwt";
import type { GoogleAuthClient } from "./google-auth-client.ts";
import { createAdminUIApp } from "./admin-ui.ts";
import type { AdminUIDeps } from "./admin-ui.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const AGENT_ID = "agent-test-123";

// ─── Mock Google client ───────────────────────────────────────────────────────

function makeGoogleClient(): GoogleAuthClient {
  return {
    exchangeCode: () =>
      Promise.resolve({
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresIn: 3600,
      }),
    getUserInfo: () =>
      Promise.resolve({
        sub: "google-sub-123",
        email: "admin@example.com",
        email_verified: true,
        name: "Admin User",
      }),
  };
}

// ─── Mock deps ────────────────────────────────────────────────────────────────

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
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        create: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        update: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        delete: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
      },
      agentPlugin: {
        findMany: async () => [],
      },
      agentMember: {
        findMany: async () => [],
        findUnique: async () => null,
        create: async () => ({ id: "m1", agentId: "agent-123", email: "member@example.com" }),
        deleteMany: async () => ({ count: 0 }),
      },
    },
    agentEnvService: {
      getByAgentId: async () => ({ FOO: "bar" }),
      upsert: async () => {},
      deleteKey: async () => {},
      getConfigBundle: async () => null,
    },
    agentCronJobService: {
      list: async () => [],
      get: async () => {
        throw new Error("not found");
      },
      create: async () => {
        throw new Error("not found");
      },
      setEnabled: async () => {
        throw new Error("not found");
      },
      update: async () => {
        throw new Error("not found");
      },
      delete: async () => {},
      reconcileSystemCrons: async () => ({ created: 0, updated: 0, deleted: 0 }),
    },
    agentToolService: {
      list: async () => [],
      add: async () => {
        throw new Error("not found");
      },
      toggle: async () => {
        throw new Error("not found");
      },
      remove: async () => {},
    },
    agentTokenService: {
      listForAgent: async () => [],
      create: async () => {
        throw new Error("not found");
      },
      revoke: async () => {
        throw new Error("not found");
      },
    },
    agentPluginService: {
      list: async () => [],
    },
    sessionSecret: SESSION_SECRET,
    googleClientId: "test-google-client-id",
    googleClientSecret: "test-google-client-secret",
    adminAllowedEmails: ["admin@example.com"],
    googleClient: makeGoogleClient(),
    slackClient: {
      createAppManifest: async () => ({
        appId: "A123456",
        oauthRedirectUrl: "https://slack.com/oauth/authorize?client_id=123",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        signingSecret: "test-signing-secret",
      }),
      updateAppManifest: async () => {},
      exchangeOAuthCode: async () => ({ botToken: "xoxb-mock-bot-token" }),
    },
    provisioner: {
      provision: async () => ({ resourceName: "r", secretName: "s", deploymentName: "d" }),
      deprovision: async () => {},
      reconcile: async () => ({ recreated: [], updated: [], orphans: [], failed: [] }),
    },
    appBaseUrl: "https://example.com",
    devAuthEnabled: false,
    ...overrides,
  };
}

// ─── /admin/dev-login tests ───────────────────────────────────────────────────

describe("admin UI — GET /admin/dev-login", () => {
  it("returns 404 when devAuthEnabled=false (default)", async () => {
    const app = createAdminUIApp(makeMockDeps({ devAuthEnabled: false }));
    const res = await app.request("/admin/dev-login");
    expect(res.status).toBe(404);
  });

  it("returns 404 when devAuthEnabled is not set (default)", async () => {
    // Omit devAuthEnabled entirely — should still be blocked
    const deps = makeMockDeps();
    (deps as Partial<AdminUIDeps>).devAuthEnabled = undefined;
    const app = createAdminUIApp(deps);
    const res = await app.request("/admin/dev-login");
    expect(res.status).toBe(404);
  });

  it("happy path: devAuthEnabled=true → mints session cookie and redirects to /admin/agents", async () => {
    const app = createAdminUIApp(makeMockDeps({ devAuthEnabled: true }));
    const res = await app.request("/admin/dev-login");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents");

    const setCookieHeader = res.headers.get("Set-Cookie") ?? "";
    expect(setCookieHeader).toContain("admin_session=");
    expect(setCookieHeader).toContain("HttpOnly");
  });

  it("happy path: session cookie from /admin/dev-login is valid for /admin/agents", async () => {
    const app = createAdminUIApp(makeMockDeps({ devAuthEnabled: true }));

    // Step 1: GET /admin/dev-login → get session cookie
    const loginRes = await app.request("/admin/dev-login");
    expect(loginRes.status).toBe(302);

    // Extract session token from Set-Cookie header
    const setCookieHeader = loginRes.headers.get("Set-Cookie") ?? "";
    const match = setCookieHeader.match(/admin_session=([^;]+)/);
    expect(match).not.toBeNull();
    const sessionToken = match?.[1];

    // Step 2: GET /admin/agents with the session cookie → should be 200
    const agentsRes = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${sessionToken}` },
    });
    expect(agentsRes.status).toBe(200);
  });

  it("session token from dev-login has userId=dev and email=dev@localhost", async () => {
    const app = createAdminUIApp(makeMockDeps({ devAuthEnabled: true }));
    const loginRes = await app.request("/admin/dev-login");
    expect(loginRes.status).toBe(302);

    const setCookieHeader = loginRes.headers.get("Set-Cookie") ?? "";
    const match = setCookieHeader.match(/admin_session=([^;]+)/);
    expect(match).not.toBeNull();
    const sessionToken = decodeURIComponent(match?.[1] ?? "");

    const payload = (await verify(sessionToken, SESSION_SECRET, "HS256")) as Record<string, unknown>;
    expect(payload.userId).toBe("dev");
    expect(payload.email).toBe("dev@localhost");
  });
});
