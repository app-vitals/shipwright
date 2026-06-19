/**
 * agent/src/slack-provisioning-client.ts
 * SlackProvisioningClient interface and HttpSlackProvisioningClient implementation.
 *
 * Used during the one-time agent provisioning flow:
 *   1. apps.manifest.create — creates the Slack app from a manifest
 *
 * apps.manifest.create returns credentials (client_id, client_secret, signing_secret)
 * directly in the response — no separate oauth.v2.access exchange needed.
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
    assistant_view?: {
      assistant_description?: string;
      suggested_prompts?: { title: string; message: string }[];
    };
  };
  oauth_config?: AppManifestOAuthConfig;
  settings?: AppManifestSettings;
}

// ─── Interface ────────────────────────────────────────────────────────────────

export interface SlackProvisioningClient {
  /**
   * Call apps.manifest.create with the given xoxp- user token and manifest.
   * Returns the new app's ID, OAuth redirect URL, and OAuth credentials.
   */
  createAppManifest(
    xoxpToken: string,
    manifest: AppManifest,
  ): Promise<{
    appId: string;
    oauthRedirectUrl: string;
    clientId: string;
    clientSecret: string;
    signingSecret: string;
  }>;

  /**
   * Call apps.manifest.update with the given xoxp- user token, app ID, and manifest.
   * Updates the manifest of an already-provisioned Slack app in-place.
   */
  updateAppManifest(
    xoxpToken: string,
    appId: string,
    manifest: AppManifest,
  ): Promise<void>;

  /**
   * Exchange an OAuth authorization code for a bot token via oauth.v2.access.
   */
  exchangeOAuthCode(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ): Promise<{ botToken: string }>;
}

// ─── Agent manifest ───────────────────────────────────────────────────────────

/**
 * Builds the Slack app manifest for a Shipwright agent.
 *
 * Used for both initial provisioning (pass redirectUri for the OAuth callback)
 * and subsequent manifest syncs (omit redirectUri to keep localhost default).
 * Socket Mode and the full event/assistant config are always applied — there
 * is no separate "provisioning-only" manifest.
 */
export function buildAgentManifest(
  appName: string,
  redirectUri?: string,
): AppManifest {
  return {
    display_information: {
      name: appName,
      description: `${appName} — powered by Shipwright`,
      background_color: "#1a1a2e",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: appName,
        always_online: true,
      },
      assistant_view: {
        assistant_description: `${appName} — powered by Shipwright`,
        suggested_prompts: [],
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "assistant:write",
          "channels:history",
          "channels:read",
          "chat:write",
          "files:read",
          "files:write",
          "groups:history",
          "im:history",
          "im:write",
          "mpim:history",
          "reactions:read",
          "reactions:write",
          "users:read",
        ],
      },
      ...(redirectUri !== undefined ? { redirect_urls: [redirectUri] } : {}),
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      event_subscriptions: {
        bot_events: [
          "app_mention",
          "assistant_thread_context_changed",
          "assistant_thread_started",
          "message.channels",
          "message.groups",
          "message.im",
          "reaction_added",
        ],
      },
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

  async exchangeOAuthCode(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ): Promise<{ botToken: string }> {
    const url = `${this.apiBase}/oauth.v2.access`;
    const params = new URLSearchParams({
      code,
      redirect_uri: redirectUri,
    });

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
      "base64",
    );
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!resp.ok) {
      throw new Error(
        `Slack oauth.v2.access HTTP error: ${resp.status} ${resp.statusText}`,
      );
    }

    const data = (await resp.json()) as {
      ok: boolean;
      error?: string;
      access_token?: string;
    };

    if (!data.ok) {
      throw new Error(`Slack oauth.v2.access failed: ${data.error}`);
    }

    if (!data.access_token) {
      throw new Error(
        "Slack oauth.v2.access response missing access_token",
      );
    }

    return { botToken: data.access_token };
  }

  async updateAppManifest(
    xoxpToken: string,
    appId: string,
    manifest: AppManifest,
  ): Promise<void> {
    const url = `${this.apiBase}/apps.manifest.update`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${xoxpToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ app_id: appId, manifest: JSON.stringify(manifest) }),
    });

    if (!resp.ok) {
      throw new Error(
        `Slack apps.manifest.update HTTP error: ${resp.status} ${resp.statusText}`,
      );
    }

    const data = (await resp.json()) as { ok: boolean; error?: string };

    if (!data.ok) {
      throw new Error(`Slack apps.manifest.update failed: ${data.error}`);
    }
  }

  async createAppManifest(
    xoxpToken: string,
    manifest: AppManifest,
  ): Promise<{
    appId: string;
    oauthRedirectUrl: string;
    clientId: string;
    clientSecret: string;
    signingSecret: string;
  }> {
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
      credentials?: {
        client_id?: string;
        client_secret?: string;
        signing_secret?: string;
      };
    };

    if (!data.ok) {
      throw new Error(`Slack apps.manifest.create failed: ${data.error}`);
    }

    if (!data.app_id || !data.oauth_authorize_url) {
      throw new Error(
        "Slack apps.manifest.create response missing app_id or oauth_authorize_url",
      );
    }

    if (
      !data.credentials?.client_id ||
      !data.credentials?.client_secret ||
      !data.credentials?.signing_secret
    ) {
      throw new Error(
        "Slack apps.manifest.create response missing credentials (client_id, client_secret, or signing_secret)",
      );
    }

    return {
      appId: data.app_id,
      oauthRedirectUrl: data.oauth_authorize_url,
      clientId: data.credentials.client_id,
      clientSecret: data.credentials.client_secret,
      signingSecret: data.credentials.signing_secret,
    };
  }
}
