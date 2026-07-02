/**
 * agent/src/admin-ui.smoke.test.ts
 * Smoke tests for the Admin UI shell (admin-ui.ts).
 *
 * Uses app.request() — no real server, no real DB.
 * Services are injected as in-memory test doubles.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import type { PrListItem, PullRequestItem } from "./admin-ui-pages.ts";
import { createAdminUIApp } from "./admin-ui.ts";
import type { AdminUIDeps, AdminUISlackClient } from "./admin-ui.ts";
import type {
  GoogleAuthClient,
  GoogleTokenResponse,
  GoogleUserInfo,
} from "./google-auth-client.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const GOOGLE_CLIENT_ID = "test-google-client-id";
const GOOGLE_CLIENT_SECRET = "test-google-client-secret";
const ADMIN_ALLOWED_EMAILS = ["admin@example.com", "other@example.com"];
const AGENT_ID = "agent-test-123";
const CRON_ID = "cron-test-456";
const TOOL_ID = "tool-test-789";
const TOKEN_ID = "token-test-abc";

// ─── Mock fixtures ────────────────────────────────────────────────────────────

const MOCK_CRON = {
  id: CRON_ID,
  agentId: AGENT_ID,
  schedule: "0 * * * *",
  prompt: "check status",
  channel: "C123456",
  user: null,
  enabled: true,
  name: null,
  system: false,
  silent: false,
  preCheck: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const MOCK_TOOL = {
  id: TOOL_ID,
  agentId: AGENT_ID,
  pattern: "Bash(git:*)",
  enabled: true,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const MOCK_TOKEN = {
  id: TOKEN_ID,
  agentId: AGENT_ID,
  token: "hashed-token-value",
  label: "CI token",
  createdAt: new Date("2024-01-01"),
  revokedAt: null,
};

// ─── JWT helper ───────────────────────────────────────────────────────────────

async function makeSessionCookie(
  secret = SESSION_SECRET,
  userId = "google-sub-123",
  email = "admin@example.com",
  isAdmin = true,
): Promise<string> {
  return sign(
    {
      userId,
      email,
      isAdmin,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    "HS256",
  );
}

// ─── Mock Google client ───────────────────────────────────────────────────────

function makeGoogleClient(overrides?: {
  exchangeCode?: (params: unknown) => Promise<GoogleTokenResponse>;
  getUserInfo?: (accessToken: string) => Promise<GoogleUserInfo>;
}): GoogleAuthClient {
  return {
    exchangeCode:
      overrides?.exchangeCode ??
      (() =>
        Promise.resolve({
          accessToken: "test-access-token",
          refreshToken: "test-refresh-token",
          expiresIn: 3600,
        })),
    getUserInfo:
      overrides?.getUserInfo ??
      (() =>
        Promise.resolve({
          sub: "google-sub-123",
          email: "admin@example.com",
          email_verified: true,
          name: "Admin User",
        })),
  };
}

// ─── Mock deps ────────────────────────────────────────────────────────────────

const BASE_SLACK_CLIENT: AdminUISlackClient = {
  createAppManifest: async () => ({
    appId: "A123456",
    oauthRedirectUrl: "https://slack.com/oauth/authorize?client_id=123",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    signingSecret: "test-signing-secret",
  }),
  updateAppManifest: async () => {},
  exchangeOAuthCode: async () => ({ botToken: "xoxb-mock-bot-token" }),
};

function makeMockDeps(
  overrides?: Partial<Omit<AdminUIDeps, "slackClient">> & {
    slackClient?: Partial<AdminUISlackClient>;
  },
): AdminUIDeps {
  const { slackClient: slackClientOverride, ...rest } = overrides ?? {};
  return {
    prisma: {
      agent: {
        findMany: async () => [
          {
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
          },
        ],
        findUnique: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        create: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        update: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        delete: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
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
      getByAgentId: async () => ({ env: { FOO: "bar" }, secretKeys: [] }),
      upsert: async () => {},
      patch: async () => {},
      deleteKey: async () => {},
      getConfigBundle: async () => null,
    },
    agentCronJobService: {
      list: async () => [MOCK_CRON],
      listWithRunSummary: async () => [
        { ...MOCK_CRON, lastRun: null, runCountToday: 0 },
      ],
      get: async () => MOCK_CRON,
      create: async () => MOCK_CRON,
      setEnabled: async () => MOCK_CRON,
      update: async () => MOCK_CRON,
      delete: async () => {},
      reconcileSystemCrons: async () => ({
        created: 0,
        updated: 0,
        deleted: 0,
      }),
    },
    agentCronRunService: {
      list: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    },
    agentToolService: {
      list: async () => [MOCK_TOOL],
      add: async () => MOCK_TOOL,
      toggle: async () => MOCK_TOOL,
      remove: async () => {},
    },
    agentTokenService: {
      listForAgent: async () => [MOCK_TOKEN],
      create: async () => ({ token: MOCK_TOKEN, rawToken: "sw_raw123456" }),
      revoke: async () => MOCK_TOKEN,
    },
    agentPluginService: {
      list: async () => [],
    },
    sessionSecret: SESSION_SECRET,
    googleClientId: GOOGLE_CLIENT_ID,
    googleClientSecret: GOOGLE_CLIENT_SECRET,
    adminAllowedEmails: ADMIN_ALLOWED_EMAILS,
    googleClient: makeGoogleClient(),
    slackClient: { ...BASE_SLACK_CLIENT, ...slackClientOverride },
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
    ...rest,
  };
}

// ─── Auth redirect tests ──────────────────────────────────────────────────────

describe("admin UI — unauthenticated redirects", () => {
  it("unauthenticated GET /admin/agents redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });

  it("unauthenticated GET /admin/agents/:id redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });

  it("unauthenticated GET /admin/agents/:id/crons/:cronId/runs redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/runs`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });
});

// ─── Login page ───────────────────────────────────────────────────────────────

describe("admin UI — login page", () => {
  it("GET /admin/login returns 200 with Sign in with Google button (no password form)", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in with Google");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('name="password"');
  });
});

// ─── OAuth routes ─────────────────────────────────────────────────────────────

describe("admin UI — GET /admin/auth/google", () => {
  it("redirects to Google OAuth URL and sets oauth_state cookie", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/auth/google");
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("accounts.google.com");
    expect(location).toContain("openid");
    expect(location).toContain("profile");
    expect(location).toContain("email");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("oauth_state=");
    expect(cookie).toContain("HttpOnly");
  });

  it("redirects to /admin/login?error=server_error when googleClientId is empty", async () => {
    const app = createAdminUIApp(makeMockDeps({ googleClientId: "" }));
    const res = await app.request("/admin/auth/google");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=server_error");
  });
});

describe("admin UI — GET /admin/auth/callback", () => {
  // Helper: set a nonce cookie (encoded as JSON alongside optional returnTo) and matching state query param.
  // Hono's setCookie URL-encodes cookie values; getCookie URL-decodes them on read.
  // The test helper must percent-encode the JSON so getCookie returns the original JSON string.
  function callbackRequest(
    nonce: string,
    queryOverrides?: Record<string, string>,
    returnTo?: string,
  ): Request {
    const params = new URLSearchParams({
      state: nonce,
      code: "auth-code-123",
      ...queryOverrides,
    });
    const oauthState = encodeURIComponent(JSON.stringify({ nonce, returnTo }));
    return new Request(
      `https://example.com/admin/auth/callback?${params.toString()}`,
      {
        headers: { Cookie: `oauth_state=${oauthState}` },
      },
    );
  }

  it("happy path — valid state, code exchanged, email in allowlist → sets session cookie and redirects to /admin/agents", async () => {
    const nonce = "test-nonce-abc";
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(callbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("admin_session=");
    expect(cookie).toContain("HttpOnly");
  });

  it("happy path with returnTo — redirects to the stored returnTo path after auth", async () => {
    const nonce = "test-nonce-abc";
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      callbackRequest(nonce, {}, "/admin/agents/agent-test-123"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents/agent-test-123");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("admin_session=");
  });

  it("state mismatch → redirects to /admin/login?error=invalid_state", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const oauthState = encodeURIComponent(
      JSON.stringify({ nonce: "stored-nonce" }),
    );
    const res = await app.request(
      new Request(
        "https://example.com/admin/auth/callback?state=wrong-state&code=auth-code",
        {
          headers: { Cookie: `oauth_state=${oauthState}` },
        },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=invalid_state");
  });

  it("missing oauth_state cookie → redirects to /admin/login?error=invalid_state", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      new Request(
        "https://example.com/admin/auth/callback?state=some-state&code=code",
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=invalid_state");
  });

  it("missing GOOGLE_CLIENT_ID → redirects to /admin/login?error=server_error", async () => {
    const nonce = "test-nonce-abc";
    const app = createAdminUIApp(makeMockDeps({ googleClientId: "" }));
    const res = await app.request(callbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=server_error");
  });

  it("access_denied param → redirects to /admin/login?error=access_denied", async () => {
    const nonce = "test-nonce-abc";
    const app = createAdminUIApp(makeMockDeps());
    const oauthState = encodeURIComponent(JSON.stringify({ nonce }));
    const res = await app.request(
      new Request(
        `https://example.com/admin/auth/callback?error=access_denied&state=${nonce}`,
        {
          headers: { Cookie: `oauth_state=${oauthState}` },
        },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=access_denied");
  });

  it("token exchange failure → redirects to /admin/login?error=auth_failed", async () => {
    const nonce = "test-nonce-abc";
    const app = createAdminUIApp(
      makeMockDeps({
        googleClient: makeGoogleClient({
          exchangeCode: () =>
            Promise.reject(new Error("token exchange failed")),
        }),
      }),
    );
    const res = await app.request(callbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=auth_failed");
  });

  it("userinfo fetch failure → redirects to /admin/login?error=auth_failed", async () => {
    const nonce = "test-nonce-abc";
    const app = createAdminUIApp(
      makeMockDeps({
        googleClient: makeGoogleClient({
          getUserInfo: () => Promise.reject(new Error("userinfo failed")),
        }),
      }),
    );
    const res = await app.request(callbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=auth_failed");
  });

  it("email not in allowlist → returns 403", async () => {
    const nonce = "test-nonce-abc";
    const app = createAdminUIApp(
      makeMockDeps({
        googleClient: makeGoogleClient({
          getUserInfo: () =>
            Promise.resolve({
              sub: "google-sub-999",
              email: "notallowed@example.com",
              email_verified: true,
              name: "Not Allowed",
            }),
        }),
      }),
    );
    const res = await app.request(callbackRequest(nonce));
    expect(res.status).toBe(403);
  });
});

// ─── Authenticated pages ──────────────────────────────────────────────────────

describe("admin UI — authenticated pages", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("authenticated GET /admin/agents returns 200 with agents list", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Test Agent");
  });

  it("authenticated GET /admin/agents shows the session user's email in the navbar", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("admin@example.com");
  });

  it("authenticated GET /admin/agents/:id returns 200 with agent detail sections", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Env Vars");
    expect(html).toContain("Cron Jobs");
    expect(html).toContain("Tools");
    expect(html).toContain("Tokens");
    expect(html).toContain("Plugins");
    expect(html).toContain("admin@example.com");
  });

  it("authenticated GET /admin/agents/:id/crons/:cronId/runs returns 200 with run history", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/runs`,
      {
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Outcome");
    expect(html).toContain("Started");
    expect(html).toContain("Duration");
    // empty state by default in the base mock
    expect(html).toContain("No runs recorded yet.");
  });

  it("authenticated GET /admin/agents/:id/crons/:cronId/runs renders populated runs", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentCronRunService: {
          list: async () => ({
            items: [
              {
                id: "run-1",
                cronId: CRON_ID,
                agentId: AGENT_ID,
                startedAt: new Date("2026-06-01T10:00:00Z"),
                completedAt: new Date("2026-06-01T10:00:03Z"),
                skipped: false,
                skipReason: null,
                outcome: "posted",
                error: null,
                inputTokens: 999,
                outputTokens: 111,
                cacheReadTokens: null,
                cacheCreationTokens: null,
                createdAt: new Date("2026-06-01T10:00:00Z"),
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          }),
        },
      }),
    );
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/runs`,
      {
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("posted");
    expect(html).not.toContain("No runs recorded yet.");
  });

  it("authenticated GET /admin/provision shows the session user's email in the navbar", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/provision", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("admin@example.com");
  });

  it("authenticated GET /admin/agents/:id?error=missing_fields renders an error banner", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}?error=missing_fields`,
      {
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("alert-error");
    expect(html).toContain("Required fields are missing");
  });

  it("authenticated GET /admin/agents/:id includes an add-cron form with enabled checkbox", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/admin/agents/');
    expect(html).toContain('name="schedule"');
    expect(html).toContain('name="enabled"');
    expect(html).toContain("Enabled");
  });

  it("authenticated GET /admin/agents/:id?newToken= renders new token notice", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}?newToken=raw-token-abc123`,
      {
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("raw-token-abc123");
  });

  it("POST /admin/agents/:id/envs with secret=true shows lock icon in rendered page", async () => {
    let capturedArgs: unknown[] = [];
    const deps = makeMockDeps({
      agentEnvService: {
        getByAgentId: async () => ({
          env: { MY_SECRET: "***" },
          secretKeys: ["MY_SECRET"],
        }),
        upsert: async (...args: unknown[]) => {
          capturedArgs = args;
        },
        patch: async (...args: unknown[]) => {
          capturedArgs = args;
        },
        deleteKey: async () => {},
        getConfigBundle: async () => null,
      },
    });
    const app = createAdminUIApp(deps);
    // POST the env var form with secret checked
    const form = new FormData();
    form.append("key", "MY_SECRET");
    form.append("value", "topsecret");
    form.append("secret", "true");
    const postRes = await app.request(`/admin/agents/${AGENT_ID}/envs`, {
      method: "POST",
      body: form,
      headers: { Cookie: `admin_session=${cookie}` },
    });
    // Should redirect to agent detail
    expect(postRes.status).toBe(302);

    // Fetch the agent detail page — the mock getByAgentId returns the secret key
    const getRes = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(getRes.status).toBe(200);
    const html = await getRes.text();
    // Lock icon should appear for secret keys
    expect(html).toContain("🔒");
  });

  describe("self-hosted agent (selfHosted=true) detail page", () => {
    const SELFHOSTED_AGENT_ID = "agent-selfhosted-123";

    it("managed agent (selfHosted=false) shows Slack info in header", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          prisma: {
            agent: {
              findUnique: async () => ({
                id: AGENT_ID,
                name: "Managed Agent",
                slackId: "U0AALR8M69X",
                selfHosted: false,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              findMany: async () => [],
              create: async () => ({
                id: AGENT_ID,
                name: "Test Agent",
                slackId: "U123456",
                selfHosted: false,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              update: async () => ({
                id: AGENT_ID,
                name: "Test Agent",
                slackId: "U123456",
                selfHosted: false,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              delete: async () => ({
                id: AGENT_ID,
                name: "Test Agent",
                slackId: "U123456",
                selfHosted: false,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
            },
            agentPlugin: { findMany: async () => [] },
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
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Slack ID:");
      expect(html).toContain("U0AALR8M69X");
    });

    it("managed agent (selfHosted=false) shows Env Vars card", async () => {
      const app = createAdminUIApp(makeMockDeps());
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Env Vars");
    });

    it("managed agent (selfHosted=false) shows System crons", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentCronJobService: {
            list: async () => [
              { ...MOCK_CRON, system: true, name: "system-cron" },
            ],
            listWithRunSummary: async () => [
              {
                ...MOCK_CRON,
                system: true,
                name: "system-cron",
                lastRun: null,
                runCountToday: 0,
              },
            ],
            get: async () => MOCK_CRON,
            create: async () => MOCK_CRON,
            setEnabled: async () => MOCK_CRON,
            update: async () => MOCK_CRON,
            delete: async () => {},
            reconcileSystemCrons: async () => ({
              created: 0,
              updated: 0,
              deleted: 0,
            }),
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // System subsection should be present
      expect(html).toContain("System");
    });

    it("managed agent (selfHosted=false) shows Tools card", async () => {
      const app = createAdminUIApp(makeMockDeps());
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Bash(git:*)");
    });

    it("managed agent (selfHosted=false) does NOT show Local CLI access card", async () => {
      const app = createAdminUIApp(makeMockDeps());
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("Local CLI");
    });

    it("self-hosted agent (selfHosted=true) does NOT show Slack info in header", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          prisma: {
            agent: {
              findUnique: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              findMany: async () => [],
              create: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              update: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              delete: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
            },
            agentPlugin: { findMany: async () => [] },
            agentMember: {
              findMany: async () => [],
              findUnique: async () => null,
              create: async () => ({
                id: "m1",
                agentId: SELFHOSTED_AGENT_ID,
                email: "member@example.com",
              }),
              deleteMany: async () => ({ count: 0 }),
            },
          },
        }),
      );
      const res = await app.request(`/admin/agents/${SELFHOSTED_AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("Slack ID:");
    });

    it("self-hosted agent (selfHosted=true) does NOT show Env Vars card", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          prisma: {
            agent: {
              findUnique: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              findMany: async () => [],
              create: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              update: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              delete: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
            },
            agentPlugin: { findMany: async () => [] },
            agentMember: {
              findMany: async () => [],
              findUnique: async () => null,
              create: async () => ({
                id: "m1",
                agentId: SELFHOSTED_AGENT_ID,
                email: "member@example.com",
              }),
              deleteMany: async () => ({ count: 0 }),
            },
          },
          agentEnvService: {
            getByAgentId: async () => ({
              env: { TEST_VAR: "should-not-show" },
              secretKeys: [],
            }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${SELFHOSTED_AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // The card title "Env Vars" should not appear
      expect(html).not.toContain('<div class="card-title">Env Vars</div>');
    });

    it("self-hosted agent (selfHosted=true) shows System crons with self-hosted notice", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          prisma: {
            agent: {
              findUnique: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              findMany: async () => [],
              create: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              update: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              delete: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
            },
            agentPlugin: { findMany: async () => [] },
            agentMember: {
              findMany: async () => [],
              findUnique: async () => null,
              create: async () => ({
                id: "m1",
                agentId: SELFHOSTED_AGENT_ID,
                email: "member@example.com",
              }),
              deleteMany: async () => ({ count: 0 }),
            },
          },
          agentCronJobService: {
            list: async () => [
              { ...MOCK_CRON, system: true, name: "system-cron" },
            ],
            listWithRunSummary: async () => [
              {
                ...MOCK_CRON,
                system: true,
                name: "system-cron",
                lastRun: null,
                runCountToday: 0,
              },
            ],
            get: async () => MOCK_CRON,
            create: async () => MOCK_CRON,
            setEnabled: async () => MOCK_CRON,
            update: async () => MOCK_CRON,
            delete: async () => {},
            reconcileSystemCrons: async () => ({
              created: 0,
              updated: 0,
              deleted: 0,
            }),
          },
        }),
      );
      const res = await app.request(`/admin/agents/${SELFHOSTED_AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // System crons section should be present for self-hosted agents
      expect(html).toContain(">System<");
      // Self-hosted notice should appear in the Crons card
      expect(html).toContain(
        "Crons fire only while the local agent service is running",
      );
    });

    it("self-hosted agent (selfHosted=true) shows Tools card", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          prisma: {
            agent: {
              findUnique: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              findMany: async () => [],
              create: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              update: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              delete: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
            },
            agentPlugin: { findMany: async () => [] },
            agentMember: {
              findMany: async () => [],
              findUnique: async () => null,
              create: async () => ({
                id: "m1",
                agentId: SELFHOSTED_AGENT_ID,
                email: "member@example.com",
              }),
              deleteMany: async () => ({ count: 0 }),
            },
          },
          agentToolService: {
            list: async () => [
              {
                ...MOCK_TOOL,
                pattern: "Bash(git:*)",
                agentId: SELFHOSTED_AGENT_ID,
              },
            ],
            add: async () => MOCK_TOOL,
            toggle: async () => MOCK_TOOL,
            remove: async () => {},
          },
        }),
      );
      const res = await app.request(`/admin/agents/${SELFHOSTED_AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // Tools card should appear for self-hosted agents
      expect(html).toContain('<div class="card-title">Tools</div>');
      // Tools should be rendered
      expect(html).toContain("Bash(git:*)");
    });

    it("self-hosted agent (selfHosted=true) shows Local CLI access card with link to tokens", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          prisma: {
            agent: {
              findUnique: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              findMany: async () => [],
              create: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              update: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
              delete: async () => ({
                id: SELFHOSTED_AGENT_ID,
                name: "Self-Hosted Agent",
                slackId: null,
                selfHosted: true,
                createdAt: new Date("2024-01-01"),
                updatedAt: new Date("2024-01-01"),
                repos: [],
              }),
            },
            agentPlugin: { findMany: async () => [] },
            agentMember: {
              findMany: async () => [],
              findUnique: async () => null,
              create: async () => ({
                id: "m1",
                agentId: SELFHOSTED_AGENT_ID,
                email: "member@example.com",
              }),
              deleteMany: async () => ({ count: 0 }),
            },
          },
        }),
      );
      const res = await app.request(`/admin/agents/${SELFHOSTED_AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // Local CLI card should be present
      expect(html).toContain("Local CLI");
      expect(html).toContain("Manage Tokens");
      // Link should include the agent ID
      expect(html).toContain(`/admin/tokens?agentId=${SELFHOSTED_AGENT_ID}`);
    });
  });
});

// ─── Cron job mutation routes ─────────────────────────────────────────────────

describe("admin UI — cron job mutation routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/crons with valid data redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({
      schedule: "0 * * * *",
      prompt: "Test prompt",
      channel: "C123",
      enabled: "true",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/crons`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/crons with missing schedule redirects with error", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ prompt: "Test prompt" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/crons`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=");
  });

  it("POST /admin/agents/:id/crons passes enabled=false to the service when checkbox is unchecked", async () => {
    let capturedEnabled: boolean | undefined;
    const deps = makeMockDeps();
    deps.agentCronJobService = {
      ...deps.agentCronJobService,
      create: async (_agentId, input) => {
        capturedEnabled = input.enabled;
        return MOCK_CRON;
      },
    };
    const app = createAdminUIApp(deps);
    // When the checkbox is unchecked, browsers omit the field entirely
    const body = new URLSearchParams({
      schedule: "0 * * * *",
      prompt: "Test prompt",
      channel: "C123",
      // enabled field intentionally absent — simulates unchecked checkbox
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/crons`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    // When enabled is absent (unchecked), the handler should pass enabled=false
    expect(capturedEnabled).toBe(false);
  });

  it("POST /admin/agents/:id/crons passes enabled=true when checkbox is checked", async () => {
    let capturedEnabled: boolean | undefined;
    const deps = makeMockDeps();
    deps.agentCronJobService = {
      ...deps.agentCronJobService,
      create: async (_agentId, input) => {
        capturedEnabled = input.enabled;
        return MOCK_CRON;
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      schedule: "0 * * * *",
      prompt: "Test prompt",
      channel: "C123",
      enabled: "on",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/crons`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(capturedEnabled).toBe(true);
  });

  it("POST /admin/agents/:id/crons/:cronId/update redirects to agent detail and forwards user/silent", async () => {
    let capturedInput:
      | { user?: string | null; silent?: boolean; preCheck?: string | null }
      | undefined;
    const deps = makeMockDeps();
    deps.agentCronJobService = {
      ...deps.agentCronJobService,
      // existing cron is DM-routed (user set, channel null) — the route must
      // forward user/silent or the service's validateDeliveryTarget would throw.
      get: async () => ({
        ...MOCK_CRON,
        user: "U999",
        channel: null,
        silent: false,
        system: false,
      }),
      update: async (_a, _c, input) => {
        capturedInput = input;
        return MOCK_CRON;
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      schedule: "*/30 * * * *",
      prompt: "edited prompt",
      preCheck: "shipwright:check-dev-task.ts",
    });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/update`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
    expect(capturedInput?.user).toBe("U999");
    expect(capturedInput?.silent).toBe(false);
    expect(capturedInput?.preCheck).toBe("shipwright:check-dev-task.ts");
  });

  it("POST /admin/agents/:id/crons/:cronId/update redirects with error when schedule missing", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ prompt: "no schedule" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/update`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=");
  });

  it("POST /admin/agents/:id/crons/:cronId/update redirects with error for system crons (update NOT called)", async () => {
    let updateCalled = false;
    const deps = makeMockDeps();
    deps.agentCronJobService = {
      ...deps.agentCronJobService,
      get: async () => ({ ...MOCK_CRON, system: true }),
      update: async () => {
        updateCalled = true;
        return MOCK_CRON;
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ schedule: "0 * * * *", prompt: "x" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/update`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=");
    expect(updateCalled).toBe(false);
  });

  it("POST /admin/agents/:id/crons/:cronId/update redirects with error when the service throws", async () => {
    const deps = makeMockDeps();
    deps.agentCronJobService = {
      ...deps.agentCronJobService,
      get: async () => ({ ...MOCK_CRON, system: false }),
      update: async () => {
        throw new Error("invalid cron expression");
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      schedule: "not a cron",
      prompt: "x",
    });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/update`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=");
  });

  it("POST /admin/agents/:id/crons/:cronId/delete redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/delete`,
      {
        method: "POST",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/crons/:cronId/delete redirects with error for system crons", async () => {
    const deps = makeMockDeps();
    deps.agentCronJobService = {
      ...deps.agentCronJobService,
      get: async () => ({ ...MOCK_CRON, system: true }),
    };
    const app = createAdminUIApp(deps);
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/delete`,
      {
        method: "POST",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("error=");
    expect(decodeURIComponent(location)).toContain(
      "system crons cannot be deleted",
    );
  });

  it("POST /admin/agents/:id/crons/:cronId/toggle redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ enabled: "false" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/toggle`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });
});

