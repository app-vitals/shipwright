/**
 * agent/src/slack-provision.ts
 * Slack app provisioning via the Manifest API + OAuth flow.
 *
 * SlackProvisionClient — interface for Slack API calls (injectable for testing).
 * FetchSlackClient — real implementation using fetch().
 * SlackProvisionService — orchestrates app creation, env storage, and OAuth.
 */

import type { AgentEnvService } from "./agent-envs.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SlackManifest {
  display_information?: {
    name?: string;
    description?: string;
  };
  features?: {
    bot_user?: {
      display_name?: string;
      always_online?: boolean;
    };
  };
  oauth_config?: {
    scopes?: {
      bot?: string[];
    };
  };
  settings?: {
    socket_mode_enabled?: boolean;
    event_subscriptions?: {
      bot_events?: string[];
    };
    org_deploy_enabled?: boolean;
    token_rotation_enabled?: boolean;
  };
}

export interface CreateAppResult {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  oauthUrl: string;
}

// ─── Client interface ─────────────────────────────────────────────────────────

export interface SlackProvisionClient {
  /**
   * Create a Slack app from a manifest using a user OAuth token (xoxp-).
   * Returns the app credentials and an OAuth redirect URL.
   */
  createApp(xoxpToken: string, manifest: SlackManifest): Promise<CreateAppResult>;

  /**
   * Exchange an OAuth authorization code for a bot token.
   */
  exchangeCode(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<{ botToken: string; appId: string }>;
}

// ─── Default manifest ─────────────────────────────────────────────────────────

const DEFAULT_MANIFEST: SlackManifest = {
  display_information: {
    name: "Shipwright Agent",
    description: "Autonomous engineering agent",
  },
  features: {
    bot_user: {
      display_name: "Shipwright Agent",
      always_online: false,
    },
  },
  oauth_config: {
    scopes: {
      bot: ["app_mentions:read", "chat:write", "im:history"],
    },
  },
  settings: {
    socket_mode_enabled: true,
    event_subscriptions: {
      bot_events: ["app_mention", "message.im"],
    },
    org_deploy_enabled: false,
    token_rotation_enabled: false,
  },
};

// ─── Service ──────────────────────────────────────────────────────────────────

export class SlackProvisionService {
  constructor(
    private client: SlackProvisionClient,
    private envService: Pick<AgentEnvService, "patch" | "getByAgentId">,
    private clientId?: string,
    private clientSecret?: string,
  ) {}

  /**
   * Start the Slack OAuth flow for an agent.
   * 1. Calls apps.manifest.create with the xoxp token.
   * 2. Stores SLACK_APP_ID + SLACK_SIGNING_SECRET in AgentEnv.
   * 3. Returns the OAuth redirect URL.
   */
  async startOAuth(
    agentId: string,
    xoxpToken: string,
    _redirectUri: string,
  ): Promise<string> {
    const result = await this.client.createApp(xoxpToken, DEFAULT_MANIFEST);

    await this.envService.patch(agentId, {
      SLACK_APP_ID: result.appId,
      SLACK_SIGNING_SECRET: result.signingSecret,
      SLACK_CLIENT_ID: result.clientId,
      SLACK_CLIENT_SECRET: result.clientSecret,
    });

    return result.oauthUrl;
  }

  /**
   * Handle the Slack OAuth callback.
   * 1. Exchanges the code for a bot token.
   * 2. Stores SLACK_BOT_TOKEN in AgentEnv.
   * 3. Returns the bot token.
   */
  async handleCallback(
    agentId: string,
    code: string,
    redirectUri: string,
  ): Promise<string> {
    const clientId = this.clientId;
    const clientSecret = this.clientSecret;

    if (!clientId || !clientSecret) {
      // Try to read from env if not set at construction time
      const env = await this.envService.getByAgentId(agentId);
      const envClientId = env?.SLACK_CLIENT_ID;
      const envClientSecret = env?.SLACK_CLIENT_SECRET;
      if (!envClientId || !envClientSecret) {
        throw new Error(
          "SLACK_CLIENT_ID and SLACK_CLIENT_SECRET must be configured before handling OAuth callback",
        );
      }
      const { botToken } = await this.client.exchangeCode(
        envClientId,
        envClientSecret,
        code,
        redirectUri,
      );
      await this.envService.patch(agentId, { SLACK_BOT_TOKEN: botToken });
      return botToken;
    }

    const { botToken } = await this.client.exchangeCode(
      clientId,
      clientSecret,
      code,
      redirectUri,
    );

    await this.envService.patch(agentId, { SLACK_BOT_TOKEN: botToken });
    return botToken;
  }
}

// ─── Real fetch-based client ──────────────────────────────────────────────────

export class FetchSlackClient implements SlackProvisionClient {
  async createApp(
    xoxpToken: string,
    manifest: SlackManifest,
  ): Promise<CreateAppResult> {
    const res = await fetch("https://slack.com/api/apps.manifest.create", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${xoxpToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ manifest }),
    });

    if (!res.ok) {
      throw new Error(`Slack API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      app_id?: string;
      credentials?: {
        client_id?: string;
        client_secret?: string;
        signing_secret?: string;
        verification_token?: string;
      };
      oauth_authorize_url?: string;
    };

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error ?? "unknown"}`);
    }

    if (!data.app_id || !data.credentials || !data.oauth_authorize_url) {
      throw new Error("Slack API returned incomplete app creation response");
    }

    return {
      appId: data.app_id,
      clientId: data.credentials.client_id ?? "",
      clientSecret: data.credentials.client_secret ?? "",
      signingSecret: data.credentials.signing_secret ?? "",
      oauthUrl: data.oauth_authorize_url,
    };
  }

  async exchangeCode(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<{ botToken: string; appId: string }> {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    const res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      throw new Error(`Slack OAuth error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      access_token?: string;
      app_id?: string;
    };

    if (!data.ok) {
      throw new Error(`Slack OAuth error: ${data.error ?? "unknown"}`);
    }

    return {
      botToken: data.access_token ?? "",
      appId: data.app_id ?? "",
    };
  }
}
