/**
 * agent/src/slack-provisioning-client.ts
 * SlackProvisioningClient interface and HttpSlackProvisioningClient implementation.
 *
 * Used during the one-time agent provisioning flow:
 *   1. apps.manifest.create — creates the Slack app from a manifest
 *
 * Note: signing secret exchange is intentionally omitted. Slack's oauth.v2.access
 * does not return the signing secret, and apps.auth.external.get requires admin
 * scopes not available in the user token flow. The provisioning UI collects it
 * via a paste form instead.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AppManifestDisplayInfo {
  name: string;
  description?: string;
  long_description?: string;
  background_color?: string;
}

export interface AppManifestBotUser {
  display_name: string;
  always_online?: boolean;
}

export interface AppManifestOAuthConfig {
  scopes: {
    bot?: string[];
    user?: string[];
  };
  redirect_urls?: string[];
}

export interface AppManifestSettings {
  event_subscriptions?: {
    bot_events?: string[];
  };
  interactivity?: {
    is_enabled: boolean;
    request_url?: string;
  };
  org_deploy_enabled?: boolean;
  socket_mode_enabled?: boolean;
}

export interface AppManifest {
  display_information: AppManifestDisplayInfo;
  features?: {
    app_home?: {
      home_tab_enabled?: boolean;
      messages_tab_enabled?: boolean;
      messages_tab_read_only_enabled?: boolean;
    };
    bot_user?: AppManifestBotUser;
  };
  oauth_config?: AppManifestOAuthConfig;
  settings?: AppManifestSettings;
}

// ─── Interface ────────────────────────────────────────────────────────────────

export interface SlackProvisioningClient {
  /**
   * Call apps.manifest.create with the given xoxp- user token and manifest.
   * Returns the new app's ID and the OAuth redirect URL for the next step.
   */
  createAppManifest(
    xoxpToken: string,
    manifest: AppManifest,
  ): Promise<{ appId: string; oauthRedirectUrl: string }>;
}

// ─── Default manifest ─────────────────────────────────────────────────────────

/**
 * Default Slack app manifest for a Shipwright agent.
 * Scopes allow the agent to post messages, read channel history, and send DMs.
 */
export function defaultAgentManifest(
  appName: string,
  redirectUri: string,
): AppManifest {
  return {
    display_information: {
      name: appName,
      description: "Shipwright autonomous agent",
      background_color: "#1a1a2e",
    },
    features: {
      bot_user: {
        display_name: appName,
        always_online: false,
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          "channels:history",
          "channels:read",
          "chat:write",
          "groups:history",
          "groups:read",
          "im:history",
          "im:read",
          "im:write",
          "mpim:history",
          "users:read",
        ],
      },
      redirect_urls: [redirectUri],
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
    },
  };
}

// ─── HTTP implementation ──────────────────────────────────────────────────────

/**
 * Production implementation — calls real Slack API endpoints.
 *
 * The constructor takes optional Slack API URL overrides for testing/staging.
 */
export class HttpSlackProvisioningClient implements SlackProvisioningClient {
  private readonly apiBase: string;

  constructor(opts?: { apiBase?: string }) {
    this.apiBase = opts?.apiBase ?? "https://slack.com/api";
  }

  async createAppManifest(
    xoxpToken: string,
    manifest: AppManifest,
  ): Promise<{ appId: string; oauthRedirectUrl: string }> {
    const url = `${this.apiBase}/apps.manifest.create`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${xoxpToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ manifest: JSON.stringify(manifest) }),
    });

    if (!resp.ok) {
      throw new Error(
        `Slack apps.manifest.create HTTP error: ${resp.status} ${resp.statusText}`,
      );
    }

    const data = (await resp.json()) as {
      ok: boolean;
      error?: string;
      app_id?: string;
      oauth_authorize_url?: string;
    };

    if (!data.ok) {
      throw new Error(`Slack apps.manifest.create failed: ${data.error}`);
    }

    if (!data.app_id || !data.oauth_authorize_url) {
      throw new Error(
        "Slack apps.manifest.create response missing app_id or oauth_authorize_url",
      );
    }

    return {
      appId: data.app_id,
      oauthRedirectUrl: data.oauth_authorize_url,
    };
  }
}
