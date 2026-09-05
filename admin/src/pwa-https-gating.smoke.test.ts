/**
 * admin/src/pwa-https-gating.smoke.test.ts
 * Confirms the manifest <link> and SW-registration <script> tags are
 * emitted site-wide only when appBaseUrl is https — home-lab operators on
 * plain HTTP must not see a broken manifest/SW registration attempt.
 * Exercised via a real rendered page (the login page, which needs no auth)
 * through app.request(), matching the Hono smoke-test convention.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminUIApp } from "./admin-ui.ts";
import type { AdminUIDeps } from "./admin-ui.ts";
import { PWA_ICONS } from "./pwa.ts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function makeFixtureIconsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pwa-icons-gate-"));
  const iconsDir = join(dir, "icons");
  mkdirSync(iconsDir, { recursive: true });
  for (const icon of PWA_ICONS) {
    writeFileSync(join(iconsDir, icon.filename), PNG_1X1);
  }
  return dir;
}

function makeMinimalDeps(overrides: Partial<AdminUIDeps>): AdminUIDeps {
  return {
    prisma: {
      agent: {
        findMany: async () => [],
        findUnique: async () => null,
        create: async () => {
          throw new Error("not implemented");
        },
        update: async () => {
          throw new Error("not implemented");
        },
        delete: async () => {
          throw new Error("not implemented");
        },
      },
      agentEnv: { findMany: async () => [] },
      agentPlugin: { findMany: async () => [] },
      agentMember: {
        findMany: async () => [],
        findUnique: async () => null,
        create: async () => {
          throw new Error("not implemented");
        },
        deleteMany: async () => ({ count: 0 }),
      },
    },
    agentEnvService: {
      getByAgentId: async () => null,
      upsert: async () => {},
      patch: async () => {},
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
      reconcileSystemCrons: async () => ({
        created: 0,
        updated: 0,
        deleted: 0,
      }),
    },
    agentCronRunService: {
      listForAgent: async () => ({ items: [], total: 0, limit: 20, offset: 0 }),
      listAcrossAgents: async () => ({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
      }),
    },
    agentWorkQueueService: { get: async () => null, getMany: async () => [] },
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
      revoke: async () => {
        throw new Error("not implemented");
      },
    },
    agentPluginService: { list: async () => [] },
    agentMemberService: {
      listByEmail: async () => [],
      exists: async () => false,
      add: async () => {
        throw new Error("not implemented");
      },
      remove: async () => {},
      listByAgentId: async () => [],
    },
    agentService: {
      listAll: async () => [],
      listByIds: async () => [],
      searchByName: async () => [],
      listOptions: async () => [],
      create: async () => {
        throw new Error("not implemented");
      },
      delete: async () => {},
      getDetail: async () => null,
      updateFields: async () => {
        throw new Error("not implemented");
      },
    },
    provisioner: {
      canProvision: false,
      provision: async () => {
        throw new Error("not implemented");
      },
      deprovision: async () => {},
      reconcile: async () => ({
        recreated: [],
        updated: [],
        orphans: [],
        failed: [],
      }),
    },
    taskStore: {
      listTokensForAgent: async () => [],
      revokeToken: async () => {},
    },
    chatService: {
      listTokensForAgent: async () => [],
      revokeToken: async () => {},
      deleteThreadsForAgent: async () => ({ deleted: 0 }),
    },
    slack: { deleteApp: async () => {} },
    decrypt: (value: string) => value,
    sessionSecret: "test-admin-session-secret-32-bytes!",
    googleClient: {
      exchangeCode: async () => ({
        accessToken: "t",
        refreshToken: "r",
        expiresIn: 3600,
      }),
      getUserInfo: async () => ({
        sub: "s",
        email: "a@example.com",
        email_verified: true,
        name: "A",
      }),
    },
    googleClientId: "gcid",
    googleClientSecret: "gcsecret",
    adminAllowedEmails: ["admin@example.com"],
    slackClient: {
      createAppManifest: async () => {
        throw new Error("not implemented");
      },
      updateAppManifest: async () => {},
      exchangeOAuthCode: async () => ({ botToken: "xoxb" }),
      authTest: async () => ({ userId: "U0AALR8M69X" }),
    },
    githubAppClient: {
      exchangeManifestCode: async () => {
        throw new Error("not implemented");
      },
    },
    appBaseUrl: "https://example.com",
    ...overrides,
  };
}

describe("PWA head tags — HTTPS gating, applied site-wide via html()", () => {
  it("emits the manifest link + SW registration script when appBaseUrl is https", async () => {
    const app = createAdminUIApp(
      makeMinimalDeps({
        appBaseUrl: "https://admin.example.com",
        pwaAssetsDir: makeFixtureIconsDir(),
      }),
    );
    const res = await app.request("/admin/login");
    const body = await res.text();
    expect(body).toContain('rel="manifest"');
    expect(body).toContain("/admin/manifest.webmanifest");
    expect(body).toContain("serviceWorker");
  });

  it("omits the manifest link + SW registration script when appBaseUrl is plain http (home-lab)", async () => {
    const app = createAdminUIApp(
      makeMinimalDeps({
        appBaseUrl: "http://localhost:3001",
        pwaAssetsDir: makeFixtureIconsDir(),
      }),
    );
    const res = await app.request("/admin/login");
    const body = await res.text();
    expect(body).not.toContain('rel="manifest"');
    expect(body).not.toContain("serviceWorker");
  });
});