// ─── Tool mutation routes ─────────────────────────────────────────────────────

describe("admin UI — tool mutation routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/tools with valid pattern redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ pattern: "Read" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/tools`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/tools with missing pattern redirects with error", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ pattern: "" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/tools`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/agents/${AGENT_ID}?error=missing_fields`,
    );
  });

  it("POST /admin/agents/:id/tools/:toolId/delete redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/tools/${TOOL_ID}/delete`,
      {
        method: "POST",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/tools/:toolId/toggle redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ enabled: "false" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/tools/${TOOL_ID}/toggle`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });
});

// ─── Token mutation routes ────────────────────────────────────────────────────

describe("admin UI — token mutation routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/tokens creates token and renders 200 with token inline", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ label: "my-token" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/tokens`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    // Token is rendered in a 200 HTML response — not redirected with ?newToken= in the URL,
    // which would expose the raw token in server access logs and browser history.
    expect(res.status).toBe(200);
    const responseHtml = await res.text();
    expect(responseHtml).toContain("sw_raw123456");
  });

  it("POST /admin/agents/:id/tokens/:tokenId/revoke redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/tokens/${TOKEN_ID}/revoke`,
      {
        method: "POST",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });
});

// ─── Provision start form ─────────────────────────────────────────────────────

describe("admin UI — provision start form", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("GET /admin/provision shows agent selector with agent options", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/provision", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="agentId"');
    expect(html).toContain("Test Agent");
    expect(html).toContain(AGENT_ID);
  });

  it("POST /admin/provision/start with missing agentId returns 400 or form error before Slack call", async () => {
    let slackCalled = false;
    const deps = makeMockDeps({
      slackClient: {
        createAppManifest: async () => {
          slackCalled = true;
          return {
            appId: "A123",
            oauthRedirectUrl: "https://slack.com/authorize",
            clientId: "cid",
            clientSecret: "csec",
            signingSecret: "ssec",
          };
        },
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      xoxpToken: "xoxe.xoxp-valid",
      ghAuthMode: "pat",
      ghPat: "ghp_token123",
    });
    const res = await app.request("/admin/provision/start", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(slackCalled).toBe(false);
    const html = await res.text();
    expect(html).toContain("alert-error");
  });

  it("POST /admin/provision/start with missing xoxpToken returns form error before Slack call", async () => {
    let slackCalled = false;
    const deps = makeMockDeps({
      slackClient: {
        createAppManifest: async () => {
          slackCalled = true;
          return {
            appId: "A123",
            oauthRedirectUrl: "https://slack.com/authorize",
            clientId: "cid",
            clientSecret: "csec",
            signingSecret: "ssec",
          };
        },
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      agentId: AGENT_ID,
      ghAuthMode: "pat",
      ghPat: "ghp_token123",
    });
    const res = await app.request("/admin/provision/start", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(slackCalled).toBe(false);
    const html = await res.text();
    expect(html).toContain("alert-error");
  });

  it("POST /admin/provision/start with ghAuthMode=pat + empty ghPat returns form error before Slack call", async () => {
    let slackCalled = false;
    const deps = makeMockDeps({
      slackClient: {
        createAppManifest: async () => {
          slackCalled = true;
          return {
            appId: "A123",
            oauthRedirectUrl: "https://slack.com/authorize",
            clientId: "cid",
            clientSecret: "csec",
            signingSecret: "ssec",
          };
        },
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      agentId: AGENT_ID,
      xoxpToken: "xoxe.xoxp-valid",
      ghAuthMode: "pat",
      ghPat: "",
    });
    const res = await app.request("/admin/provision/start", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(slackCalled).toBe(false);
    const html = await res.text();
    expect(html).toContain("alert-error");
  });

  it("POST /admin/provision/start with ghAuthMode=app + invalid ghAppId returns form error before Slack call", async () => {
    let slackCalled = false;
    const deps = makeMockDeps({
      slackClient: {
        createAppManifest: async () => {
          slackCalled = true;
          return {
            appId: "A123",
            oauthRedirectUrl: "https://slack.com/authorize",
            clientId: "cid",
            clientSecret: "csec",
            signingSecret: "ssec",
          };
        },
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      agentId: AGENT_ID,
      xoxpToken: "xoxe.xoxp-valid",
      ghAuthMode: "app",
      ghAppId: "not-a-number",
      ghAppInstallationId: "99999",
      ghAppPrivateKey:
        "-----BEGIN RSA PRIVATE KEY-----\nfoo\n-----END RSA PRIVATE KEY-----",
    });
    const res = await app.request("/admin/provision/start", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(slackCalled).toBe(false);
    const html = await res.text();
    expect(html).toContain("alert-error");
  });

  it("POST /admin/provision/start Slack error renders form error with NO env patch", async () => {
    let patchCalled = false;
    const deps = makeMockDeps({
      slackClient: {
        createAppManifest: async () => {
          throw new Error("Slack API error");
        },
      },
      agentEnvService: {
        getByAgentId: async () => ({ env: {}, secretKeys: [] }),
        upsert: async () => {},
        patch: async () => {
          patchCalled = true;
        },
        deleteKey: async () => {},
        getConfigBundle: async () => null,
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      agentId: AGENT_ID,
      xoxpToken: "xoxe.xoxp-valid",
      ghAuthMode: "pat",
      ghPat: "ghp_token123",
    });
    const res = await app.request("/admin/provision/start", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(patchCalled).toBe(false);
    const html = await res.text();
    expect(html).toContain("alert-error");
  });

  it("POST /admin/provision/start happy path (PAT): 200 with oauthUrl, cookie set, env patch with SLACK_APP_ID, SLACK_SIGNING_SECRET, GH_TOKEN", async () => {
    let patchArgs: [string, Record<string, string>] | null = null;
    const deps = makeMockDeps({
      slackClient: {
        createAppManifest: async () => ({
          appId: "A_HAPPY",
          oauthRedirectUrl: "https://slack.com/oauth/authorize?client_id=happy",
          clientId: "cid_happy",
          clientSecret: "csec_happy",
          signingSecret: "ssec_happy",
        }),
      },
      agentEnvService: {
        getByAgentId: async () => ({ env: {}, secretKeys: [] }),
        upsert: async () => {},
        patch: async (agentId: string, envVars: Record<string, string>) => {
          patchArgs = [agentId, envVars];
        },
        deleteKey: async () => {},
        getConfigBundle: async () => null,
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      agentId: AGENT_ID,
      xoxpToken: "xoxe.xoxp-valid",
      ghAuthMode: "pat",
      ghPat: "ghp_my_token",
    });
    const res = await app.request("/admin/provision/start", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("https://slack.com/oauth/authorize?client_id=happy");

    // Check cookie was set
    const setCookieHeader = res.headers.get("Set-Cookie") ?? "";
    expect(setCookieHeader).toContain("slack_provision_state=");
    expect(setCookieHeader).toContain("HttpOnly");
    expect(setCookieHeader).toContain("Secure");

    // Verify the JWT payload contains agentId
    const match = setCookieHeader.match(/slack_provision_state=([^;]+)/);
    expect(match).toBeTruthy();
    const jwtToken = decodeURIComponent(match?.[1] ?? "");
    // Decode JWT payload (middle part, base64url)
    const parts = jwtToken.split(".");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(
      Buffer.from(parts[1] ?? "", "base64url").toString("utf-8"),
    );
    expect(payload.agentId).toBe(AGENT_ID);
    expect(payload.appId).toBe("A_HAPPY");

    // Verify patch was called with correct env vars
    expect(patchArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(patchArgs).not.toBeNull() above
    const [patchedAgentId, envVars] = patchArgs!;
    expect(patchedAgentId).toBe(AGENT_ID);
    expect(envVars.SLACK_APP_ID).toBe("A_HAPPY");
    expect(envVars.SLACK_SIGNING_SECRET).toBe("ssec_happy");
    expect(envVars.SLACK_CLIENT_ID).toBe("cid_happy");
    expect(envVars.SLACK_CLIENT_SECRET).toBe("csec_happy");
    expect(envVars.GH_TOKEN).toBe("ghp_my_token");
  });

  it("POST /admin/provision/start with App auth: patch includes GH_APP_ID, GH_APP_INSTALLATION_ID, GH_APP_PRIVATE_KEY", async () => {
    let patchArgs: [string, Record<string, string>] | null = null;
    const deps = makeMockDeps({
      slackClient: {
        createAppManifest: async () => ({
          appId: "A_APP",
          oauthRedirectUrl: "https://slack.com/oauth/authorize?client_id=app",
          clientId: "cid_app",
          clientSecret: "csec_app",
          signingSecret: "ssec_app",
        }),
      },
      agentEnvService: {
        getByAgentId: async () => ({ env: {}, secretKeys: [] }),
        upsert: async () => {},
        patch: async (agentId: string, envVars: Record<string, string>) => {
          patchArgs = [agentId, envVars];
        },
        deleteKey: async () => {},
        getConfigBundle: async () => null,
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      agentId: AGENT_ID,
      xoxpToken: "xoxe.xoxp-valid",
      ghAuthMode: "app",
      ghAppId: "12345",
      ghAppInstallationId: "67890",
      ghAppPrivateKey:
        "-----BEGIN RSA PRIVATE KEY-----\nfoo\n-----END RSA PRIVATE KEY-----",
    });
    const res = await app.request("/admin/provision/start", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    expect(patchArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(patchArgs).not.toBeNull() above
    const [, envVars] = patchArgs!;
    expect(envVars.GH_APP_ID).toBe("12345");
    expect(envVars.GH_APP_INSTALLATION_ID).toBe("67890");
    expect(envVars.GH_APP_PRIVATE_KEY).toContain("BEGIN RSA PRIVATE KEY");
    expect(envVars).not.toHaveProperty("GH_TOKEN");
  });

  it("POST /admin/provision/start with AI creds: patch includes ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN", async () => {
    let patchArgs: [string, Record<string, string>] | null = null;
    const deps = makeMockDeps({
      slackClient: {
        createAppManifest: async () => ({
          appId: "A_AI",
          oauthRedirectUrl: "https://slack.com/oauth/authorize?client_id=ai",
          clientId: "cid_ai",
          clientSecret: "csec_ai",
          signingSecret: "ssec_ai",
        }),
      },
      agentEnvService: {
        getByAgentId: async () => ({ env: {}, secretKeys: [] }),
        upsert: async () => {},
        patch: async (agentId: string, envVars: Record<string, string>) => {
          patchArgs = [agentId, envVars];
        },
        deleteKey: async () => {},
        getConfigBundle: async () => null,
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      agentId: AGENT_ID,
      xoxpToken: "xoxe.xoxp-valid",
      ghAuthMode: "pat",
      ghPat: "ghp_token",
      anthropicApiKey: "sk-ant-key",
      claudeCodeOauthToken: "oauth-token-xyz",
    });
    const res = await app.request("/admin/provision/start", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    expect(patchArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(patchArgs).not.toBeNull() above
    const [, envVars] = patchArgs!;
    expect(envVars.ANTHROPIC_API_KEY).toBe("sk-ant-key");
    expect(envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token-xyz");
  });

  it("POST /admin/provision/start agentMode=new happy path: creates agent, provisions it (non-self-hosted), and reaches oauthUrl success state", async () => {
    const NEW_AGENT_ID = "agent-new-999";
    let createArgs: { name: string; selfHosted?: boolean } | null = null;
    let updateArgs: { id: string; repos: string[] } | null = null;
    let provisionArgs: { id: string; opts: { slug: string } } | null = null;

    const deps = makeMockDeps({
      prisma: {
        agent: {
          findMany: async () => [
            {
              id: AGENT_ID,
              name: "Test Agent",
              slackId: "U123456",
              createdAt: new Date("2024-01-01"),
            },
          ],
          findUnique: async () => ({
            id: NEW_AGENT_ID,
            name: "brand-new-agent",
            slackId: null,
            selfHosted: false,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: ["my-org/repo-one"],
          }),
          create: async (args: {
            data: { name: string; selfHosted?: boolean };
          }) => {
            createArgs = args.data;
            return {
              id: NEW_AGENT_ID,
              name: args.data.name,
              slackId: null,
              selfHosted: args.data.selfHosted ?? false,
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
            };
          },
          update: async (args: {
            where: { id: string };
            data: { repos: string[] };
          }) => {
            updateArgs = { id: args.where.id, repos: args.data.repos };
            return {
              id: args.where.id,
              name: "brand-new-agent",
              slackId: null,
              selfHosted: false,
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: args.data.repos,
            };
          },
          delete: async () => ({
            id: NEW_AGENT_ID,
            name: "brand-new-agent",
            slackId: null,
            selfHosted: false,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
        },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [],
          findUnique: async () => null,
          create: async () => ({
            id: "m1",
            agentId: NEW_AGENT_ID,
            email: "member@example.com",
          }),
          deleteMany: async () => ({ count: 0 }),
        },
      },
      slackClient: {
        createAppManifest: async () => ({
          appId: "A_NEW",
          oauthRedirectUrl: "https://slack.com/oauth/authorize?client_id=new",
          clientId: "cid_new",
          clientSecret: "csec_new",
          signingSecret: "ssec_new",
        }),
      },
      provisioner: {
        provision: async (id: string, opts: { slug: string }) => {
          provisionArgs = { id, opts };
          return { resourceName: "r", secretName: "s", deploymentName: "d" };
        },
        deprovision: async () => {},
        reconcile: async () => ({
          recreated: [],
          updated: [],
          orphans: [],
          failed: [],
        }),
      },
    });

    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      agentMode: "new",
      newAgentName: "brand-new-agent",
      newAgentRepos: "my-org/repo-one",
      xoxpToken: "xoxe.xoxp-valid",
      ghAuthMode: "pat",
      ghPat: "ghp_token123",
    });
    const res = await app.request("/admin/provision/start", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("https://slack.com/oauth/authorize?client_id=new");

    expect(createArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded above
    const created = createArgs!;
    expect(created.name).toBe("brand-new-agent");
    expect(created.selfHosted).toBe(false);

    expect(updateArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded above
    const updated = updateArgs!;
    expect(updated.id).toBe(NEW_AGENT_ID);
    expect(updated.repos).toEqual(["my-org/repo-one"]);

    expect(provisionArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded above
    const provisioned = provisionArgs!;
    expect(provisioned.id).toBe(NEW_AGENT_ID);
    expect(provisioned.opts.slug).toBe("brand-new-agent");
  });

  it("POST /admin/provision/start agentMode=new rolls back the agent row when provisioning fails", async () => {
    const NEW_AGENT_ID = "agent-new-fail-999";
    let deleteCalledWith: string | null | undefined;

    const deps = makeMockDeps({
      prisma: {
        agent: {
          findMany: async () => [],
          findUnique: async () => ({
            id: NEW_AGENT_ID,
            name: "doomed-agent",
            slackId: null,
            selfHosted: false,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          create: async () => ({
            id: NEW_AGENT_ID,
            name: "doomed-agent",
            slackId: null,
            selfHosted: false,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          update: async (args: {
            where: { id: string };
            data: { repos: string[] };
          }) => ({
            id: args.where.id,
            name: "doomed-agent",
            slackId: null,
            selfHosted: false,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: args.data.repos,
          }),
          delete: async (args: { where: { id: string } }) => {
            deleteCalledWith = args.where.id;
            return {
              id: args.where.id,
              name: "doomed-agent",
              slackId: null,
              selfHosted: false,
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
            };
          },
        },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [],
          findUnique: async () => null,
          create: async () => ({
            id: "m1",
            agentId: NEW_AGENT_ID,
            email: "member@example.com",
          }),
          deleteMany: async () => ({ count: 0 }),
        },
      },
      provisioner: {
        provision: async () => {
          throw new Error("provisioning exploded");
        },
        deprovision: async () => {},
        reconcile: async () => ({
          recreated: [],
          updated: [],
          orphans: [],
          failed: [],
        }),
      },
    });

    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      agentMode: "new",
      newAgentName: "doomed-agent",
      xoxpToken: "xoxe.xoxp-valid",
      ghAuthMode: "pat",
      ghPat: "ghp_token123",
    });
    const res = await app.request("/admin/provision/start", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });

    expect(deleteCalledWith).toBe(NEW_AGENT_ID);
    const html = await res.text();
    expect(html).toContain("alert-error");
    expect(html).not.toContain('href="https://slack.com');
  });
});

// ─── Member access control ────────────────────────────────────────────────────

describe("admin UI — member access control", () => {
  const MEMBER_EMAIL = "member@example.com";

  it("non-admin member can view their agent detail", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      MEMBER_EMAIL,
      false,
    );
    const deps = makeMockDeps({
      prisma: {
        agent: {
          findMany: async () => [],
          findUnique: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            selfHosted: false,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          create: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          delete: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
        },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [],
          findUnique: async ({
            where,
          }: {
            where: { agentId_email: { agentId: string; email: string } };
          }) =>
            where.agentId_email.email === MEMBER_EMAIL
              ? { id: "m1", agentId: AGENT_ID, email: MEMBER_EMAIL }
              : null,
          create: async () => ({
            id: "m1",
            agentId: AGENT_ID,
            email: MEMBER_EMAIL,
          }),
          deleteMany: async () => ({ count: 0 }),
        },
      },
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(res.status).toBe(200);
  });

  it("non-admin non-member gets 403 on agent detail", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${outsiderCookie}` },
    });
    expect(res.status).toBe(403);
  });

  it("non-admin sees only their agents in the agents list", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      MEMBER_EMAIL,
      false,
    );
    const OTHER_AGENT_ID = "agent-other-456";
    const deps = makeMockDeps({
      prisma: {
        agent: {
          findMany: async ({
            where,
          }: { where?: { id?: { in?: string[] } } } = {}) => {
            const allAgents = [
              {
                id: AGENT_ID,
                name: "My Agent",
                slackId: "U1",
                createdAt: new Date("2024-01-01"),
              },
              {
                id: OTHER_AGENT_ID,
                name: "Other Agent",
                slackId: "U2",
                createdAt: new Date("2024-01-01"),
              },
            ];
            if (where?.id?.in) {
              return allAgents.filter((a) => where.id?.in?.includes(a.id));
            }
            return allAgents;
          },
          findUnique: async () => null,
          create: async () => ({
            id: AGENT_ID,
            name: "My Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "My Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          delete: async () => ({
            id: AGENT_ID,
            name: "My Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
        },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [
            {
              id: "m1",
              agentId: AGENT_ID,
              email: MEMBER_EMAIL,
              createdAt: new Date(),
            },
          ],
          findUnique: async () => null,
          create: async () => ({
            id: "m1",
            agentId: AGENT_ID,
            email: MEMBER_EMAIL,
          }),
          deleteMany: async () => ({ count: 0 }),
        },
      },
    });
    const app = createAdminUIApp(deps);
    const res = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("My Agent");
    expect(html).not.toContain("Other Agent");
  });

  it("non-admin gets 403 on GET /admin/provision", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      MEMBER_EMAIL,
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/provision", {
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(res.status).toBe(403);
  });

  it("OAuth callback grants member access to non-admin with a matching membership", async () => {
    const nonce = "test-nonce-member";
    const params = new URLSearchParams({
      state: nonce,
      code: "auth-code-member",
    });
    const oauthState = encodeURIComponent(JSON.stringify({ nonce }));
    const deps = makeMockDeps({
      googleClient: makeGoogleClient({
        getUserInfo: () =>
          Promise.resolve({
            sub: "google-sub-member",
            email: MEMBER_EMAIL,
            email_verified: true,
            name: "Member User",
          }),
      }),
      prisma: {
        agent: {
          findMany: async () => [],
          findUnique: async () => null,
          create: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          delete: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
        },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [
            {
              id: "m1",
              agentId: AGENT_ID,
              email: MEMBER_EMAIL,
              createdAt: new Date(),
            },
          ],
          findUnique: async () => null,
          create: async () => ({
            id: "m1",
            agentId: AGENT_ID,
            email: MEMBER_EMAIL,
          }),
          deleteMany: async () => ({ count: 0 }),
        },
      },
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(
      new Request(
        `https://example.com/admin/auth/callback?${params.toString()}`,
        {
          headers: { Cookie: `oauth_state=${oauthState}` },
        },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("admin_session=");
  });

  it("OAuth callback returns 403 for non-admin with no membership", async () => {
    const nonce = "test-nonce-outsider";
    const params = new URLSearchParams({
      state: nonce,
      code: "auth-code-outsider",
    });
    const oauthState = encodeURIComponent(JSON.stringify({ nonce }));
    const app = createAdminUIApp(
      makeMockDeps({
        googleClient: makeGoogleClient({
          getUserInfo: () =>
            Promise.resolve({
              sub: "google-sub-outsider",
              email: "outsider@example.com",
              email_verified: true,
              name: "Outsider",
            }),
        }),
      }),
    );
    const res = await app.request(
      new Request(
        `https://example.com/admin/auth/callback?${params.toString()}`,
        {
          headers: { Cookie: `oauth_state=${oauthState}` },
        },
      ),
    );
    expect(res.status).toBe(403);
  });
});

// ─── Agent delete route ───────────────────────────────────────────────────────

describe("admin UI — agent delete route", () => {
  let adminCookie: string;
  let nonAdminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
    nonAdminCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      "member@example.com",
      false,
    );
  });

  it("admin POST /admin/agents/:id/delete → 302 redirect to /admin/agents?success=deleted", async () => {
    let deprovisioned: string | null = null;
    let deleted: string | null = null;
    const deps = makeMockDeps({
      provisioner: {
        provision: async () => ({
          resourceName: "r",
          secretName: "s",
          deploymentName: "d",
        }),
        deprovision: async (agentId: string) => {
          deprovisioned = agentId;
        },
        reconcile: async () => ({
          recreated: [],
          updated: [],
          orphans: [],
          failed: [],
        }),
      },
      prisma: {
        agent: {
          findMany: async () => [],
          findUnique: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            selfHosted: false,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          create: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          delete: async ({ where }: { where: { id: string } }) => {
            deleted = where.id;
            return {
              id: where.id,
              name: "Test Agent",
              slackId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              repos: [],
            };
          },
        },
        agentPlugin: { findMany: async () => [] },
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
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/agents/${AGENT_ID}/delete`, {
      method: "POST",
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents?success=deleted");
    // biome-ignore lint/style/noNonNullAssertion: set by the spy closure above
    expect(deprovisioned!).toBe(AGENT_ID);
    // biome-ignore lint/style/noNonNullAssertion: set by the spy closure above
    expect(deleted!).toBe(AGENT_ID);
  });

  it("non-admin POST /admin/agents/:id/delete → 403", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}/delete`, {
      method: "POST",
      headers: { Cookie: `admin_session=${nonAdminCookie}` },
    });
    expect(res.status).toBe(403);
  });
});

// ─── Member management routes ─────────────────────────────────────────────────

describe("admin UI — member management routes", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  it("admin can add a member via POST /admin/agents/:id/members", async () => {
    let created: { agentId: string; email: string } | null = null;
    const deps = makeMockDeps({
      prisma: {
        agent: {
          findMany: async () => [],
          findUnique: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            selfHosted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          create: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          delete: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
        },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [],
          findUnique: async () => null,
          create: async ({
            data,
          }: { data: { agentId: string; email: string } }) => {
            created = data;
            return { id: "m-new", ...data };
          },
          deleteMany: async () => ({ count: 0 }),
        },
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ email: "newmember@example.com" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/members`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(created).not.toBeNull();
    expect((created as { agentId: string; email: string } | null)?.email).toBe(
      "newmember@example.com",
    );
  });

  it("admin can remove a member via POST /admin/agents/:id/members/delete", async () => {
    let deletedId: string | null = null;
    const deps = makeMockDeps({
      prisma: {
        agent: {
          findMany: async () => [],
          findUnique: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            selfHosted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          create: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          delete: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
        },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [],
          findUnique: async () => null,
          create: async () => ({
            id: "m1",
            agentId: AGENT_ID,
            email: "member@example.com",
          }),
          deleteMany: async ({
            where,
          }: { where: { id: string; agentId: string } }) => {
            deletedId = where.id;
            return { count: 1 };
          },
        },
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ memberId: "m1" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/members/delete`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(deletedId as string | null).toBe("m1");
  });

  it("non-admin gets 403 on POST /admin/agents/:id/members", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      "member@example.com",
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ email: "new@example.com" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/members`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${memberCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });
});

describe("admin UI — manifest sync route", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  it("happy path: valid token + SLACK_APP_ID set → redirects to ?success=manifest_synced", async () => {
    let updateCalled = false;
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => ({
            env: { SLACK_APP_ID: "A123456" },
            agentId: AGENT_ID,
            allowedTools: [],
          }),
        },
        slackClient: {
          updateAppManifest: async () => {
            updateCalled = true;
          },
        },
      }),
    );
    const body = new URLSearchParams({ xoxpToken: "xoxe.xoxp-valid-token" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("success=manifest_synced");
    expect(updateCalled).toBe(true);
  });

  it("invalid token (wrong prefix) → redirects with error", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ xoxpToken: "xoxb-wrong-token-type" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=");
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(
      "Slack app configuration token must start with xoxe.xoxp-",
    );
  });

  it("xoxe.xoxp rotating token → passes token validation", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({
      xoxpToken: "xoxe.xoxp-valid-rotating-token",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    // Token passes validation; redirect (if any) is for a different reason (e.g. missing SLACK_APP_ID)
    expect(decodeURIComponent(res.headers.get("location") ?? "")).not.toContain(
      "Slack app configuration token must start with",
    );
  });

  it("missing SLACK_APP_ID env var → redirects with error", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );
    const body = new URLSearchParams({ xoxpToken: "xoxe.xoxp-valid-token" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(
      "SLACK_APP_ID is not set",
    );
  });

  it("Slack client throws → redirects with the error message", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => ({
            env: { SLACK_APP_ID: "A123456" },
            agentId: AGENT_ID,
            allowedTools: [],
          }),
        },
        slackClient: {
          updateAppManifest: async () => {
            throw new Error("slack_api_error");
          },
        },
      }),
    );
    const body = new URLSearchParams({ xoxpToken: "xoxe.xoxp-valid-token" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(
      "slack_api_error",
    );
  });

  it("access denied: non-admin non-member → 403", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ xoxpToken: "xoxe.xoxp-valid-token" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${outsiderCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("sync-manifest with SLACK_CLIENT_ID/SECRET/SIGNING_SECRET in env → 302 to slack.com/oauth/v2/authorize with provision state cookie set", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => ({
            env: {
              SLACK_APP_ID: "A123456",
              SLACK_CLIENT_ID: "my-client-id",
              SLACK_CLIENT_SECRET: "my-client-secret",
              SLACK_SIGNING_SECRET: "my-signing-secret",
            },
            agentId: AGENT_ID,
            allowedTools: [],
          }),
        },
        slackClient: {
          updateAppManifest: async () => {},
        },
      }),
    );
    const body = new URLSearchParams({ xoxpToken: "xoxe.xoxp-valid-token" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("slack.com/oauth/v2/authorize");
    expect(location).toContain("client_id=my-client-id");
    // Provision state cookie should be set
    const setCookieHeader = res.headers.get("Set-Cookie") ?? "";
    expect(setCookieHeader).toContain("slack_provision_state=");
    // Verify JWT payload — a bug encoding the wrong agentId or clientId
    // would pass the presence check above but be caught here
    const tokenMatch = setCookieHeader.match(/slack_provision_state=([^;]+)/);
    expect(tokenMatch).not.toBeNull();
    const jwtPayload = JSON.parse(
      Buffer.from(tokenMatch?.[1].split(".")[1] ?? "", "base64url").toString(),
    );
    expect(jwtPayload.agentId).toBe(AGENT_ID);
    expect(jwtPayload.clientId).toBe("my-client-id");
  });

  it("sync-manifest with no SLACK_CLIENT_ID in env (legacy agent) → 302 to ?success=manifest_synced", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => ({
            env: {
              SLACK_APP_ID: "A123456",
              // No SLACK_CLIENT_ID — legacy agent
            },
            agentId: AGENT_ID,
            allowedTools: [],
          }),
        },
        slackClient: {
          updateAppManifest: async () => {},
        },
      }),
    );
    const body = new URLSearchParams({ xoxpToken: "xoxe.xoxp-valid-token" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("success=manifest_synced");
    expect(res.headers.get("Set-Cookie") ?? "").not.toContain(
      "slack_provision_state=",
    );
  });
});

// ─── Tasks page ───────────────────────────────────────────────────────────────

describe("admin UI — tasks page", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("GET /admin/tasks?state=in_progress&status=pr_open forwards only status to task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/tasks?state=in_progress&status=pr_open", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].get("status")).toBe("pr_open");
    expect(capturedParams[0].has("state")).toBe(false);
  });

  it("GET /admin/tasks?state=ready forwards state to task store when no status set", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/tasks?state=ready", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].get("state")).toBe("ready");
    expect(capturedParams[0].has("status")).toBe(false);
  });

  it("GET /admin/tasks with no params forwards neither state nor status", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].has("state")).toBe(false);
    expect(capturedParams[0].has("status")).toBe(false);
  });

  it("GET /admin/tasks renders tasks table with mock data", async () => {
    const mockTasks = [
      {
        id: "task-1",
        title: "Build auth module",
        status: "pending",
        session: "session-abc",
        repo: "example-org/example-repo",
        assignee: null,
        claimedBy: null,
      },
      {
        id: "task-2",
        title: "Fix login bug",
        status: "in_progress",
        session: "session-abc",
        repo: "example-org/example-repo",
        assignee: "dmcaulay",
        claimedBy: "agent-123",
      },
    ];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Build auth module");
    expect(html).toContain("Fix login bug");
    expect(html).toContain("Tasks");
  });

  it("GET /admin/tasks renders degraded notice when taskStoreUrl is absent", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        // No fetchTaskStoreTasks provided — simulates missing SHIPWRIGHT_TASK_STORE_URL
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Task store unavailable");
  });

  it("GET /admin/tasks unauthenticated redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/tasks");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });

  it("GET /admin/tasks shows Release button only for in_progress tasks", async () => {
    const mockTasks = [
      {
        id: "task-1",
        title: "Pending task",
        status: "pending",
        session: null,
        repo: null,
        assignee: null,
        claimedBy: null,
      },
      {
        id: "task-2",
        title: "In progress task",
        status: "in_progress",
        session: null,
        repo: null,
        assignee: null,
        claimedBy: "agent-123",
      },
    ];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/admin/tasks/task-2/release");
    expect(html).not.toContain("/admin/tasks/task-1/release");
  });

  it("GET /admin/tasks?agent= filters by agent name (case-insensitive)", async () => {
    // makeMockDeps prisma.agent.findMany returns the agent with id AGENT_ID, name "Test Agent"
    const mockTasks = [
      {
        id: "task-1",
        title: "Task for Test Agent",
        status: "pending",
        session: null,
        repo: null,
        assignee: AGENT_ID,
        claimedBy: null,
      },
      {
        id: "task-2",
        title: "Unassigned task",
        status: "pending",
        session: null,
        repo: null,
        assignee: null,
        claimedBy: null,
      },
    ];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/tasks?agent=test", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Task for Test Agent");
    expect(html).not.toContain("Unassigned task");
  });

  it("POST /admin/tasks/:id/release calls releaseTask and redirects to task detail when fetchTaskStoreTask is wired", async () => {
    const released: string[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
        fetchTaskStoreTask: async () => null,
        releaseTask: async (id: string) => {
          released.push(id);
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-2/release", {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/tasks/task-2");
    expect(released).toEqual(["task-2"]);
  });

  it("POST /admin/tasks/:id/release redirects to task list in degraded mode (no fetchTaskStoreTask)", async () => {
    const released: string[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
        releaseTask: async (id: string) => {
          released.push(id);
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-2/release", {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/tasks");
    expect(released).toEqual(["task-2"]);
  });

  it("POST /admin/tasks/:id/release redirects with ?error=release_failed when releaseTask throws", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
        releaseTask: async () => {
          throw new Error("task store unavailable");
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-2/release", {
      method: "POST",
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/tasks?error=release_failed",
    );
  });

  it("GET /admin/tasks/:id renders task detail page", async () => {
    const mockTask = {
      id: "task-42",
      title: "Build the thing",
      status: "in_progress",
      description: "Do the work",
      branch: "feat/thing",
      assignee: "agent-unknown",
      claimedBy: "agent-unknown",
      session: null,
      repo: "org/repo",
      claimedAt: "2024-01-15T10:00:00.000Z",
    };
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
      }),
    );
    const res = await app.request("/admin/tasks/task-42", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Build the thing");
    expect(html).toContain("Do the work");
    expect(html).toContain("feat/thing");
    expect(html).toContain("← Tasks");
    // Unknown agent ID shown as raw ID (no name resolution)
    expect(html).toContain("agent-unknown");
  });

  it("GET /admin/tasks/:id resolves agent IDs to names", async () => {
    const mockTask = {
      id: "task-43",
      title: "Task with known agent",
      status: "in_progress",
      assignee: AGENT_ID,
      claimedBy: AGENT_ID,
      session: null,
      repo: null,
    };
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-43" ? mockTask : null,
      }),
    );
    const res = await app.request("/admin/tasks/task-43", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Name resolved from the admin DB — shown as "Test Agent (agent-test-123)"
    expect(html).toContain("Test Agent");
    expect(html).toContain(AGENT_ID);
  });

  it("GET /admin/tasks/:id redirects to list when task not found", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async () => null,
      }),
    );
    const res = await app.request("/admin/tasks/missing-task", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/tasks?error=task_not_found",
    );
  });

  it("GET /admin/tasks/:id degrades when fetchTaskStoreTask not provided", async () => {
    const app = createAdminUIApp(makeMockDeps({}));
    const res = await app.request("/admin/tasks/task-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/tasks?error=task_store_unavailable",
    );
  });

  it("GET /admin/tasks/:id renders PR section when fetchTaskStorePr returns a result", async () => {
    const mockTask = {
      id: "task-42",
      title: "Build the thing",
      status: "in_progress",
      description: "Do the work",
      branch: "feat/thing",
      assignee: "agent-unknown",
      claimedBy: "agent-unknown",
      session: null,
      repo: "org/repo",
      claimedAt: "2024-01-15T10:00:00.000Z",
    };
    const MOCK_PR_ITEM: PullRequestItem = {
      id: "pr-test-1",
      repo: "app-vitals/shipwright",
      prNumber: 100,
      state: "open",
      reviewState: "approved",
      patchCycles: 1,
      reviewCycles: 0,
      reviewedAt: "2026-06-20T10:00:00Z",
      patchedAt: null,
    };
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
        fetchTaskStorePr: async (_id: string) => MOCK_PR_ITEM,
      }),
    );
    const res = await app.request("/admin/tasks/task-42", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Pull Request Review");
    expect(html).toContain("#100");
  });

  it("GET /admin/tasks/:id renders without PR section when fetchTaskStorePr throws", async () => {
    const mockTask = {
      id: "task-42",
      title: "Build the thing",
      status: "in_progress",
      description: "Do the work",
      branch: "feat/thing",
      assignee: "agent-unknown",
      claimedBy: "agent-unknown",
      session: null,
      repo: "org/repo",
      claimedAt: "2024-01-15T10:00:00.000Z",
    };
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
        fetchTaskStorePr: async (_id: string) => {
          throw new Error("task store unavailable");
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-42", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Pull Request Review");
  });

  it("GET /admin/tasks/:id renders without PR section when fetchTaskStorePr is absent", async () => {
    const mockTask = {
      id: "task-42",
      title: "Build the thing",
      status: "in_progress",
      description: "Do the work",
      branch: "feat/thing",
      assignee: "agent-unknown",
      claimedBy: "agent-unknown",
      session: null,
      repo: "org/repo",
      claimedAt: "2024-01-15T10:00:00.000Z",
    };
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
      }),
    );
    const res = await app.request("/admin/tasks/task-42", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Pull Request Review");
  });

  it("GET /admin/tasks with no ?state= forwards no state to task-store (show all)", async () => {
    let capturedParams: URLSearchParams | null = null;
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params: URLSearchParams) => {
          capturedParams = params;
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(capturedParams).not.toBeNull();
    expect(
      (capturedParams as unknown as URLSearchParams).get("state"),
    ).toBeNull();
  });

  it("GET /admin/tasks?state=blocked returns 200 and forwards state=blocked to task-store", async () => {
    let capturedParams: URLSearchParams | null = null;
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params: URLSearchParams) => {
          capturedParams = params;
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/tasks?state=blocked", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(capturedParams).not.toBeNull();
    expect((capturedParams as unknown as URLSearchParams).get("state")).toBe(
      "blocked",
    );
  });
});

describe("admin UI — repos mutation routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/repos/add returns 403 for non-admin non-member", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ repo: "org/repo" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/repos/add`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${outsiderCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("POST /admin/agents/:id/repos/add with invalid repo format redirects with error=invalid_repo_format", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ repo: "not-a-valid-repo" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/repos/add`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/agents/${AGENT_ID}?error=invalid_repo_format`,
    );
  });

  it("POST /admin/agents/:id/repos/add returns 404 when agent not found", async () => {
    const deps = makeMockDeps();
    deps.prisma = {
      ...deps.prisma,
      agent: {
        ...deps.prisma.agent,
        findUnique: async () => null,
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ repo: "org/repo" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/repos/add`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(404);
  });

  it("POST /admin/agents/:id/repos/add with valid repo redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ repo: "my-org/my-repo" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/repos/add`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/repos/add deduplicates — does not add the same repo twice", async () => {
    let capturedRepos: string[] | undefined;
    const deps = makeMockDeps();
    deps.prisma = {
      ...deps.prisma,
      agent: {
        ...deps.prisma.agent,
        findUnique: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: ["my-org/my-repo"],
        }),
        update: async (_args: {
          where: unknown;
          data: { repos: string[] };
        }) => {
          capturedRepos = _args.data.repos;
          return {
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: capturedRepos,
          };
        },
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ repo: "my-org/my-repo" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/repos/add`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    // update should not have been called — no-op deduplication returns existing list
    // If update was called, repos should still be exactly ["my-org/my-repo"]
    if (capturedRepos !== undefined) {
      expect(capturedRepos).toEqual(["my-org/my-repo"]);
    }
  });

  it("POST /admin/agents/:id/repos/delete with valid repo redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ repo: "my-org/my-repo" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/repos/delete`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });
});

// ─── PRs page ─────────────────────────────────────────────────────────────────

describe("admin UI — PRs page", () => {
  let cookie: string;
  let nonAdminCookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
    nonAdminCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      "member@example.com",
      false,
    );
  });

  const MOCK_PR: PrListItem = {
    id: "pr-smoke-1",
    repo: "app-vitals/shipwright",
    prNumber: 42,
    taskId: "task-abc",
    staged: false,
    state: "open",
    reviewState: "in_review",
    patchCycles: 0,
    reviewCycles: 0,
    agentId: null,
    claimedBy: null,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z",
  };

  it("GET /admin/prs returns 200 with PR table data when fetchTaskStorePrs is injected", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [MOCK_PR],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("app-vitals/shipwright");
    expect(html).toContain("#42");
  });

  it("GET /admin/prs returns 200 with degraded warning banner when fetchTaskStorePrs is absent", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        // fetchTaskStorePrs intentionally absent — degraded mode
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("PR store unavailable");
  });

  it("GET /admin/prs/:id returns 200 with PR detail when fetchTaskStorePrById is injected and returns a PR", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? MOCK_PR : null,
      }),
    );
    const res = await app.request("/admin/prs/pr-smoke-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("app-vitals/shipwright");
    expect(html).toContain("42");
  });

  it("GET /admin/prs unauthenticated redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/prs");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });

  it("GET /admin/prs returns 403 for non-admin authenticated user", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${nonAdminCookie}` },
    });
    expect(res.status).toBe(403);
  });
});

// ─── Public task board ────────────────────────────────────────────────────────

describe("admin UI — public task board", () => {
  const PUBLIC_REPO = "app-vitals/shipwright";

  const MOCK_PUBLIC_TASKS = [
    {
      id: "pub-task-1",
      title: "Public task alpha",
      status: "pending",
      session: "sess-pub",
      repo: PUBLIC_REPO,
      assignee: null,
      claimedBy: null,
    },
    {
      id: "pub-task-2",
      title: "Public task beta",
      status: "in_progress",
      session: "sess-pub",
      repo: PUBLIC_REPO,
      assignee: null,
      claimedBy: "agent-pub",
    },
  ];

  it("GET /public/tasks returns 200 without any auth header or cookie", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return {
            tasks: MOCK_PUBLIC_TASKS,
            total: MOCK_PUBLIC_TASKS.length,
            limit: 50,
            offset: 0,
          };
        },
      }),
    );
    // No Cookie, no Authorization header — must still return 200
    const res = await app.request("/public/tasks");
    expect(res.status).toBe(200);
  });

  it("GET /public/tasks passes SHIPWRIGHT_ADMIN_PUBLIC_REPO as repo filter param", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/public/tasks");
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].get("repo")).toBe(PUBLIC_REPO);
  });

  it("GET /public/tasks renders task rows but NO create/edit/release controls", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async () => ({
          tasks: MOCK_PUBLIC_TASKS,
          total: MOCK_PUBLIC_TASKS.length,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/public/tasks");
    expect(res.status).toBe(200);
    const html = await res.text();
    // Task rows are present
    expect(html).toContain("Public task alpha");
    expect(html).toContain("Public task beta");
    // No create/edit/status-change controls
    expect(html).not.toContain("Release");
    expect(html).not.toContain("/admin/");
    expect(html).not.toContain("admin_session");
  });

  it("GET /public/tasks renders 200 even when no publicRepo configured (degraded mode)", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        // publicRepo absent — degraded mode, no task store call
      }),
    );
    const res = await app.request("/public/tasks");
    expect(res.status).toBe(200);
  });

  it("POST /public/tasks returns 404 or 405 (mutation routes absent)", async () => {
    const app = createAdminUIApp(makeMockDeps({ publicRepo: PUBLIC_REPO }));
    const res = await app.request("/public/tasks", { method: "POST" });
    expect([404, 405]).toContain(res.status);
  });

  it("PUT /public/tasks/pub-task-1 returns 404 or 405", async () => {
    const app = createAdminUIApp(makeMockDeps({ publicRepo: PUBLIC_REPO }));
    const res = await app.request("/public/tasks/pub-task-1", {
      method: "PUT",
    });
    expect([404, 405]).toContain(res.status);
  });

  it("DELETE /public/tasks/pub-task-1 returns 404 or 405", async () => {
    const app = createAdminUIApp(makeMockDeps({ publicRepo: PUBLIC_REPO }));
    const res = await app.request("/public/tasks/pub-task-1", {
      method: "DELETE",
    });
    expect([404, 405]).toContain(res.status);
  });

  it("GET /public/tasks suppresses pagination even when total > 50", async () => {
    // When the public board has more than 50 tasks, pagination links must NOT
    // appear — makePageUrl hardcodes /admin/tasks, which is auth-walled.
    const manyTasks = Array.from({ length: 50 }, (_, i) => ({
      id: `pub-task-${i}`,
      title: `Public task ${i}`,
      status: "pending",
      session: "sess-pub",
      repo: PUBLIC_REPO,
      assignee: null,
      claimedBy: null,
    }));
    const app = createAdminUIApp(
      makeMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async () => ({
          tasks: manyTasks,
          total: 500, // >50 — would trigger pagination in admin mode
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/public/tasks");
    expect(res.status).toBe(200);
    const body = await res.text();
    // No pagination links should point to the auth-walled admin route
    expect(body).not.toContain("/admin/tasks");
    expect(body).not.toContain("Next →");
    expect(body).not.toContain("← Prev");
  });

  it("GET /public/tasks with pr set and repo null never renders github.com//pull/ in body", async () => {
    // Regression guard: a task with pr set but repo null must not produce a
    // broken href containing github.com//pull/ in the public task board.
    const dirtyTask = {
      id: "pub-dirty-1",
      title: "Dirty PR task",
      status: "pending",
      session: null,
      repo: null, // repo is null — the bug would produce github.com//pull/5
      pr: 5,
      assignee: null,
      claimedBy: null,
    };
    const app = createAdminUIApp(
      makeMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async () => ({
          tasks: [dirtyTask],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/public/tasks");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("github.com//pull/");
  });
});
