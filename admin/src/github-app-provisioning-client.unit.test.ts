/**
 * admin/src/github-app-provisioning-client.unit.test.ts
 * Unit tests for buildAgentAppManifest. No I/O, no network — shape assertions only.
 */

import { describe, expect, it } from "bun:test";
import { buildAgentAppManifest } from "./github-app-provisioning-client.ts";

const NAME = "test-agent";
const REDIRECT = "https://shipwright.example.com/admin/provision/complete";
const SETUP_URL = "https://shipwright.example.com/admin/provision/setup";

describe("buildAgentAppManifest", () => {
  describe("without redirectUri/setupUrl (unit)", () => {
    const manifest = buildAgentAppManifest(NAME);

    it("locks in exactly the four required permission scopes, no extras", () => {
      expect(manifest.default_permissions).toEqual({
        contents: "write",
        pull_requests: "write",
        actions: "read",
        workflows: "write",
      });
      expect(Object.keys(manifest.default_permissions).sort()).toEqual(
        ["actions", "contents", "pull_requests", "workflows"].sort(),
      );
    });

    it("sets public: false", () => {
      expect(manifest.public).toBe(false);
    });

    it("uses appName in the manifest name field", () => {
      expect(manifest.name).toBe(NAME);
    });

    it("omits redirect_url when no redirectUri provided", () => {
      expect(manifest.redirect_url).toBeUndefined();
    });

    it("omits setup_url when no setupUrl provided", () => {
      expect(manifest.setup_url).toBeUndefined();
    });

    it("does not add hook_attributes (no webhook receiver exists)", () => {
      expect(manifest).not.toHaveProperty("hook_attributes");
    });
  });

  describe("provisioning (with redirectUri and setupUrl)", () => {
    const manifest = buildAgentAppManifest(NAME, {
      redirectUri: REDIRECT,
      setupUrl: SETUP_URL,
    });

    it("wires redirectUri into redirect_url", () => {
      expect(manifest.redirect_url).toBe(REDIRECT);
    });

    it("wires setupUrl into setup_url", () => {
      expect(manifest.setup_url).toBe(SETUP_URL);
    });

    it("still locks in exactly the four required permission scopes", () => {
      expect(manifest.default_permissions).toEqual({
        contents: "write",
        pull_requests: "write",
        actions: "read",
        workflows: "write",
      });
    });

    it("still sets public: false", () => {
      expect(manifest.public).toBe(false);
    });
  });

  describe("provisioning with only redirectUri", () => {
    const manifest = buildAgentAppManifest(NAME, { redirectUri: REDIRECT });

    it("sets redirect_url", () => {
      expect(manifest.redirect_url).toBe(REDIRECT);
    });

    it("omits setup_url", () => {
      expect(manifest.setup_url).toBeUndefined();
    });
  });
});
