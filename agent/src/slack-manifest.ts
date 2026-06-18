/**
 * agent/src/slack-manifest.ts
 * Typed Slack app manifest builder for programmatic app creation.
 *
 * Used by agent/scripts/bootstrap-agent.ts to generate a per-agent manifest
 * before calling the Slack Manifest API (apps.manifest.create).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface SlackManifestOauthConfig {
  scopes: {
    bot: string[];
  };
  redirect_urls: string[];
}

interface SlackManifestEventSubscriptions {
  bot_events: string[];
}

interface SlackManifestSettings {
  org_deploy_enabled: boolean;
  socket_mode_enabled: boolean;
  token_rotation_enabled: boolean;
  event_subscriptions: SlackManifestEventSubscriptions;
}

interface SlackManifestAssistantView {
  assistant_description: string;
  suggested_prompts: { title: string; message: string }[];
}

interface SlackManifestFeatures {
  app_home: {
    home_tab_enabled: boolean;
    messages_tab_enabled: boolean;
    messages_tab_read_only_enabled: boolean;
  };
  bot_user: {
    display_name: string;
    always_online: boolean;
  };
  assistant_view: SlackManifestAssistantView;
}

interface SlackManifestDisplayInformation {
  name: string;
  description: string;
  background_color: string;
}

export interface SlackManifest {
  display_information: SlackManifestDisplayInformation;
  features: SlackManifestFeatures;
  oauth_config: SlackManifestOauthConfig;
  settings: SlackManifestSettings;
}

// ─── Default scopes ───────────────────────────────────────────────────────────

export const DEFAULT_BOT_SCOPES: string[] = [
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
  "reactions:read",
  "reactions:write",
  "users:read",
];

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * Builds a Slack app manifest for a given agent name and scope list.
 *
 * @param agentName     Human-readable name for the Slack app (e.g. "My Agent")
 * @param scopesOrOpts  Extra scopes array or options object with `botName`,
 *                      `scopes`, and/or `redirectUrl`. Defaults to DEFAULT_BOT_SCOPES.
 * @returns             A fully-typed SlackManifest object ready to serialize to JSON.
 */
export function buildManifest(
  agentName: string,
  scopesOrOpts?:
    | string[]
    | { botName?: string; scopes?: string[]; redirectUrl?: string },
): SlackManifest {
  const opts = Array.isArray(scopesOrOpts)
    ? { scopes: scopesOrOpts }
    : (scopesOrOpts ?? {});
  const scopes = opts.scopes ?? [];
  const botName = opts.botName;
  const redirectUrl = Array.isArray(scopesOrOpts)
    ? undefined
    : opts.redirectUrl;
  const allScopes = Array.from(new Set([...DEFAULT_BOT_SCOPES, ...scopes]));

  return {
    display_information: {
      name: agentName,
      description: `${agentName} — powered by Shipwright`,
      background_color: "#1a1a2e",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: botName ?? agentName,
        always_online: true,
      },
      assistant_view: {
        assistant_description: `${agentName} — powered by Shipwright`,
        suggested_prompts: [],
      },
    },
    oauth_config: {
      scopes: {
        bot: allScopes,
      },
      redirect_urls: [redirectUrl ?? "http://localhost:3460"],
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
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
