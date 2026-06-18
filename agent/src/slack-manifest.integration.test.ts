/**
 * Tests for agent/src/slack-manifest.ts
 *
 * Named .integration.test.ts to match vitals-os convention — the function
 * is technically pure (no I/O), but the test file follows the same naming
 * pattern used in the vitals-os source for consistency.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BOT_SCOPES,
  type SlackManifest,
  buildManifest,
} from "./slack-manifest";

// ─── buildManifest structure ──────────────────────────────────────────────────

describe("buildManifest — structure", () => {
  test("returns a manifest with display_information", () => {
    const m = buildManifest("Test Agent");
    expect(m.display_information).toBeDefined();
    expect(m.display_information.name).toBe("Test Agent");
  });

  test("description includes agent name", () => {
    const m = buildManifest("okWOW Agent");
    expect(m.display_information.description).toContain("okWOW Agent");
  });

  test("background_color is set", () => {
    const m = buildManifest("Test Agent");
    expect(m.display_information.background_color).toBe("#1a1a2e");
  });

  test("bot_user display_name matches agentName", () => {
    const m = buildManifest("My Agent");
    expect(m.features.bot_user.display_name).toBe("My Agent");
  });

  test("bot_user always_online is true", () => {
    const m = buildManifest("Test Agent");
    expect(m.features.bot_user.always_online).toBe(true);
  });

  test("socket_mode_enabled is true", () => {
    const m = buildManifest("Test Agent");
    expect(m.settings.socket_mode_enabled).toBe(true);
  });

  test("org_deploy_enabled is false", () => {
    const m = buildManifest("Test Agent");
    expect(m.settings.org_deploy_enabled).toBe(false);
  });

  test("token_rotation_enabled is false", () => {
    const m = buildManifest("Test Agent");
    expect(m.settings.token_rotation_enabled).toBe(false);
  });

  test("messages_tab_enabled is true", () => {
    const m = buildManifest("Test Agent");
    expect(m.features.app_home.messages_tab_enabled).toBe(true);
  });

  test("oauth_config.redirect_urls includes localhost callback", () => {
    const m = buildManifest("Test Agent");
    expect(m.oauth_config.redirect_urls).toEqual(["http://localhost:3460"]);
  });
});

// ─── redirectUrl ──────────────────────────────────────────────────────────────

describe("buildManifest — redirectUrl", () => {
  test("defaults to http://localhost:3460 when redirectUrl omitted", () => {
    const m = buildManifest("Test Agent");
    expect(m.oauth_config.redirect_urls).toEqual(["http://localhost:3460"]);
  });

  test("uses provided redirectUrl when specified", () => {
    const m = buildManifest("Test Agent", {
      redirectUrl: "https://example.com/oauth/callback",
    });
    expect(m.oauth_config.redirect_urls).toEqual([
      "https://example.com/oauth/callback",
    ]);
  });

  test("redirectUrl is the sole entry in redirect_urls", () => {
    const m = buildManifest("Test Agent", {
      redirectUrl: "https://example.com/oauth/callback",
    });
    expect(m.oauth_config.redirect_urls.length).toBe(1);
  });

  test("redirectUrl works alongside botName and scopes", () => {
    const m = buildManifest("Test Agent", {
      botName: "test-bot",
      scopes: ["channels:history"],
      redirectUrl: "https://example.com/oauth/callback",
    });
    expect(m.oauth_config.redirect_urls).toEqual([
      "https://example.com/oauth/callback",
    ]);
    expect(m.features.bot_user.display_name).toBe("test-bot");
    expect(m.oauth_config.scopes.bot).toContain("channels:history");
  });

  test("legacy array form still defaults to http://localhost:3460", () => {
    const m = buildManifest("Test Agent", ["channels:history"]);
    expect(m.oauth_config.redirect_urls).toEqual(["http://localhost:3460"]);
  });
});

// ─── Agent/assistant configuration ────────────────────────────────────────────

describe("buildManifest — agent/assistant", () => {
  test("assistant_view is present (marks app as AI agent)", () => {
    const m = buildManifest("Test Agent");
    expect(m.features.assistant_view).toBeDefined();
  });

  test("assistant_description includes agent name", () => {
    const m = buildManifest("okWOW Agent");
    expect(m.features.assistant_view.assistant_description).toContain(
      "okWOW Agent",
    );
  });

  test("suggested_prompts defaults to empty array", () => {
    const m = buildManifest("Test Agent");
    expect(m.features.assistant_view.suggested_prompts).toEqual([]);
  });

  test("bot_events include assistant_thread_started", () => {
    const m = buildManifest("Test Agent");
    expect(m.settings.event_subscriptions.bot_events).toContain(
      "assistant_thread_started",
    );
  });

  test("bot_events include assistant_thread_context_changed", () => {
    const m = buildManifest("Test Agent");
    expect(m.settings.event_subscriptions.bot_events).toContain(
      "assistant_thread_context_changed",
    );
  });

  test("bot_events include message.channels", () => {
    const m = buildManifest("Test Agent");
    expect(m.settings.event_subscriptions.bot_events).toContain(
      "message.channels",
    );
  });

  test("bot_events include message.groups", () => {
    const m = buildManifest("Test Agent");
    expect(m.settings.event_subscriptions.bot_events).toContain(
      "message.groups",
    );
  });
});

// ─── Default scopes ───────────────────────────────────────────────────────────

describe("buildManifest — default scopes", () => {
  test("includes chat:write", () => {
    const m = buildManifest("Test Agent");
    expect(m.oauth_config.scopes.bot).toContain("chat:write");
  });

  test("includes reactions:write", () => {
    const m = buildManifest("Test Agent");
    expect(m.oauth_config.scopes.bot).toContain("reactions:write");
  });

  test("includes files:read", () => {
    const m = buildManifest("Test Agent");
    expect(m.oauth_config.scopes.bot).toContain("files:read");
  });

  test("includes channels:read", () => {
    const m = buildManifest("Test Agent");
    expect(m.oauth_config.scopes.bot).toContain("channels:read");
  });

  test("includes channels:history", () => {
    const m = buildManifest("Test Agent");
    expect(m.oauth_config.scopes.bot).toContain("channels:history");
  });

  test("includes groups:history", () => {
    const m = buildManifest("Test Agent");
    expect(m.oauth_config.scopes.bot).toContain("groups:history");
  });

  test("includes im:history", () => {
    const m = buildManifest("Test Agent");
    expect(m.oauth_config.scopes.bot).toContain("im:history");
  });

  test("includes im:write", () => {
    const m = buildManifest("Test Agent");
    expect(m.oauth_config.scopes.bot).toContain("im:write");
  });

  test("includes app_mentions:read", () => {
    const m = buildManifest("Test Agent");
    expect(m.oauth_config.scopes.bot).toContain("app_mentions:read");
  });

  test("all DEFAULT_BOT_SCOPES are present when no extras provided", () => {
    const m = buildManifest("Test Agent");
    for (const scope of DEFAULT_BOT_SCOPES) {
      expect(m.oauth_config.scopes.bot).toContain(scope);
    }
  });

  test("scope count matches DEFAULT_BOT_SCOPES when no extras provided", () => {
    const m = buildManifest("Test Agent");
    expect(m.oauth_config.scopes.bot.length).toBe(DEFAULT_BOT_SCOPES.length);
  });
});

// ─── Custom scopes ────────────────────────────────────────────────────────────

describe("buildManifest — custom scopes", () => {
  test("extra scopes are appended to bot scopes", () => {
    const m = buildManifest("Test Agent", ["channels:history", "groups:read"]);
    expect(m.oauth_config.scopes.bot).toContain("channels:history");
    expect(m.oauth_config.scopes.bot).toContain("groups:read");
  });

  test("default scopes are still present when extras provided", () => {
    const m = buildManifest("Test Agent", ["channels:history"]);
    for (const scope of DEFAULT_BOT_SCOPES) {
      expect(m.oauth_config.scopes.bot).toContain(scope);
    }
  });

  test("duplicate scopes are deduplicated", () => {
    // chat:write is already in defaults — passing it again should not duplicate
    const m = buildManifest("Test Agent", ["chat:write", "channels:history"]);
    const chatWriteCount = m.oauth_config.scopes.bot.filter(
      (s) => s === "chat:write",
    ).length;
    expect(chatWriteCount).toBe(1);
  });

  test("total scope count is defaults + unique extras", () => {
    const extras = ["groups:read", "links:read"];
    const m = buildManifest("Test Agent", extras);
    expect(m.oauth_config.scopes.bot.length).toBe(
      DEFAULT_BOT_SCOPES.length + extras.length,
    );
  });

  test("empty scopes array uses only defaults", () => {
    const m = buildManifest("Test Agent", []);
    expect(m.oauth_config.scopes.bot.length).toBe(DEFAULT_BOT_SCOPES.length);
  });
});

// ─── DEFAULT_BOT_SCOPES export ────────────────────────────────────────────────

describe("DEFAULT_BOT_SCOPES", () => {
  test("is an array", () => {
    expect(Array.isArray(DEFAULT_BOT_SCOPES)).toBe(true);
  });

  test("contains only strings", () => {
    for (const scope of DEFAULT_BOT_SCOPES) {
      expect(typeof scope).toBe("string");
    }
  });

  test("is non-empty", () => {
    expect(DEFAULT_BOT_SCOPES.length).toBeGreaterThan(0);
  });
});

// ─── Type safety ──────────────────────────────────────────────────────────────

describe("buildManifest — type compatibility", () => {
  test("result is assignable to SlackManifest type", () => {
    const m: SlackManifest = buildManifest("Test Agent");
    expect(m).toBeDefined();
  });
});
