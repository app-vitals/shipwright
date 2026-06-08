/**
 * agent/src/admin-ui.integration.test.ts
 * Integration tests for SlackProvisionService.
 *
 * Uses in-memory recorded doubles — no real Slack API calls.
 * Runs unconditionally (no database needed either).
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  SlackProvisionService,
  type SlackProvisionClient,
  type SlackManifest,
  type CreateAppResult,
} from "./slack-provision.ts";
import type { AgentEnvService } from "./agent-envs.ts";

// ─── Recorded doubles ─────────────────────────────────────────────────────────

class RecordedSlackClient implements SlackProvisionClient {
  createAppCalls: { token: string; manifest: SlackManifest }[] = [];
  exchangeCodeCalls: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }[] = [];

  private shouldFailCreateApp = false;
  private shouldFailExchange = false;

  failOnCreateApp() {
    this.shouldFailCreateApp = true;
  }

  failOnExchangeCode() {
    this.shouldFailExchange = true;
  }

  async createApp(
    token: string,
    manifest: SlackManifest,
  ): Promise<CreateAppResult> {
    this.createAppCalls.push({ token, manifest });
    if (this.shouldFailCreateApp) {
      throw new Error("invalid_auth: token not valid");
    }
    return {
      appId: "A123456789",
      clientId: "123456789.987654321",
      clientSecret: "slack-client-secret-abc",
      signingSecret: "slack-signing-secret-xyz",
      oauthUrl:
        "https://slack.com/oauth/v2/authorize?state=nonce123&client_id=123456789.987654321&scope=app_mentions%3Aread%2Cchat%3Awrite%2Cim%3Ahistory",
    };
  }

  async exchangeCode(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<{ botToken: string; appId: string }> {
    this.exchangeCodeCalls.push({ clientId, clientSecret, code, redirectUri });
    if (this.shouldFailExchange) {
      throw new Error("invalid_code");
    }
    return {
      botToken: "xoxb-recorded-bot-token",
      appId: "A123456789",
    };
  }
}

class RecordedEnvService
  implements Pick<AgentEnvService, "patch" | "getByAgentId">
{
  patchCalls: { agentId: string; env: Record<string, string> }[] = [];

  async patch(agentId: string, env: Record<string, string>): Promise<void> {
    this.patchCalls.push({ agentId, env: { ...env } });
  }

  async getByAgentId(agentId: string): Promise<Record<string, string> | null> {
    const patches = this.patchCalls
      .filter((c) => c.agentId === agentId)
      .map((c) => c.env);
    if (patches.length === 0) return null;
    return Object.assign({}, ...patches) as Record<string, string>;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SlackProvisionService.startOAuth (integration)", () => {
  let slackClient: RecordedSlackClient;
  let envService: RecordedEnvService;
  let service: SlackProvisionService;

  const AGENT_ID = "agent-provision-test";
  const XOXP_TOKEN = "xoxp-valid-user-token";
  const REDIRECT_URI = "https://example.com/admin/oauth/slack/callback";

  beforeEach(() => {
    slackClient = new RecordedSlackClient();
    envService = new RecordedEnvService();
    service = new SlackProvisionService(slackClient, envService);
  });

  it("calls createApp with the correct manifest and xoxp token", async () => {
    await service.startOAuth(AGENT_ID, XOXP_TOKEN, REDIRECT_URI);

    expect(slackClient.createAppCalls).toHaveLength(1);
    const call = slackClient.createAppCalls[0];
    if (!call) throw new Error("Expected createApp to have been called");
    expect(call.token).toBe(XOXP_TOKEN);

    // Manifest should have the expected structure
    const { manifest } = call;
    expect(manifest.settings?.socket_mode_enabled).toBe(true);
    expect(manifest.oauth_config?.scopes?.bot).toContain("app_mentions:read");
    expect(manifest.oauth_config?.scopes?.bot).toContain("chat:write");
    expect(manifest.oauth_config?.scopes?.bot).toContain("im:history");
  });

  it("stores SLACK_APP_ID and SLACK_SIGNING_SECRET in AgentEnv after createApp", async () => {
    await service.startOAuth(AGENT_ID, XOXP_TOKEN, REDIRECT_URI);

    // Should have called patch with SLACK_APP_ID and SLACK_SIGNING_SECRET
    const patchCall = envService.patchCalls.find((c) => c.agentId === AGENT_ID);
    expect(patchCall).toBeDefined();
    expect(patchCall?.env.SLACK_APP_ID).toBe("A123456789");
    expect(patchCall?.env.SLACK_SIGNING_SECRET).toBe("slack-signing-secret-xyz");
  });

  it("returns the OAuth redirect URL from createApp result", async () => {
    const url = await service.startOAuth(AGENT_ID, XOXP_TOKEN, REDIRECT_URI);

    expect(url).toContain("slack.com/oauth/v2/authorize");
    expect(url).toContain("client_id=");
  });

  it("propagates error when Slack client throws on createApp", async () => {
    slackClient.failOnCreateApp();

    await expect(
      service.startOAuth(AGENT_ID, XOXP_TOKEN, REDIRECT_URI),
    ).rejects.toThrow("invalid_auth");
  });
});

describe("SlackProvisionService.handleCallback (integration)", () => {
  let slackClient: RecordedSlackClient;
  let envService: RecordedEnvService;
  let service: SlackProvisionService;

  const AGENT_ID = "agent-provision-test";
  const REDIRECT_URI = "https://example.com/admin/oauth/slack/callback";
  const CLIENT_ID = "123456789.987654321";
  const CLIENT_SECRET = "slack-client-secret-abc";

  beforeEach(() => {
    slackClient = new RecordedSlackClient();
    envService = new RecordedEnvService();
    // Seed the env service with the app credentials (as would be set by startOAuth)
    envService.patchCalls.push({
      agentId: AGENT_ID,
      env: {
        SLACK_APP_ID: "A123456789",
        SLACK_SIGNING_SECRET: "slack-signing-secret-xyz",
        SLACK_CLIENT_ID: CLIENT_ID,
        SLACK_CLIENT_SECRET: CLIENT_SECRET,
      },
    });
    service = new SlackProvisionService(slackClient, envService, CLIENT_ID, CLIENT_SECRET);
  });

  it("exchanges code and returns bot token", async () => {
    const botToken = await service.handleCallback(
      AGENT_ID,
      "oauth-code-123",
      REDIRECT_URI,
    );

    expect(botToken).toBe("xoxb-recorded-bot-token");
    expect(slackClient.exchangeCodeCalls).toHaveLength(1);
    expect(slackClient.exchangeCodeCalls[0]?.code).toBe("oauth-code-123");
    expect(slackClient.exchangeCodeCalls[0]?.redirectUri).toBe(REDIRECT_URI);
  });

  it("stores SLACK_BOT_TOKEN in AgentEnv after successful exchange", async () => {
    await service.handleCallback(AGENT_ID, "oauth-code-123", REDIRECT_URI);

    // Find a patch call after the initial seed that contains SLACK_BOT_TOKEN
    const botTokenPatch = envService.patchCalls.find(
      (c) => c.agentId === AGENT_ID && c.env.SLACK_BOT_TOKEN,
    );
    expect(botTokenPatch).toBeDefined();
    expect(botTokenPatch?.env.SLACK_BOT_TOKEN).toBe("xoxb-recorded-bot-token");
  });

  it("propagates error when exchange fails", async () => {
    slackClient.failOnExchangeCode();

    await expect(
      service.handleCallback(AGENT_ID, "bad-code", REDIRECT_URI),
    ).rejects.toThrow("invalid_code");
  });
});
