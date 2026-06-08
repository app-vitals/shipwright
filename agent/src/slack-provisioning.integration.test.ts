/**
 * agent/src/slack-provisioning.integration.test.ts
 * Integration tests for the Slack provisioning OAuth flow.
 *
 * Uses RecordedSlackClient with a cassette fixture to avoid live Slack API calls.
 * Services are injected as in-memory test doubles.
 */

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import { createAdminUIApp } from "./admin-ui.ts";
import type { AdminUIDeps, SlackProvisioningClient } from "./admin-ui.ts";
import type { AppManifest } from "./slack-provisioning-client.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const ADMIN_PASSWORD = "correct-horse-battery-staple";
const AGENT_ID = "agent-test-123";

// ─── Cassette fixture ─────────────────────────────────────────────────────────

interface ProvisionCassette {
  createAppManifest: {
    appId: string;
    oauthRedirectUrl: string;
  };
  exchangeCodeForAppToken: {
    appId: string;
    signingSecret: string;
  };
}

class RecordedSlackClient implements SlackProvisioningClient {
  private cassette: ProvisionCassette;

  constructor(cassettePath: string) {
    this.cassette = JSON.parse(readFileSync(cassettePath, "utf-8"));
  }

  async createAppManifest(
    _xoxpToken: string,
    _manifest: AppManifest,
  ): Promise<{ appId: string; oauthRedirectUrl: string }> {
    return this.cassette.createAppManifest;
  }

  async exchangeCodeForAppToken(
    _code: string,
  ): Promise<{ appId: string; signingSecret: string }> {
    return this.cassette.exchangeCodeForAppToken;
  }
}

// ─── JWT helper ───────────────────────────────────────────────────────────────

async function makeSessionCookie(secret = SESSION_SECRET): Promise<string> {
  return sign(
    {
      userId: "admin",
      email: "admin",
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
  slackClient: SlackProvisioningClient,
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
        }),
        create: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        }),
      },
      agentPlugin: {
        findMany: async () => [],
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
    },
    agentToolService: {
      list: async () => [],
    },
    agentTokenService: {
      listForAgent: async () => [],
    },
    agentPluginService: {
      list: async () => [],
    },
    sessionSecret: SESSION_SECRET,
    adminPassword: ADMIN_PASSWORD,
    slackClient,
    appBaseUrl: "https://example.com",
  };
}

// ─── Provisioning flow tests ──────────────────────────────────────────────────

const CASSETTE_PATH = new URL(
  "./fixtures/slack-provision-cassette.json",
  import.meta.url,
).pathname;

describe("admin UI — provisioning flow", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/provision/start with xoxp- token calls apps.manifest.create and returns OAuth URL", async () => {
    const upsertCalls: UpsertCall[] = [];
    const slackClient = new RecordedSlackClient(CASSETTE_PATH);
    const app = createAdminUIApp(makeMockDeps(slackClient, upsertCalls));

    const body = new URLSearchParams({
      xoxpToken: "xoxp-fake-token-for-testing",
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

  it("GET /admin/provision/complete with valid code exchanges code and stores SLACK_APP_ID and SLACK_SIGNING_SECRET", async () => {
    const upsertCalls: UpsertCall[] = [];
    const slackClient = new RecordedSlackClient(CASSETTE_PATH);
    const app = createAdminUIApp(makeMockDeps(slackClient, upsertCalls));

    const res = await app.request(
      `/admin/provision/complete?code=fake-oauth-code&agentId=${AGENT_ID}`,
      {
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("success");

    // Verify env vars were stored
    expect(upsertCalls.length).toBeGreaterThan(0);
    const lastCall = upsertCalls[upsertCalls.length - 1];
    expect(lastCall.env).toHaveProperty("SLACK_APP_ID");
    expect(lastCall.env).toHaveProperty("SLACK_SIGNING_SECRET");
  });
});
