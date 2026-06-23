/**
 * admin/src/slack-provisioning-client.unit.test.ts
 * Unit tests for buildAgentManifest. No I/O, no network — shape assertions only.
 */

import { describe, expect, it } from "bun:test";
import { buildAgentManifest } from "./slack-provisioning-client.ts";

const NAME = "test-agent";
const REDIRECT = "https://shipwright.example.com/admin/provision/complete";

describe("buildAgentManifest", () => {
  describe("buildAgentManifest without redirectUri (unit)", () => {
    const manifest = buildAgentManifest(NAME);

    it("sets socket_mode_enabled: true", () => {
      expect(manifest.settings?.socket_mode_enabled).toBe(true);
    });

    it("includes required bot events", () => {
      const events = manifest.settings?.event_subscriptions?.bot_events ?? [];
      expect(events).toContain("message.im");
      expect(events).toContain("message.channels");
      expect(events).toContain("message.groups");
      expect(events).toContain("app_mention");
      expect(events).toContain("assistant_thread_started");
      expect(events).toContain("assistant_thread_context_changed");
      expect(events).toContain("reaction_added");
    });

    it("includes assistant_view", () => {
      expect(manifest.features?.assistant_view).toBeDefined();
      expect(manifest.features?.assistant_view?.assistant_description).toContain(NAME);
    });

    it("sets always_online: true", () => {
      expect(manifest.features?.bot_user?.always_online).toBe(true);
    });

    it("includes required scopes", () => {
      const scopes = manifest.oauth_config?.scopes.bot ?? [];
      expect(scopes).toContain("assistant:write");
      expect(scopes).toContain("app_mentions:read");
      expect(scopes).toContain("im:history");
      expect(scopes).toContain("mpim:history");
      expect(scopes).toContain("channels:history");
      expect(scopes).toContain("groups:history");
      expect(scopes).toContain("chat:write");
    });

    it("omits redirect_urls when no redirectUri provided", () => {
      expect(manifest.oauth_config?.redirect_urls).toBeUndefined();
    });

    it("uses agent name in display_information", () => {
      expect(manifest.display_information.name).toBe(NAME);
      expect(manifest.display_information.description).toContain(NAME);
    });
  });

  describe("provisioning (with redirectUri)", () => {
    const manifest = buildAgentManifest(NAME, REDIRECT);

    it("sets redirect_urls to the provided URI", () => {
      expect(manifest.oauth_config?.redirect_urls).toEqual([REDIRECT]);
    });

    it("still sets socket_mode_enabled: true", () => {
      expect(manifest.settings?.socket_mode_enabled).toBe(true);
    });

    it("still includes assistant_view", () => {
      expect(manifest.features?.assistant_view).toBeDefined();
    });
  });
});
