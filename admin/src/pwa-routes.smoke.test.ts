/**
 * admin/src/pwa-routes.smoke.test.ts
 * Smoke tests for the unauthenticated PWA shell routes: manifest.webmanifest,
 * sw.js, and the six icon files. Uses app.request() — no real server, no
 * real DB, no session cookie set on any request in this file (that's the
 * point: browsers fetch these with credentials:omit).
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminUIApp } from "./admin-ui.ts";
import type { AdminUIDeps } from "./admin-ui.ts";
import { PWA_ICONS } from "./pwa.ts";

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function makeFixtureIconsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pwa-icons-"));
  const iconsDir = join(dir, "icons");
  mkdirSync(iconsDir, { recursive: true });
  for (const icon of PWA_ICONS) {
    writeFileSync(join(iconsDir, icon.filename), PNG_1X1);
  }
  return dir;
}

function makeMinimalDeps(overrides?: Partial<AdminUIDeps>): AdminUIDeps {
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
    },
    agentWorkQueueService: { get: async () => null },
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
    sessionSecret: SESSION_SECRET,
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

describe("PWA shell routes — unauthenticated reachability", () => {
  const iconsDir = makeFixtureIconsDir();
  const deps = makeMinimalDeps({ pwaAssetsDir: iconsDir });
  const app = createAdminUIApp(deps);

  it("GET /admin/manifest.webmanifest is reachable without a session cookie", async () => {
    const res = await app.request("/admin/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain(
      "application/manifest+json",
    );
    const body = await res.json();
    expect(body.scope).toBe("/admin/");
    expect(body.start_url).toBe("/admin/chat");
    expect(body.display).toBe("standalone");
  });

  it("GET /admin/manifest.webmanifest?start=... honors a valid same-origin start param (PWA-1.1)", async () => {
    const res = await app.request(
      "/admin/manifest.webmanifest?start=%2Fadmin%2Ftasks",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.start_url).toBe("/admin/tasks");
  });

  it("GET /admin/manifest.webmanifest?start=... falls back to /admin/chat for a malicious/invalid start param (PWA-1.1)", async () => {
    const res = await app.request(
      `/admin/manifest.webmanifest?start=${encodeURIComponent("https://evil.com")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.start_url).toBe("/admin/chat");
  });

  it("GET /admin/sw.js is reachable without a session cookie, no-cache, correct content type", async () => {
    const res = await app.request("/admin/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("javascript");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("GET /admin/icons/:filename is reachable without a session cookie for every declared icon", async () => {
    for (const icon of PWA_ICONS) {
      const res = await app.request(`/admin/icons/${icon.filename}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
    }
  });

  it("GET /admin/icons/:filename 404s for an unknown filename", async () => {
    const res = await app.request("/admin/icons/does-not-exist.png");
    expect(res.status).toBe(404);
  });

  it("GET /admin/offline.html is reachable without a session cookie", async () => {
    const res = await app.request("/admin/offline.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("You're offline");
  });
});

describe("html() security headers", () => {
  it("every rendered admin page carries the three security headers", async () => {
    const iconsDir2 = makeFixtureIconsDir();
    const app = createAdminUIApp(makeMinimalDeps({ pwaAssetsDir: iconsDir2 }));
    const res = await app.request("/admin/login");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBeTruthy();
  });
});
