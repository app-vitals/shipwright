/**
 * admin/src/provision-callback.smoke.test.ts
 * Smoke tests for the OAuth callback + xapp-token + cron seeding provisioning flow.
 *
 * Uses app.request() — no real server, no real DB.
 * Services are injected as in-memory test doubles.
 */

import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { sign } from "hono/jwt";
import { createAdminUIApp } from "./admin-ui.ts";
import type { AdminUIDeps, AdminUISlackClient } from "./admin-ui.ts";
import type { TaskStoreProvisioningClient } from "./task-store-provisioning-client.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const AGENT_ID = "agent-test-provision-123";
const PROVISION_STATE_COOKIE = "slack_provision_state";

// ─── JWT helpers ──────────────────────────────────────────────────────────────

async function makeSessionCookie(
  secret = SESSION_SECRET,
  email = "admin@example.com",
): Promise<string> {
  return sign(
    {
      userId: "google-sub-123",
      email,
      isAdmin: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    "HS256",
  );
}

async function makeProvisionStateCookie(
  opts: {
    secret?: string;
    agentId?: string;
    clientId?: string;
    clientSecret?: string;
    signingSecret?: string;
    appId?: string;
    expired?: boolean;
  } = {},
): Promise<string> {
  const secret = opts.secret ?? SESSION_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const exp = opts.expired ? now - 10 : now + 300;
  return sign(
    {
      agentId: opts.agentId ?? AGENT_ID,
      clientId: opts.clientId ?? "test-client-id",
      clientSecret: opts.clientSecret ?? "test-client-secret",
      signingSecret: opts.signingSecret ?? "test-signing-secret",
      appId: opts.appId ?? "A0123456789",
      iat: now,
      exp,
    },
    secret,
    "HS256",
  );
}

// ─── Mock deps factory ────────────────────────────────────────────────────────

interface MockState {
  upsertCalls: Array<{ agentId: string; env: Record<string, string> }>;
  patchCalls: Array<{ agentId: string; env: Record<string, string> }>;
  reconcileCalls: string[];
  createTokenCalls: Array<{ agentId: string; label?: string }>;
}

function makeMockSlackClient(opts?: {
  exchangeOAuthCode?: (
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ) => Promise<{ botToken: string }>;
}): AdminUISlackClient {
  return {
    createAppManifest: async () => ({
      appId: "A0123456789",
      oauthRedirectUrl: "https://slack.com/oauth/authorize?client_id=123",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      signingSecret: "test-signing-secret",
    }),
    updateAppManifest: async () => {},
    exchangeOAuthCode:
      opts?.exchangeOAuthCode ??
      (async () => ({ botToken: "xoxb-mock-bot-token" })),
  };
}

function makeMockDeps(
  state: MockState,
  overrides?: Partial<AdminUIDeps>,
): AdminUIDeps {
  return {
    prisma: {
      agent: {
        findMany: async () => [
          {
            id: AGENT_ID,
            name: "Test Agent",
            slackId: null,
            createdAt: new Date("2024-01-01"),
          },
        ],
        findUnique: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: null,
          selfHosted: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        create: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        update: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        delete: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
      },
      agentPlugin: {
        findMany: async () => [],
      },
      agentMember: {
        findMany: async () => [],
        findUnique: async () => null,
        create: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: "member@example.com",
        }),
        deleteMany: async () => ({ count: 0 }),
      },
    },
    agentEnvService: {
      getByAgentId: async () => ({ env: {}, secretKeys: [] }),
      upsert: async (agentId: string, env: Record<string, string>) => {
        state.upsertCalls.push({ agentId, env });
      },
      patch: async (agentId: string, env: Record<string, string>) => {
        state.patchCalls.push({ agentId, env });
      },
      deleteKey: async () => {},
      getConfigBundle: async () => null,
    },
    agentCronRunService: {
      list: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
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
      reconcileSystemCrons: async (agentId: string) => {
        state.reconcileCalls.push(agentId);
        return { created: 3, updated: 0, deleted: 0 };
      },
    },
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
      create: async (agentId: string, label?: string) => {
        state.createTokenCalls.push({ agentId, label });
        return {
          token: {
            id: "tok-test-123",
            agentId,
            token: "hashed-value",
            label: label ?? null,
            createdAt: new Date("2024-01-01"),
            revokedAt: null,
          },
          rawToken: "raw_test_token_abc123def456",
        };
      },
      revoke: async () => null,
    },
    agentPluginService: {
      list: async () => [],
    },
    sessionSecret: SESSION_SECRET,
    googleClientId: "test-google-client-id",
    googleClientSecret: "test-google-client-secret",
    adminAllowedEmails: ["admin@example.com"],
    googleClient: {
      exchangeCode: async () => ({
        accessToken: "test-access-token",
        expiresIn: 3600,
      }),
      getUserInfo: async () => ({
        sub: "google-sub-123",
        email: "admin@example.com",
        name: "Admin User",
      }),
    },
    slackClient: makeMockSlackClient(),
    provisioner: {
      provision: async () => ({
        resourceName: "r",
        secretName: "s",
        deploymentName: "d",
      }),
      deprovision: async () => {},
      reconcile: async () => ({
        recreated: [],
        updated: [],
        orphans: [],
        failed: [],
      }),
    },
    appBaseUrl: "https://example.com",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /admin/provision/complete — OAuth callback", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    sessionCookie = await makeSessionCookie();
  });

  it("valid state cookie + code param → stores SLACK_BOT_TOKEN and renders xapp-token page", async () => {
    const state: MockState = {
      upsertCalls: [],
      patchCalls: [],
      reconcileCalls: [],
      createTokenCalls: [],
    };
    const app = createAdminUIApp(makeMockDeps(state));

    const provisionState = await makeProvisionStateCookie();

    const res = await app.request(
      "/admin/provision/complete?code=valid-oauth-code",
      {
        headers: {
          Cookie: `admin_session=${sessionCookie}; ${PROVISION_STATE_COOKIE}=${provisionState}`,
        },
      },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    // Should render xapp-token page, not the old paste form
    expect(html.toLowerCase()).toContain("xapp");

    // SLACK_BOT_TOKEN should have been stored via patch()
    expect(state.patchCalls.length).toBeGreaterThan(0);
    const storedEnv = state.patchCalls[state.patchCalls.length - 1].env;
    expect(storedEnv).toHaveProperty("SLACK_BOT_TOKEN", "xoxb-mock-bot-token");
  });

  it("absent cookie → renders error page (not blank form)", async () => {
    const state: MockState = {
      upsertCalls: [],
      patchCalls: [],
      reconcileCalls: [],
      createTokenCalls: [],
    };
    const app = createAdminUIApp(makeMockDeps(state));

    const res = await app.request("/admin/provision/complete?code=some-code", {
      headers: {
        Cookie: `admin_session=${sessionCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    // Should show an error, not a blank form
    expect(html.toLowerCase()).toContain("error");
    // Should NOT contain an input for pasting app ID or signing secret
    expect(html).not.toContain('name="appId"');
    expect(html).not.toContain('name="signingSecret"');
    // No bot token should be stored
    expect(state.upsertCalls.length).toBe(0);
  });

  it("expired cookie → renders error page", async () => {
    const state: MockState = {
      upsertCalls: [],
      patchCalls: [],
      reconcileCalls: [],
      createTokenCalls: [],
    };
    const app = createAdminUIApp(makeMockDeps(state));

    const expiredProvisionState = await makeProvisionStateCookie({
      expired: true,
    });

    const res = await app.request("/admin/provision/complete?code=valid-code", {
      headers: {
        Cookie: `admin_session=${sessionCookie}; ${PROVISION_STATE_COOKIE}=${expiredProvisionState}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
    expect(state.upsertCalls.length).toBe(0);
  });

  it("valid state cookie but no code param (e.g. user denied OAuth) → renders error page without consuming session", async () => {
    const state: MockState = {
      upsertCalls: [],
      patchCalls: [],
      reconcileCalls: [],
      createTokenCalls: [],
    };
    const app = createAdminUIApp(makeMockDeps(state));

    const validProvisionState = await makeProvisionStateCookie();

    // No ?code= param — simulates user denying the OAuth prompt (?error=access_denied)
    const res = await app.request("/admin/provision/complete", {
      headers: {
        Cookie: `admin_session=${sessionCookie}; ${PROVISION_STATE_COOKIE}=${validProvisionState}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
    // Should instruct restart, not "try authorizing again" (cookie was already consumed)
    expect(html.toLowerCase()).toContain("restart");
    // No bot token or credentials should be stored
    expect(state.upsertCalls.length).toBe(0);
  });
});

describe("GET /admin/provision/complete — reinstall path (SLACK_APP_TOKEN already set)", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    sessionCookie = await makeSessionCookie();
  });

  it("valid state cookie + code param + SLACK_APP_TOKEN already in env → 302 to ?success=reinstalled", async () => {
    const state: MockState = {
      upsertCalls: [],
      patchCalls: [],
      reconcileCalls: [],
      createTokenCalls: [],
    };
    const deps = makeMockDeps(state, {
      agentEnvService: {
        // Existing env already has SLACK_APP_TOKEN — reinstall path
        getByAgentId: async () => ({ env: {}, secretKeys: [] }),
        upsert: async (agentId: string, env: Record<string, string>) => {
          state.upsertCalls.push({ agentId, env });
        },
        patch: async (agentId: string, env: Record<string, string>) => {
          state.patchCalls.push({ agentId, env });
        },
        deleteKey: async () => {},
        getConfigBundle: async () => ({
          env: {
            SLACK_BOT_TOKEN: "xoxb-old-bot-token",
            SLACK_APP_TOKEN: "xapp-existing-app-token",
          },
          agentId: AGENT_ID,
          allowedTools: [],
        }),
      },
    });
    const app = createAdminUIApp(deps);

    const provisionState = await makeProvisionStateCookie();

    const res = await app.request(
      "/admin/provision/complete?code=valid-oauth-code",
      {
        headers: {
          Cookie: `admin_session=${sessionCookie}; ${PROVISION_STATE_COOKIE}=${provisionState}`,
        },
      },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("success=reinstalled");
    expect(location).toContain(`/admin/agents/${AGENT_ID}`);

    // SLACK_BOT_TOKEN should still have been stored via patch() (new token)
    const storedEnv = state.patchCalls[state.patchCalls.length - 1]?.env;
    expect(storedEnv).toHaveProperty("SLACK_BOT_TOKEN", "xoxb-mock-bot-token");
  });
});

describe("POST /admin/provision/complete — removed route", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    sessionCookie = await makeSessionCookie();
  });

  it("returns 404", async () => {
    const state: MockState = {
      upsertCalls: [],
      patchCalls: [],
      reconcileCalls: [],
      createTokenCalls: [],
    };
    const app = createAdminUIApp(makeMockDeps(state));

    const body = new URLSearchParams({
      agentId: AGENT_ID,
      appId: "A0123456789",
      signingSecret: "some-secret",
    });

    const res = await app.request("/admin/provision/complete", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${sessionCookie}`,
      },
    });

    expect(res.status).toBe(404);
  });
});

describe("POST /admin/provision/xapp-token", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    sessionCookie = await makeSessionCookie();
  });

  it("valid data → 200, SLACK_APP_TOKEN stored, SHIPWRIGHT_AGENT_API_KEY stored, crons reconciled, raw token shown", async () => {
    const state: MockState = {
      upsertCalls: [],
      patchCalls: [],
      reconcileCalls: [],
      createTokenCalls: [],
    };
    const app = createAdminUIApp(makeMockDeps(state));

    const body = new URLSearchParams({
      agentId: AGENT_ID,
      xappToken: "xapp-1-TEST-fake-socket-token",
    });

    const res = await app.request("/admin/provision/xapp-token", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${sessionCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();

    // SLACK_APP_TOKEN should be stored via patch()
    const appTokenPatch = state.patchCalls.find(
      (c) => "SLACK_APP_TOKEN" in c.env,
    );
    expect(appTokenPatch).toBeDefined();
    expect(appTokenPatch?.env.SLACK_APP_TOKEN).toBe(
      "xapp-1-TEST-fake-socket-token",
    );

    // SHIPWRIGHT_AGENT_API_KEY should be stored via patch()
    const apiKeyPatch = state.patchCalls.find(
      (c) => "SHIPWRIGHT_AGENT_API_KEY" in c.env,
    );
    expect(apiKeyPatch).toBeDefined();
    expect(apiKeyPatch?.env.SHIPWRIGHT_AGENT_API_KEY).toBe(
      "raw_test_token_abc123def456",
    );

    // Crons should have been reconciled
    expect(state.reconcileCalls).toContain(AGENT_ID);

    // agentTokenService.create should have been called
    expect(state.createTokenCalls.length).toBeGreaterThan(0);
    expect(state.createTokenCalls[0].agentId).toBe(AGENT_ID);

    // Raw token should appear in the response HTML
    expect(html).toContain("raw_test_token_abc123def456");
  });

  it("missing agentId → shows error in xapp-token page", async () => {
    const state: MockState = {
      upsertCalls: [],
      patchCalls: [],
      reconcileCalls: [],
      createTokenCalls: [],
    };
    const app = createAdminUIApp(makeMockDeps(state));

    const body = new URLSearchParams({
      xappToken: "xapp-1-TEST-fake-socket-token",
    });

    const res = await app.request("/admin/provision/xapp-token", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${sessionCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    // Should show error — still on xapp-token page
    expect(html.toLowerCase()).toContain("error");
    // No env vars stored
    expect(state.upsertCalls.length).toBe(0);
  });

  it("invalid xappToken (missing xapp- prefix) → shows error in xapp-token page", async () => {
    const state: MockState = {
      upsertCalls: [],
      patchCalls: [],
      reconcileCalls: [],
      createTokenCalls: [],
    };
    const app = createAdminUIApp(makeMockDeps(state));

    const body = new URLSearchParams({
      agentId: AGENT_ID,
      xappToken: "not-a-valid-xapp-token",
    });

    const res = await app.request("/admin/provision/xapp-token", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${sessionCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
    expect(state.upsertCalls.length).toBe(0);
  });

  it("taskStoreProvisioningClient configured → mints a task-store token, patches SHIPWRIGHT_TASK_STORE_TOKEN/URL", async () => {
    const state: MockState = {
      upsertCalls: [],
      patchCalls: [],
      reconcileCalls: [],
      createTokenCalls: [],
    };
    const mintCalls: Array<{ label: string; agentId?: string }> = [];
    const taskStoreProvisioningClient: TaskStoreProvisioningClient = {
      mintToken: async (label: string, agentId?: string) => {
        mintCalls.push({ label, agentId });
        return { id: "ts-tok-1", rawToken: "ts-raw-token-xyz" };
      },
      revokeToken: async () => {},
    };
    const app = createAdminUIApp(
      makeMockDeps(state, {
        taskStoreProvisioningClient,
        taskStoreBaseUrl: "https://task-store.example.com",
      }),
    );

    const body = new URLSearchParams({
      agentId: AGENT_ID,
      xappToken: "xapp-1-TEST-fake-socket-token",
    });

    const res = await app.request("/admin/provision/xapp-token", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${sessionCookie}`,
      },
    });

    expect(res.status).toBe(200);
    expect(mintCalls).toEqual([
      { label: `agent:${AGENT_ID}`, agentId: AGENT_ID },
    ]);

    const taskStorePatch = state.patchCalls.find(
      (c) => "SHIPWRIGHT_TASK_STORE_TOKEN" in c.env,
    );
    expect(taskStorePatch).toBeDefined();
    expect(taskStorePatch?.env.SHIPWRIGHT_TASK_STORE_TOKEN).toBe(
      "ts-raw-token-xyz",
    );
    expect(taskStorePatch?.env.SHIPWRIGHT_TASK_STORE_URL).toBe(
      "https://task-store.example.com",
    );
  });

  it("no taskStoreProvisioningClient configured → logs a warning, no task-store env stored", async () => {
    const state: MockState = {
      upsertCalls: [],
      patchCalls: [],
      reconcileCalls: [],
      createTokenCalls: [],
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const app = createAdminUIApp(makeMockDeps(state));

      const body = new URLSearchParams({
        agentId: AGENT_ID,
        xappToken: "xapp-1-TEST-fake-socket-token",
      });

      const res = await app.request("/admin/provision/xapp-token", {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${sessionCookie}`,
        },
      });

      expect(res.status).toBe(200);
      expect(warnSpy).toHaveBeenCalledWith(
        "[admin] task-store not configured — skipping task-store provisioning for agent",
        AGENT_ID,
      );

      const taskStorePatch = state.patchCalls.find(
        (c) => "SHIPWRIGHT_TASK_STORE_TOKEN" in c.env,
      );
      expect(taskStorePatch).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
