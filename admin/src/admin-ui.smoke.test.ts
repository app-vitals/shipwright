/**
 * agent/src/admin-ui.smoke.test.ts
 * Smoke tests for the Admin UI shell (admin-ui.ts).
 *
 * Uses app.request() — no real server, no real DB.
 * Services are injected as in-memory test doubles.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
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
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        }),
        create: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        }),
        delete: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        }),
      },
      agentPlugin: {
        findMany: async () => [],
      },
      agentMember: {
        findMany: async () => [],
        findUnique: async () => null,
        create: async () => ({ id: "m1", agentId: AGENT_ID, email: "member@example.com" }),
        deleteMany: async () => ({ count: 0 }),
      },
    },
    agentEnvService: {
      getByAgentId: async () => ({ FOO: "bar" }),
      upsert: async () => {},
      deleteKey: async () => {},
      getConfigBundle: async () => null,
    },
    agentCronJobService: {
      list: async () => [MOCK_CRON],
      get: async () => MOCK_CRON,
      create: async () => MOCK_CRON,
      setEnabled: async () => MOCK_CRON,
      update: async () => MOCK_CRON,
      delete: async () => {},
      reconcileSystemCrons: async () => ({ created: 0, updated: 0, deleted: 0 }),
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
      provision: async () => ({ resourceName: "r", secretName: "s", deploymentName: "d" }),
      deprovision: async () => {},
      reconcile: async () => ({ recreated: [], orphans: [], failed: [] }),
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
      ghAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nfoo\n-----END RSA PRIVATE KEY-----",
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

  it("POST /admin/provision/start Slack error renders form error with NO env upsert", async () => {
    let upsertCalled = false;
    const deps = makeMockDeps({
      slackClient: {
        createAppManifest: async () => {
          throw new Error("Slack API error");
        },
      },
      agentEnvService: {
        getByAgentId: async () => ({}),
        upsert: async () => {
          upsertCalled = true;
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
    expect(upsertCalled).toBe(false);
    const html = await res.text();
    expect(html).toContain("alert-error");
  });

  it("POST /admin/provision/start happy path (PAT): 200 with oauthUrl, cookie set, env upsert with SLACK_APP_ID, SLACK_SIGNING_SECRET, GH_TOKEN", async () => {
    let upsertArgs: [string, Record<string, string>] | null = null;
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
        getByAgentId: async () => ({}),
        upsert: async (agentId, envVars) => {
          upsertArgs = [agentId, envVars];
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

    // Verify upsert was called with correct env vars
    expect(upsertArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(upsertArgs).not.toBeNull() above
    const [upsertedAgentId, envVars] = upsertArgs!;
    expect(upsertedAgentId).toBe(AGENT_ID);
    expect(envVars.SLACK_APP_ID).toBe("A_HAPPY");
    expect(envVars.SLACK_SIGNING_SECRET).toBe("ssec_happy");
    expect(envVars.GH_TOKEN).toBe("ghp_my_token");
  });

  it("POST /admin/provision/start with App auth: upsert includes GH_APP_ID, GH_APP_INSTALLATION_ID, GH_APP_PRIVATE_KEY", async () => {
    let upsertArgs: [string, Record<string, string>] | null = null;
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
        getByAgentId: async () => ({}),
        upsert: async (agentId, envVars) => {
          upsertArgs = [agentId, envVars];
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
      ghAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nfoo\n-----END RSA PRIVATE KEY-----",
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
    expect(upsertArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(upsertArgs).not.toBeNull() above
    const [, envVars] = upsertArgs!;
    expect(envVars.GH_APP_ID).toBe("12345");
    expect(envVars.GH_APP_INSTALLATION_ID).toBe("67890");
    expect(envVars.GH_APP_PRIVATE_KEY).toContain("BEGIN RSA PRIVATE KEY");
    expect(envVars).not.toHaveProperty("GH_TOKEN");
  });

  it("POST /admin/provision/start with AI creds: upsert includes ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN", async () => {
    let upsertArgs: [string, Record<string, string>] | null = null;
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
        getByAgentId: async () => ({}),
        upsert: async (agentId, envVars) => {
          upsertArgs = [agentId, envVars];
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
    expect(upsertArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(upsertArgs).not.toBeNull() above
    const [, envVars] = upsertArgs!;
    expect(envVars.ANTHROPIC_API_KEY).toBe("sk-ant-key");
    expect(envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token-xyz");
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
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          }),
          create: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          }),
          delete: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          }),
        },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [],
          findUnique: async ({ where }: { where: { agentId_email: { agentId: string; email: string } } }) =>
            where.agentId_email.email === MEMBER_EMAIL
              ? { id: "m1", agentId: AGENT_ID, email: MEMBER_EMAIL }
              : null,
          create: async () => ({ id: "m1", agentId: AGENT_ID, email: MEMBER_EMAIL }),
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
          findMany: async ({ where }: { where?: { id?: { in?: string[] } } } = {}) => {
            const allAgents = [
              { id: AGENT_ID, name: "My Agent", slackId: "U1", createdAt: new Date("2024-01-01") },
              { id: OTHER_AGENT_ID, name: "Other Agent", slackId: "U2", createdAt: new Date("2024-01-01") },
            ];
            if (where?.id?.in) {
              return allAgents.filter((a) => where.id?.in?.includes(a.id));
            }
            return allAgents;
          },
          findUnique: async () => null,
          create: async () => ({ id: AGENT_ID, name: "My Agent", slackId: "U1", createdAt: new Date(), updatedAt: new Date() }),
          delete: async () => ({ id: AGENT_ID, name: "My Agent", slackId: "U1", createdAt: new Date(), updatedAt: new Date() }),
        },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [{ id: "m1", agentId: AGENT_ID, email: MEMBER_EMAIL, createdAt: new Date() }],
          findUnique: async () => null,
          create: async () => ({ id: "m1", agentId: AGENT_ID, email: MEMBER_EMAIL }),
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
    const params = new URLSearchParams({ state: nonce, code: "auth-code-member" });
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
          create: async () => ({ id: AGENT_ID, name: "Test Agent", slackId: "U1", createdAt: new Date(), updatedAt: new Date() }),
          delete: async () => ({ id: AGENT_ID, name: "Test Agent", slackId: "U1", createdAt: new Date(), updatedAt: new Date() }),
        },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [{ id: "m1", agentId: AGENT_ID, email: MEMBER_EMAIL, createdAt: new Date() }],
          findUnique: async () => null,
          create: async () => ({ id: "m1", agentId: AGENT_ID, email: MEMBER_EMAIL }),
          deleteMany: async () => ({ count: 0 }),
        },
      },
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(
      new Request(`https://example.com/admin/auth/callback?${params.toString()}`, {
        headers: { Cookie: `oauth_state=${oauthState}` },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("admin_session=");
  });

  it("OAuth callback returns 403 for non-admin with no membership", async () => {
    const nonce = "test-nonce-outsider";
    const params = new URLSearchParams({ state: nonce, code: "auth-code-outsider" });
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
      new Request(`https://example.com/admin/auth/callback?${params.toString()}`, {
        headers: { Cookie: `oauth_state=${oauthState}` },
      }),
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
        provision: async () => ({ resourceName: "r", secretName: "s", deploymentName: "d" }),
        deprovision: async (agentId: string) => {
          deprovisioned = agentId;
        },
        reconcile: async () => ({ recreated: [], orphans: [], failed: [] }),
      },
      prisma: {
        agent: {
          findMany: async () => [],
          findUnique: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          }),
          create: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          }),
          delete: async ({ where }: { where: { id: string } }) => {
            deleted = where.id;
            return { id: where.id, name: "Test Agent", slackId: null, createdAt: new Date(), updatedAt: new Date() };
          },
        },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [],
          findUnique: async () => null,
          create: async () => ({ id: "m1", agentId: AGENT_ID, email: "member@example.com" }),
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
          findUnique: async () => ({ id: AGENT_ID, name: "Test Agent", slackId: "U1", createdAt: new Date(), updatedAt: new Date() }),
          create: async () => ({ id: AGENT_ID, name: "Test Agent", slackId: "U1", createdAt: new Date(), updatedAt: new Date() }),
          delete: async () => ({ id: AGENT_ID, name: "Test Agent", slackId: "U1", createdAt: new Date(), updatedAt: new Date() }),
        },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [],
          findUnique: async () => null,
          create: async ({ data }: { data: { agentId: string; email: string } }) => {
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
    expect((created as { agentId: string; email: string } | null)?.email).toBe("newmember@example.com");
  });

  it("admin can remove a member via POST /admin/agents/:id/members/delete", async () => {
    let deletedId: string | null = null;
    const deps = makeMockDeps({
      prisma: {
        agent: {
          findMany: async () => [],
          findUnique: async () => ({ id: AGENT_ID, name: "Test Agent", slackId: "U1", createdAt: new Date(), updatedAt: new Date() }),
          create: async () => ({ id: AGENT_ID, name: "Test Agent", slackId: "U1", createdAt: new Date(), updatedAt: new Date() }),
          delete: async () => ({ id: AGENT_ID, name: "Test Agent", slackId: "U1", createdAt: new Date(), updatedAt: new Date() }),
        },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [],
          findUnique: async () => null,
          create: async () => ({ id: "m1", agentId: AGENT_ID, email: "member@example.com" }),
          deleteMany: async ({ where }: { where: { id: string; agentId: string } }) => {
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
          getByAgentId: async () => ({ SLACK_APP_ID: "A123456" }),
          upsert: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => null,
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
      "Slack app configuration token must start with xoxe.xoxp",
    );
  });

  it("xoxe.xoxp rotating token → passes token validation", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ xoxpToken: "xoxe.xoxp-valid-rotating-token" });
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
          getByAgentId: async () => ({}),
          upsert: async () => {},
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
          getByAgentId: async () => ({ SLACK_APP_ID: "A123456" }),
          upsert: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => null,
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
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("slack_api_error");
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
});
