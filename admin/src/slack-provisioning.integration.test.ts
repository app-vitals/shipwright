/**
 * agent/src/slack-provisioning.integration.test.ts
 * Integration tests for the Slack provisioning OAuth flow.
 *
 * Uses RecordedSlackClient with a cassette fixture to avoid live Slack API calls.
 * Services are injected as in-memory test doubles.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { sign } from "hono/jwt";
import { createAdminUIApp } from "./admin-ui.ts";
import type { AdminUIDeps, AdminUISlackClient } from "./admin-ui.ts";
import type { AppManifest } from "./slack-provisioning-client.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const AGENT_ID = "agent-test-123";

// ─── Cassette fixture ─────────────────────────────────────────────────────────

interface ProvisionCassette {
  createAppManifest: {
    appId: string;
    oauthRedirectUrl: string;
    clientId: string;
    clientSecret: string;
    signingSecret: string;
  };
}

class RecordedSlackClient implements AdminUISlackClient {
  private cassette: ProvisionCassette;

  constructor(cassettePath: string) {
    this.cassette = JSON.parse(readFileSync(cassettePath, "utf-8"));
  }

  async createAppManifest(
    _xoxpToken: string,
    _manifest: AppManifest,
  ): Promise<{
    appId: string;
    oauthRedirectUrl: string;
    clientId: string;
    clientSecret: string;
    signingSecret: string;
  }> {
    return this.cassette.createAppManifest;
  }

  async updateAppManifest(
    _xoxpToken: string,
    _appId: string,
    _manifest: AppManifest,
  ): Promise<void> {}

  async exchangeOAuthCode(
    _code: string,
    _clientId: string,
    _clientSecret: string,
    _redirectUri: string,
  ): Promise<{ botToken: string }> {
    return { botToken: "xoxb-test-cassette-bot-token" };
  }
}

// ─── JWT helper ───────────────────────────────────────────────────────────────

async function makeSessionCookie(secret = SESSION_SECRET): Promise<string> {
  return sign(
    {
      userId: "admin",
      email: "admin",
      isAdmin: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    "HS256",
  );
}

// ─── Track upserted env vars ──────────────────────────────────────────────────

interface UpsertCall {
  agentId: string;
  env: Record<string, string>;
}

// ─── Mock deps factory ────────────────────────────────────────────────────────

function makeMockDeps(
  slackClient: AdminUISlackClient,
  upsertCalls: UpsertCall[],
): AdminUIDeps {
  return {
    prisma: {
      agent: {
        findMany: async () => [],
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
      agentPlugin: {
        findMany: async () => [],
      },
      agentMember: {
        findMany: async () => [],
        findUnique: async () => null,
        create: async () => ({ id: "m1", agentId: AGENT_ID, email: "member@example.com" }),
        deleteMany: async () => ({ count: 0 }),
      },
    },
    agentEnvService: {
      getByAgentId: async () => ({}),
      upsert: async (agentId: string, env: Record<string, string>) => {
        upsertCalls.push({ agentId, env });
      },
      deleteKey: async () => {},
      getConfigBundle: async () => null,
    },
    agentCronJobService: {
      list: async () => [],
      listWithRunSummary: async () => [],
      get: async () => {
        throw new Error("not implemented");
      },
      create: async () => {
        throw new Error("not implemented");
      },
      setEnabled: async () => {
        throw new Error("not implemented");
      },
      update: async () => {
        throw new Error("not implemented");
      },
      delete: async () => {},
      reconcileSystemCrons: async () => ({ created: 0, updated: 0, deleted: 0 }),
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
      listForAgent: async () => [],
      create: async () => {
        throw new Error("not implemented");
      },
      revoke: async () => null,
    },
    agentPluginService: {
      list: async () => [],
    },
    sessionSecret: SESSION_SECRET,
    googleClientId: "test-google-client-id",
    googleClientSecret: "test-google-client-secret",
    adminAllowedEmails: ["admin@example.com"],
    googleClient: {
      exchangeCode: async () => ({
        accessToken: "test-access-token",
        expiresIn: 3600,
      }),
      getUserInfo: async () => ({
        sub: "google-sub-123",
        email: "admin@example.com",
        name: "Admin User",
      }),
    },
    slackClient,
    provisioner: {
      provision: async () => ({ resourceName: "r", secretName: "s", deploymentName: "d" }),
      deprovision: async () => {},
      reconcile: async () => ({ recreated: [], updated: [], orphans: [], failed: [] }),
    },
    appBaseUrl: "https://example.com",
  };
}

// ─── Provisioning flow tests ──────────────────────────────────────────────────

const CASSETTE_PATH = new URL(
  "./fixtures/slack-provision-cassette.json",
  import.meta.url,
).pathname;

describe("SlackProvisioningClient — cassette", () => {
  it("createAppManifest returns clientId, clientSecret, and signingSecret from cassette", async () => {
    const slackClient = new RecordedSlackClient(CASSETTE_PATH);
    const result = await slackClient.createAppManifest("xoxe.xoxp-fake", {} as AppManifest);
    expect(result.clientId).toBe("1234567890.9876543210");
    expect(result.clientSecret).toBe("test-client-secret-value");
    expect(result.signingSecret).toBe("test-signing-secret-value");
  });
});

describe("admin UI — provisioning flow", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/provision/start with xoxe.xoxp- token calls apps.manifest.create and returns OAuth URL", async () => {
    const upsertCalls: UpsertCall[] = [];
    const slackClient = new RecordedSlackClient(CASSETTE_PATH);
    const app = createAdminUIApp(makeMockDeps(slackClient, upsertCalls));

    const body = new URLSearchParams({
      agentId: AGENT_ID,
      xoxpToken: "xoxe.xoxp-1-fake-token-for-testing",
      ghAuthMode: "pat",
      ghPat: "ghp_test-pat-token",
    });
    const res = await app.request("/admin/provision/start", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Should contain the OAuth redirect URL from the cassette
    expect(html).toContain("https://slack.com/oauth/authorize");
  });

  it("POST /admin/provision/complete returns 404 (route removed in BP-2.2)", async () => {
    const upsertCalls: UpsertCall[] = [];
    const slackClient = new RecordedSlackClient(CASSETTE_PATH);
    const app = createAdminUIApp(makeMockDeps(slackClient, upsertCalls));

    const body = new URLSearchParams({
      agentId: AGENT_ID,
      appId: "A0123456789",
      signingSecret: "s3cr3t-signing-key-from-slack-dashboard",
    });
    const res = await app.request("/admin/provision/complete", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(404);
  });
});
