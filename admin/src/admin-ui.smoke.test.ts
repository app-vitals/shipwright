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
import type {
  AdminUIDeps,
  AdminUIGithubAppClient,
  AdminUISlackClient,
} from "./admin-ui.ts";
import type {
  GoogleAuthClient,
  GoogleTokenResponse,
  GoogleUserInfo,
} from "./google-auth-client.ts";
import type {
  OktaAuthClient,
  OktaTokenResponse,
  OktaUserInfo,
} from "./okta-auth-client.ts";
import type { PushService } from "./push-service.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const GOOGLE_CLIENT_ID = "test-google-client-id";
const GOOGLE_CLIENT_SECRET = "test-google-client-secret";
const OKTA_CLIENT_ID = "test-okta-client-id";
const OKTA_CLIENT_SECRET = "test-okta-client-secret";
const OKTA_ISSUER = "https://example.okta.com/oauth2/default";
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
  parentCronId: null,
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

// ─── Mock Okta client ─────────────────────────────────────────────────────────

function makeOktaClient(overrides?: {
  getAuthorizationUrl?: (params: unknown) => string;
  exchangeCode?: (params: unknown) => Promise<OktaTokenResponse>;
  getUserInfo?: (accessToken: string) => Promise<OktaUserInfo>;
}): OktaAuthClient {
  return {
    getAuthorizationUrl:
      overrides?.getAuthorizationUrl ??
      ((params: {
        clientId: string;
        redirectUri: string;
        state: string;
        scope?: string;
      }) => {
        const query = new URLSearchParams({
          client_id: params.clientId,
          redirect_uri: params.redirectUri,
          response_type: "code",
          scope: params.scope ?? "openid profile email",
          state: params.state,
        });
        return `${OKTA_ISSUER}/v1/authorize?${query.toString()}`;
      }),
    exchangeCode:
      overrides?.exchangeCode ??
      (() =>
        Promise.resolve({
          accessToken: "test-okta-access-token",
          refreshToken: "test-okta-refresh-token",
          expiresIn: 3600,
        })),
    getUserInfo:
      overrides?.getUserInfo ??
      (() =>
        Promise.resolve({
          sub: "okta-sub-123",
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
  authTest: async () => ({ userId: "U0AALR8M69X" }),
};

const BASE_GITHUB_APP_CLIENT: AdminUIGithubAppClient = {
  exchangeManifestCode: async () => ({
    appId: "999111",
    slug: "test-shipwright-agent",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nmock\n-----END RSA PRIVATE KEY-----",
    clientId: "gh-app-client-id",
    clientSecret: "gh-app-client-secret",
  }),
};

function makeMockDeps(
  overrides?: Partial<Omit<AdminUIDeps, "slackClient" | "githubAppClient">> & {
    slackClient?: Partial<AdminUISlackClient>;
    githubAppClient?: Partial<AdminUIGithubAppClient>;
  },
): AdminUIDeps {
  const {
    slackClient: slackClientOverride,
    githubAppClient: githubAppClientOverride,
    ...rest
  } = overrides ?? {};
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
      agentEnv: {
        findMany: async () => [],
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
      listForAgent: async () => ({ items: [], total: 0, limit: 20, offset: 0 }),
    },
    agentWorkQueueService: {
      get: async () => null,
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
    agentMemberService: {
      listByEmail: async () => [],
      exists: async () => false,
      add: async () => ({
        id: "m1",
        agentId: AGENT_ID,
        email: "member@example.com",
        createdAt: new Date(),
      }),
      remove: async () => {},
      listByAgentId: async () => [],
    },
    agentService: {
      listAll: async () => [
        {
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ],
      listByIds: async () => [
        {
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ],
      searchByName: async () => [
        {
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        },
      ],
      listOptions: async () => [{ id: AGENT_ID, name: "Test Agent" }],
      create: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        missingRequiredEnv: [],
      }),
      delete: async () => {},
      getDetail: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
      }),
      updateFields: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
      }),
    },
    sessionSecret: SESSION_SECRET,
    googleClientId: GOOGLE_CLIENT_ID,
    googleClientSecret: GOOGLE_CLIENT_SECRET,
    adminAllowedEmails: ADMIN_ALLOWED_EMAILS,
    googleClient: makeGoogleClient(),
    oktaClientId: OKTA_CLIENT_ID,
    oktaClientSecret: OKTA_CLIENT_SECRET,
    oktaIssuer: OKTA_ISSUER,
    oktaClient: makeOktaClient(),
    slackClient: { ...BASE_SLACK_CLIENT, ...slackClientOverride },
    githubAppClient: { ...BASE_GITHUB_APP_CLIENT, ...githubAppClientOverride },
    provisioner: {
      canProvision: false,
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
    taskStore: {
      listTokensForAgent: async () => [],
      revokeToken: async () => {},
    },
    chatService: {
      listTokensForAgent: async () => [],
      revokeToken: async () => {},
      deleteThreadsForAgent: async () => ({ deleted: 0 }),
    },
    slack: {
      deleteApp: async () => {},
    },
    decrypt: (value: string) => value,
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

  it("unauthenticated GET /admin/agents/:id/queue-activity redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`);
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
    // Scope the password-form check to <body> — the shared mobile stylesheet
    // in <head> legitimately contains an `input[type="password"]` CSS
    // selector (for other pages' real password fields), which would
    // otherwise collide with a naive whole-page substring match.
    const body = html.slice(html.indexOf("<body"));
    expect(html).toContain("Sign in with Google");
    expect(body).not.toContain('type="password"');
    expect(body).not.toContain('name="password"');
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

describe("admin UI — GET /admin/auth/okta", () => {
  it("redirects to the Okta authorization URL and sets oauth_state cookie", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/auth/okta");
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain(OKTA_ISSUER);
    expect(location).toContain("v1/authorize");
    expect(location).toContain("openid");
    expect(location).toContain("profile");
    expect(location).toContain("email");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("oauth_state=");
    expect(cookie).toContain("HttpOnly");
  });

  it("redirects to /admin/login?error=server_error when oktaClientId is empty", async () => {
    const app = createAdminUIApp(makeMockDeps({ oktaClientId: "" }));
    const res = await app.request("/admin/auth/okta");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=server_error");
  });

  it("redirects to /admin/login?error=server_error when oktaIssuer is empty", async () => {
    const app = createAdminUIApp(makeMockDeps({ oktaIssuer: "" }));
    const res = await app.request("/admin/auth/okta");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=server_error");
  });
});

describe("admin UI — GET /admin/auth/okta/callback", () => {
  // Mirrors callbackRequest() from the Google callback describe block above.
  function oktaCallbackRequest(
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
      `https://example.com/admin/auth/okta/callback?${params.toString()}`,
      {
        headers: { Cookie: `oauth_state=${oauthState}` },
      },
    );
  }

  it("happy path — valid state, code exchanged, email in allowlist → sets session cookie and redirects to /admin/agents", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(oktaCallbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("admin_session=");
    expect(cookie).toContain("HttpOnly");
  });

  it("happy path with returnTo — redirects to the stored returnTo path after auth", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      oktaCallbackRequest(nonce, {}, "/admin/agents/agent-test-123"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents/agent-test-123");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("admin_session=");
  });

  it("resolves isAdmin via the same allowlist check as Google — allowlisted email → isAdmin true session", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(oktaCallbackRequest(nonce));
    expect(res.status).toBe(302);
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
        "https://example.com/admin/auth/okta/callback?state=wrong-state&code=auth-code",
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
        "https://example.com/admin/auth/okta/callback?state=some-state&code=code",
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=invalid_state");
  });

  it("missing OKTA_CLIENT_ID → redirects to /admin/login?error=server_error", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(makeMockDeps({ oktaClientId: "" }));
    const res = await app.request(oktaCallbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=server_error");
  });

  it("missing OKTA_ISSUER → redirects to /admin/login?error=server_error", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(makeMockDeps({ oktaIssuer: "" }));
    const res = await app.request(oktaCallbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=server_error");
  });

  it("access_denied param → redirects to /admin/login?error=access_denied", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(makeMockDeps());
    const oauthState = encodeURIComponent(JSON.stringify({ nonce }));
    const res = await app.request(
      new Request(
        `https://example.com/admin/auth/okta/callback?error=access_denied&state=${nonce}`,
        {
          headers: { Cookie: `oauth_state=${oauthState}` },
        },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=access_denied");
  });

  it("token exchange failure → redirects to /admin/login?error=auth_failed", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(
      makeMockDeps({
        oktaClient: makeOktaClient({
          exchangeCode: () =>
            Promise.reject(new Error("token exchange failed")),
        }),
      }),
    );
    const res = await app.request(oktaCallbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=auth_failed");
  });

  it("userinfo fetch failure → redirects to /admin/login?error=auth_failed", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(
      makeMockDeps({
        oktaClient: makeOktaClient({
          getUserInfo: () => Promise.reject(new Error("userinfo failed")),
        }),
      }),
    );
    const res = await app.request(oktaCallbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=auth_failed");
  });

  it("email not in allowlist → returns 403", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(
      makeMockDeps({
        oktaClient: makeOktaClient({
          getUserInfo: () =>
            Promise.resolve({
              sub: "okta-sub-999",
              email: "notallowed@example.com",
              email_verified: true,
              name: "Not Allowed",
            }),
        }),
      }),
    );
    const res = await app.request(oktaCallbackRequest(nonce));
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

  it("authenticated GET /admin/agents includes a Queue & Activity link with the correct href for a rendered agent row", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `<a href="/admin/agents/${AGENT_ID}/queue-activity" class="btn btn-secondary"`,
    );
    expect(html).toContain("Queue &amp; Activity</a>");
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

  describe("connect-later actions (UAP-2.3)", () => {
    it("no env vars set: shows Connect Slack, Set up GitHub App, and Add GitHub PAT actions, each wired to the correct connect-* route and agent id", async () => {
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
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain("Connect Slack");
      expect(html).toContain("Set up GitHub App");
      expect(html).toContain("Add GitHub PAT");

      expect(html).toContain(
        `<form method="POST" action="/admin/agents/${AGENT_ID}/connect-slack"`,
      );
      expect(html).toContain(
        `<form method="POST" action="/admin/agents/${AGENT_ID}/connect-github"`,
      );
      // Two distinct connect-github forms (App auto-provision + PAT) both scoped to this agent id.
      expect(
        html.split(`/admin/agents/${AGENT_ID}/connect-github`).length - 1,
      ).toBeGreaterThanOrEqual(2);
    });

    it("SLACK_APP_TOKEN present: hides Connect Slack but still shows the GitHub actions", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({
              env: { SLACK_APP_TOKEN: "xapp-1-abc" },
              secretKeys: ["SLACK_APP_TOKEN"],
            }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).not.toContain("Connect Slack");
      expect(html).toContain("Set up GitHub App");
      expect(html).toContain("Add GitHub PAT");
    });

    it("GH_APP_ID present: hides Set up GitHub App but still shows Connect Slack and Add GitHub PAT", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({
              env: { GH_APP_ID: "12345" },
              secretKeys: [],
            }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain("Connect Slack");
      expect(html).not.toContain("Set up GitHub App");
      expect(html).toContain("Add GitHub PAT");
    });

    it("GH_TOKEN present: hides Add GitHub PAT but still shows Connect Slack and Set up GitHub App", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({
              env: { GH_TOKEN: "ghp_abc" },
              secretKeys: ["GH_TOKEN"],
            }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain("Connect Slack");
      expect(html).toContain("Set up GitHub App");
      expect(html).not.toContain("Add GitHub PAT");
    });

    it("GH_APP_ID and GH_TOKEN both present (independent signals): hides both GitHub actions but still shows Connect Slack", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({
              env: { GH_APP_ID: "12345", GH_TOKEN: "ghp_abc" },
              secretKeys: ["GH_TOKEN"],
            }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain("Connect Slack");
      expect(html).not.toContain("Set up GitHub App");
      expect(html).not.toContain("Add GitHub PAT");
    });

    it("all three env vars set: none of the connect-later actions render", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({
              env: {
                SLACK_APP_TOKEN: "xapp-1-abc",
                GH_APP_ID: "12345",
                GH_TOKEN: "ghp_abc",
              },
              secretKeys: ["SLACK_APP_TOKEN", "GH_TOKEN"],
            }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).not.toContain("Connect Slack");
      expect(html).not.toContain("Set up GitHub App");
      expect(html).not.toContain("Add GitHub PAT");
    });

    it("Add GitHub PAT form posts ghAuthMode=pat to the connect-github route", async () => {
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
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      const html = await res.text();

      // Isolate the Add GitHub PAT popover block and assert its hidden field + input.
      const patBlockStart = html.indexOf("Add GitHub PAT");
      expect(patBlockStart).toBeGreaterThan(-1);
      const patBlock = html.slice(patBlockStart, patBlockStart + 1500);
      expect(patBlock).toContain(
        `action="/admin/agents/${AGENT_ID}/connect-github"`,
      );
      expect(patBlock).toContain('name="ghAuthMode" value="pat"');
      expect(patBlock).toContain('name="ghPat"');
    });

    it("Set up GitHub App form posts ghAuthMode=app + ghAppMode=auto with a githubOrg field to the connect-github route", async () => {
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
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      const html = await res.text();

      const appBlockStart = html.indexOf("Set up GitHub App");
      expect(appBlockStart).toBeGreaterThan(-1);
      const appBlock = html.slice(appBlockStart, appBlockStart + 1500);
      expect(appBlock).toContain(
        `action="/admin/agents/${AGENT_ID}/connect-github"`,
      );
      expect(appBlock).toContain('name="ghAuthMode" value="app"');
      expect(appBlock).toContain('name="ghAppMode" value="auto"');
      expect(appBlock).toContain('name="githubOrg"');
    });

    it("Connect Slack form posts xoxpToken to the connect-slack route", async () => {
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
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      const html = await res.text();

      const slackBlockStart = html.indexOf("Connect Slack");
      expect(slackBlockStart).toBeGreaterThan(-1);
      const slackBlock = html.slice(slackBlockStart, slackBlockStart + 1500);
      expect(slackBlock).toContain(
        `action="/admin/agents/${AGENT_ID}/connect-slack"`,
      );
      expect(slackBlock).toContain('name="xoxpToken"');
    });

    it("non-admin member viewer does not see the connect-later actions (Slack access card is admin-only)", async () => {
      const MEMBER_EMAIL = "member@example.com";
      const memberCookie = await makeSessionCookie(
        SESSION_SECRET,
        "google-sub-member",
        MEMBER_EMAIL,
        false,
      );
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({ env: {}, secretKeys: [] }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
          agentMemberService: {
            listByEmail: async () => [],
            exists: async (_agentId: string, email: string) =>
              email === MEMBER_EMAIL,
            add: async () => ({
              id: "m1",
              agentId: AGENT_ID,
              email: MEMBER_EMAIL,
              createdAt: new Date(),
            }),
            remove: async () => {},
            listByAgentId: async () => [],
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${memberCookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("Connect Slack");
      expect(html).not.toContain("Set up GitHub App");
      expect(html).not.toContain("Add GitHub PAT");
    });
  });

  it("authenticated GET /admin/agents/new returns 200 with a required type select listing the agent types", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents/new", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Regression coverage for a bug where a consumer wiring up AdminUIDeps
    // without the required `provisioner` field (it has no default, unlike
    // agentTypeRegistry) caused this route to throw on `provisioner.canProvision`
    // — a 500 that left the type picker (and its "required" select[name=type])
    // missing entirely rather than merely disabled.
    expect(html).toContain(
      '<select id="type" name="type" class="form-input" required>',
    );
    expect(html).toContain('<option value="coding">Coding Agent</option>');
  });

  it("nests shipwright-loop phase crons under the loop row instead of listing them flat", async () => {
    const LOOP_ID = "cron-loop-1";
    const PHASES = [
      "shipwright-dev-task",
      "shipwright-review",
      "shipwright-patch",
      "shipwright-deploy",
    ];
    const phaseCrons = PHASES.map((name, i) => ({
      ...MOCK_CRON,
      id: `cron-phase-${i}`,
      name,
      system: true,
      parentCronId: LOOP_ID,
      lastRun: null,
      runCountToday: 0,
    }));
    const loopCron = {
      ...MOCK_CRON,
      id: LOOP_ID,
      name: "shipwright-loop",
      system: true,
      parentCronId: null,
      lastRun: null,
      runCountToday: 0,
    };

    const app = createAdminUIApp(
      makeMockDeps({
        agentCronJobService: {
          list: async () => [loopCron, ...phaseCrons],
          listWithRunSummary: async () => [loopCron, ...phaseCrons],
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

    // Nested section is clearly labeled as belonging to shipwright-loop.
    const labelIndex = html.indexOf("Phases of shipwright-loop");
    expect(labelIndex).toBeGreaterThan(-1);

    // Each phase's toggle form is present and wired to the existing toggle route.
    for (const phase of phaseCrons) {
      const toggleAction = `action="/admin/agents/${AGENT_ID}/crons/${phase.id}/toggle"`;
      expect(html).toContain(toggleAction);
      // The toggle form must appear after the "Phases of shipwright-loop" label,
      // i.e. nested beneath the loop row rather than as a flat top-level row.
      const toggleIndex = html.indexOf(toggleAction);
      expect(toggleIndex).toBeGreaterThan(labelIndex);
    }

    // The loop's own toggle form is still rendered as the top-level row.
    expect(html).toContain(
      `action="/admin/agents/${AGENT_ID}/crons/${LOOP_ID}/toggle"`,
    );
  });

  it("authenticated GET /admin/agents/:id/queue-activity returns 200 with empty Upcoming and Past state", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Outcome");
    expect(html).toContain("Started");
    expect(html).toContain("Duration");
    // empty states by default in the base mock — no snapshot pushed, no runs
    expect(html).toContain("No runs");
    expect(html).toContain("No work queue snapshot");
    expect(html).not.toContain("Last computed");
  });

  it("authenticated GET /admin/agents/:id/queue-activity fetches the caller's accessible-agents list and renders it as the selector's options (AXR-3.4)", async () => {
    const OTHER_AGENT_ID = "agent-other-456";
    const app = createAdminUIApp(
      makeMockDeps({
        agentService: {
          listAll: async () => [
            {
              id: AGENT_ID,
              name: "Test Agent",
              slackId: "U1",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
            {
              id: OTHER_AGENT_ID,
              name: "Other Agent",
              slackId: "U2",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
          ],
          listByIds: async () => [],
          searchByName: async () => [],
          listOptions: async () => [],
          create: async () => {
            throw new Error("not implemented");
          },
          delete: async () => {},
          getDetail: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            selfHosted: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
            reviewAuthorAllowlist: [],
            patchAuthorAllowlist: [],
            restrictSlackToMembers: false,
            missingRequiredEnv: [],
          }),
          updateFields: async () => {
            throw new Error("not implemented");
          },
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // The caller (admin) sees the full fleet, with the currently-viewed agent pre-selected.
    expect(html).toContain(
      `<option value="${AGENT_ID}" selected>Test Agent</option>`,
    );
    expect(html).toContain(
      `<option value="${OTHER_AGENT_ID}">Other Agent</option>`,
    );
  });

  it("authenticated GET /admin/agents/:id/queue-activity renders the Upcoming section above the Past section", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentWorkQueueService: {
          get: async () => ({
            id: "snap-1",
            agentId: AGENT_ID,
            computedAt: new Date("2026-06-01T10:00:00Z"),
            items: [
              {
                type: "task",
                id: "WLS-2.2",
                title: "Add work queue snapshot endpoints",
                phase: "dev-task",
                age: "2026-06-01T09:00:00Z",
              },
            ],
            createdAt: new Date("2026-06-01T10:00:00Z"),
          }),
        },
        agentCronRunService: {
          listForAgent: async () => ({
            items: [makeCronRun()],
            total: 1,
            limit: 20,
            offset: 0,
          }),
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const upcomingIndex = html.indexOf("WLS-2.2");
    const pastIndex = html.indexOf("posted");
    expect(upcomingIndex).toBeGreaterThan(-1);
    expect(pastIndex).toBeGreaterThan(-1);
    expect(upcomingIndex).toBeLessThan(pastIndex);
  });

  function makeCronRun(
    overrides?: Partial<{
      id: string;
      cronId: string;
      startedAt: Date;
      completedAt: Date | null;
      skipped: boolean;
      skipReason: string | null;
      outcome: string | null;
      error: string | null;
      phaseId: string | null;
      phaseCron: { id: string; name: string | null } | null;
      modelBreakdown: {
        id: string;
        cronRunId: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        costUsd: number;
      }[];
    }>,
  ) {
    return {
      id: "run-1",
      cronId: CRON_ID,
      agentId: AGENT_ID,
      startedAt: new Date("2026-06-01T10:00:00Z"),
      completedAt: new Date("2026-06-01T10:00:03Z"),
      skipped: false,
      skipReason: null,
      outcome: "posted",
      error: null,
      itemType: null,
      itemId: null,
      sessionId: null,
      phaseId: null,
      phaseCron: null,
      createdAt: new Date("2026-06-01T10:00:00Z"),
      modelBreakdown: [] as {
        id: string;
        cronRunId: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        costUsd: number;
      }[],
      cron: MOCK_CRON,
      ...overrides,
    };
  }

  it("authenticated GET /admin/agents/:id/queue-activity renders populated runs in the Past section", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        // AXR-3.2: only shipwright-loop crons stay visible in the primary
        // table by default — override the cron list so this run's owning
        // cron classifies as visible instead of collapsing into a <details>.
        agentCronJobService: {
          list: async () => [{ ...MOCK_CRON, name: "shipwright-loop" }],
          listWithRunSummary: async () => [
            { ...MOCK_CRON, name: "shipwright-loop", lastRun: null, runCountToday: 0 },
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
          listForAgent: async () => ({
            items: [makeCronRun()],
            total: 1,
            limit: 20,
            offset: 0,
          }),
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("posted");
    expect(html).not.toContain("No runs");
  });

  it("authenticated GET /admin/agents/:id/queue-activity renders populated Upcoming snapshot", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentWorkQueueService: {
          get: async () => ({
            id: "snap-1",
            agentId: AGENT_ID,
            computedAt: new Date("2026-06-01T10:00:00Z"),
            items: [
              {
                type: "task",
                id: "WLS-2.2",
                title: "Add work queue snapshot endpoints",
                phase: "dev-task",
                age: "2026-06-01T09:00:00Z",
              },
              {
                type: "pr",
                id: "PR-42",
                title: "Fix flaky test",
                phase: "review",
                age: "2026-06-01T08:00:00Z",
              },
            ],
            createdAt: new Date("2026-06-01T10:00:00Z"),
          }),
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Last computed");
    expect(html).toContain("WLS-2.2");
    expect(html).toContain("Add work queue snapshot endpoints");
    expect(html).toContain("PR-42");
    expect(html).toContain("dev-task");
    expect(html).toContain("review");
    expect(html).not.toContain("No work queue snapshot");
    // task item links to its admin task detail page
    expect(html).toContain('<a href="/admin/tasks/WLS-2.2"');
  });

  it("queue-activity Upcoming PR item links out to GitHub using the repo#prNumber id", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentWorkQueueService: {
          get: async () => ({
            id: "snap-2",
            agentId: AGENT_ID,
            computedAt: new Date("2026-06-01T10:00:00Z"),
            items: [
              {
                type: "pr",
                id: "app-vitals/shipwright#4321",
                title: "Fix flaky test",
                phase: "review",
                age: "2026-06-01T08:00:00Z",
              },
            ],
            createdAt: new Date("2026-06-01T10:00:00Z"),
          }),
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      '<a href="https://github.com/app-vitals/shipwright/pull/4321"',
    );
  });

  it("authenticated GET /admin/agents/:id/queue-activity?cronId=... filters the Past section by cronId", async () => {
    let capturedOpts: unknown;
    const app = createAdminUIApp(
      makeMockDeps({
        agentCronRunService: {
          listForAgent: async (_agentId: string, opts?: unknown) => {
            capturedOpts = opts;
            return {
              items: [makeCronRun()],
              total: 1,
              limit: 20,
              offset: 0,
            };
          },
        },
      }),
    );
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/queue-activity?cronId=${CRON_ID}`,
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    expect(capturedOpts).toMatchObject({ cronId: CRON_ID });
    const html = await res.text();
    // Selected cron option should carry `selected`.
    const optionMatch = html.match(
      new RegExp(`<option value="${CRON_ID}"[^>]*>`),
    );
    expect(optionMatch).not.toBeNull();
    expect(optionMatch?.[0]).toContain("selected");
  });

  it("authenticated GET /admin/agents/:id/queue-activity?outcome=... filters the Past section by outcome", async () => {
    let capturedOpts: unknown;
    const app = createAdminUIApp(
      makeMockDeps({
        agentCronRunService: {
          listForAgent: async (_agentId: string, opts?: unknown) => {
            capturedOpts = opts;
            return {
              items: [makeCronRun({ outcome: "error" })],
              total: 1,
              limit: 20,
              offset: 0,
            };
          },
        },
      }),
    );
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/queue-activity?outcome=error`,
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    expect(capturedOpts).toMatchObject({ outcome: "error" });
  });

  it("authenticated GET /admin/agents/:id/queue-activity?outcome=skipped passes the skipped special-case outcome through", async () => {
    let capturedOpts: unknown;
    const app = createAdminUIApp(
      makeMockDeps({
        agentCronRunService: {
          listForAgent: async (_agentId: string, opts?: unknown) => {
            capturedOpts = opts;
            return {
              items: [
                makeCronRun({
                  skipped: true,
                  outcome: null,
                  skipReason: "pre-check failed",
                }),
              ],
              total: 1,
              limit: 20,
              offset: 0,
            };
          },
        },
      }),
    );
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/queue-activity?outcome=skipped`,
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    expect(capturedOpts).toMatchObject({ outcome: "skipped" });
    const html = await res.text();
    expect(html).toContain("skipped");
  });

  it("non-admin non-member gets 403 on GET /admin/agents/:id/queue-activity", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${outsiderCookie}` },
    });
    expect(res.status).toBe(403);
  });

  it("GET /admin/agents/:id/queue-activity returns 404 when agent not found", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentService: {
          ...makeMockDeps().agentService,
          getDetail: async () => null,
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}/queue-activity`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(404);
  });

  it("GET /admin/provision redirects to /admin/agents/new", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/provision", {
      headers: { Cookie: `admin_session=${cookie}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents/new");
  });

  it("POST /admin/provision/start returns 404 (endpoint removed)", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/provision/start", {
      method: "POST",
      body: new URLSearchParams({ xoxpToken: "xoxe.xoxp-valid" }).toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(404);
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
          agentService: {
            ...makeMockDeps().agentService,
            getDetail: async () => ({
              id: AGENT_ID,
              name: "Managed Agent",
              slackId: "U0AALR8M69X",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            }),
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

    it("self-hosted agent (selfHosted=true) does NOT show Slack info in header", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentService: {
            ...makeMockDeps().agentService,
            getDetail: async () => ({
              id: SELFHOSTED_AGENT_ID,
              name: "Self-Hosted Agent",
              slackId: null,
              selfHosted: true,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            }),
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
          agentService: {
            ...makeMockDeps().agentService,
            getDetail: async () => ({
              id: SELFHOSTED_AGENT_ID,
              name: "Self-Hosted Agent",
              slackId: null,
              selfHosted: true,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            }),
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
          agentService: {
            ...makeMockDeps().agentService,
            getDetail: async () => ({
              id: SELFHOSTED_AGENT_ID,
              name: "Self-Hosted Agent",
              slackId: null,
              selfHosted: true,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            }),
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
          agentService: {
            ...makeMockDeps().agentService,
            getDetail: async () => ({
              id: SELFHOSTED_AGENT_ID,
              name: "Self-Hosted Agent",
              slackId: null,
              selfHosted: true,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            }),
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
        agentEnv: { findMany: async () => [] },
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
      agentMemberService: {
        listByEmail: async () => [],
        exists: async (_agentId: string, email: string) =>
          email === MEMBER_EMAIL,
        add: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: MEMBER_EMAIL,
          createdAt: new Date(),
        }),
        remove: async () => {},
        listByAgentId: async () => [],
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
        agentEnv: { findMany: async () => [] },
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
      agentMemberService: {
        listByEmail: async (email: string) =>
          email === MEMBER_EMAIL
            ? [
                {
                  id: "m1",
                  agentId: AGENT_ID,
                  email: MEMBER_EMAIL,
                  createdAt: new Date(),
                },
              ]
            : [],
        exists: async () => false,
        add: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: MEMBER_EMAIL,
          createdAt: new Date(),
        }),
        remove: async () => {},
        listByAgentId: async () => [],
      },
      agentService: {
        listAll: async () => [
          {
            id: AGENT_ID,
            name: "My Agent",
            slackId: "U1",
            selfHosted: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          },
          {
            id: OTHER_AGENT_ID,
            name: "Other Agent",
            slackId: "U2",
            selfHosted: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          },
        ],
        listByIds: async (ids: string[]) =>
          [
            {
              id: AGENT_ID,
              name: "My Agent",
              slackId: "U1",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
            {
              id: OTHER_AGENT_ID,
              name: "Other Agent",
              slackId: "U2",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
          ].filter((a) => ids.includes(a.id)),
        searchByName: async () => [],
        listOptions: async () => [
          { id: AGENT_ID, name: "My Agent" },
          { id: OTHER_AGENT_ID, name: "Other Agent" },
        ],
        create: async () => {
          throw new Error("not implemented");
        },
        delete: async () => {},
        getDetail: async () => null,
        updateFields: async () => {
          throw new Error("not implemented");
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
        agentEnv: { findMany: async () => [] },
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
      agentMemberService: {
        listByEmail: async (email: string) =>
          email === MEMBER_EMAIL
            ? [
                {
                  id: "m1",
                  agentId: AGENT_ID,
                  email: MEMBER_EMAIL,
                  createdAt: new Date(),
                },
              ]
            : [],
        exists: async () => false,
        add: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: MEMBER_EMAIL,
          createdAt: new Date(),
        }),
        remove: async () => {},
        listByAgentId: async () => [],
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

// ─── Default-agent queue-activity redirect (AXR-3.3) ─────────────────────────

describe("admin UI — GET /admin/queue-activity (default-agent redirect)", () => {
  it("unauthenticated GET /admin/queue-activity redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/queue-activity");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });

  it("admin is redirected to the first agent's queue-activity page (full fleet)", async () => {
    const adminCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-admin",
      "admin@example.com",
      true,
    );
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/queue-activity", {
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/agents/${AGENT_ID}/queue-activity`,
    );
  });

  it("non-admin AgentMember is redirected to their first accessible agent's queue-activity page", async () => {
    const MEMBER_EMAIL = "member@example.com";
    const OTHER_AGENT_ID = "agent-other-456";
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      MEMBER_EMAIL,
      false,
    );
    const deps = makeMockDeps({
      agentMemberService: {
        listByEmail: async (email: string) =>
          email === MEMBER_EMAIL
            ? [
                {
                  id: "m1",
                  agentId: AGENT_ID,
                  email: MEMBER_EMAIL,
                  createdAt: new Date(),
                },
              ]
            : [],
        exists: async () => false,
        add: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: MEMBER_EMAIL,
          createdAt: new Date(),
        }),
        remove: async () => {},
        listByAgentId: async () => [],
      },
      agentService: {
        listAll: async () => [
          {
            id: AGENT_ID,
            name: "My Agent",
            slackId: "U1",
            selfHosted: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          },
          {
            id: OTHER_AGENT_ID,
            name: "Other Agent",
            slackId: "U2",
            selfHosted: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          },
        ],
        listByIds: async (ids: string[]) =>
          [
            {
              id: AGENT_ID,
              name: "My Agent",
              slackId: "U1",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
            {
              id: OTHER_AGENT_ID,
              name: "Other Agent",
              slackId: "U2",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
          ].filter((a) => ids.includes(a.id)),
        searchByName: async () => [],
        listOptions: async () => [
          { id: AGENT_ID, name: "My Agent" },
          { id: OTHER_AGENT_ID, name: "Other Agent" },
        ],
        create: async () => {
          throw new Error("not implemented");
        },
        delete: async () => {},
        getDetail: async () => null,
        updateFields: async () => {
          throw new Error("not implemented");
        },
      },
    });
    const app = createAdminUIApp(deps);
    const res = await app.request("/admin/queue-activity", {
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/agents/${AGENT_ID}/queue-activity`,
    );
  });

  it("non-admin with zero accessible agents is redirected to /admin/agents instead of a queue-activity page", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const deps = makeMockDeps({
      agentMemberService: {
        listByEmail: async () => [],
        exists: async () => false,
        add: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: "member@example.com",
          createdAt: new Date(),
        }),
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
    });
    const app = createAdminUIApp(deps);
    const res = await app.request("/admin/queue-activity", {
      headers: { Cookie: `admin_session=${outsiderCookie}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents");
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

  it("admin POST /admin/agents/:id/delete → 302 redirect to /admin/agents?success=deleted, deleteAgentFully's composed dependencies invoked, row actually deleted", async () => {
    let deprovisioned: string | null = null;
    let deleted: string | null = null;
    const taskStoreRevoked: string[] = [];
    const chatRevoked: string[] = [];
    const chatThreadsDeletedFor: string[] = [];
    const deps = makeMockDeps({
      provisioner: {
        canProvision: false,
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
      taskStore: {
        listTokensForAgent: async () => [{ id: "ts-1" }],
        revokeToken: async (id: string) => {
          taskStoreRevoked.push(id);
        },
      },
      chatService: {
        listTokensForAgent: async () => [{ id: "chat-1" }],
        revokeToken: async (id: string) => {
          chatRevoked.push(id);
        },
        deleteThreadsForAgent: async (agentId: string) => {
          chatThreadsDeletedFor.push(agentId);
          return { deleted: 0 };
        },
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
        // No secret/manual-step-worthy env rows — the success redirect must
        // be the bare "?success=deleted" with no &manualSteps= appended.
        agentEnv: { findMany: async () => [] },
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
    // Exactly this Location — no &manualSteps= since there are no secret env rows.
    expect(res.headers.get("Location")).toBe("/admin/agents?success=deleted");
    // biome-ignore lint/style/noNonNullAssertion: set by the spy closure above
    expect(deprovisioned!).toBe(AGENT_ID);
    expect(taskStoreRevoked).toEqual(["ts-1"]);
    expect(chatRevoked).toEqual(["chat-1"]);
    expect(chatThreadsDeletedFor).toEqual([AGENT_ID]);
    // biome-ignore lint/style/noNonNullAssertion: set by the spy closure above
    expect(deleted!).toBe(AGENT_ID);
  });

  it("admin POST /admin/agents/:id/delete → when deprovision (k8s) throws, redirects to the agent's OWN page with an error and preserves the row (retry path)", async () => {
    let deleted: string | null = null;
    const deps = makeMockDeps({
      provisioner: {
        canProvision: false,
        provision: async () => ({
          resourceName: "r",
          secretName: "s",
          deploymentName: "d",
        }),
        deprovision: async () => {
          throw new Error("k8s API timeout");
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
        agentEnv: { findMany: async () => [] },
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
    const location = res.headers.get("Location") ?? "";
    // Redirects back to the agent's OWN page — NOT the agents list — so the
    // row doesn't appear deleted from the operator's perspective.
    expect(location.startsWith(`/admin/agents/${AGENT_ID}?error=`)).toBe(true);
    const errorMsg = decodeURIComponent(location.split("error=")[1] ?? "");
    expect(errorMsg).toContain("k8s");
    expect(deleted).toBeNull();
  });

  it("admin POST /admin/agents/:id/delete → surfaces manualStepsRequired on the success redirect when the agent has secret env rows", async () => {
    const deps = makeMockDeps({
      provisioner: {
        canProvision: false,
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
          delete: async ({ where }: { where: { id: string } }) => ({
            id: where.id,
            name: "Test Agent",
            slackId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
        },
        agentEnv: {
          findMany: async () => [
            { key: "GH_TOKEN", value: "ghp_x", secret: true },
            { key: "PORT", value: "3000", secret: false },
          ],
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
    const location = res.headers.get("Location") ?? "";
    expect(
      location.startsWith("/admin/agents?success=deleted&manualSteps="),
    ).toBe(true);
    const manualStepsRaw = new URLSearchParams(location.split("?")[1]).get(
      "manualSteps",
    );
    expect(manualStepsRaw).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    const manualSteps = JSON.parse(manualStepsRaw!) as Array<{ key: string }>;
    expect(manualSteps.map((s) => s.key)).toEqual(["GH_TOKEN"]);

    // A subsequent GET /admin/agents with that manualSteps query param renders
    // the dismissible panel (renderAgentsPage's opts wiring).
    const getRes = await app.request(
      `/admin/agents?${location.split("?")[1]}`,
      {
        headers: { Cookie: `admin_session=${adminCookie}` },
      },
    );
    expect(getRes.status).toBe(200);
    const html = await getRes.text();
    expect(html).toContain("Manual cleanup required");
    expect(html).toContain("GitHub personal access token");
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
        agentEnv: { findMany: async () => [] },
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
      agentMemberService: {
        listByEmail: async () => [],
        exists: async () => false,
        add: async (agentId: string, email: string) => {
          created = { agentId, email };
          return { id: "m-new", agentId, email, createdAt: new Date() };
        },
        remove: async () => {},
        listByAgentId: async () => [],
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
        agentEnv: { findMany: async () => [] },
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
      agentMemberService: {
        listByEmail: async () => [],
        exists: async () => false,
        add: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: "member@example.com",
          createdAt: new Date(),
        }),
        remove: async (_agentId: string, memberId: string) => {
          deletedId = memberId;
        },
        listByAgentId: async () => [],
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
    // redirect_uri must point at the per-agent connect-slack callback, not
    // the removed /admin/provision/complete alias (UAP-3.3)
    expect(decodeURIComponent(location)).toContain(
      `redirect_uri=https://example.com/admin/agents/${AGENT_ID}/connect-slack/callback`,
    );
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

// ─── connect-slack routes (UAP-1.1) ────────────────────────────────────────────
//
// New per-agent routes that delegate to the same extracted
// SlackProvisioningService the legacy /admin/provision/* wizard now calls —
// they must reach the same successful outcomes as that wizard's Slack path,
// for an already-existing agent id passed explicitly in the URL.

describe("admin UI — POST /admin/agents/:id/connect-slack", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  it("valid xoxe.xoxp- token → 302 redirect to slack.com/oauth authorize URL with provision-state cookie set", async () => {
    const app = createAdminUIApp(makeMockDeps());

    const body = new URLSearchParams({
      xoxpToken: "xoxe.xoxp-1-fake-token-for-testing",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-slack`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("https://slack.com/oauth/authorize");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("slack_provision_state=");
  });

  it("missing xoxpToken → redirects back to the agent page with an error", async () => {
    const app = createAdminUIApp(makeMockDeps());

    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-slack`, {
      method: "POST",
      body: new URLSearchParams({}).toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain(`/admin/agents/${AGENT_ID}`);
    expect(location).toContain("error=");
  });

  it("agent id that doesn't exist → redirects back with an error, no Slack call", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
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
      }),
    );

    const body = new URLSearchParams({
      xoxpToken: "xoxe.xoxp-1-fake-token-for-testing",
    });
    const res = await app.request(
      "/admin/agents/nonexistent-agent/connect-slack",
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${adminCookie}`,
        },
        redirect: "manual",
      },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/admin/agents/nonexistent-agent");
    expect(location).toContain("error=");
  });
});

describe("admin UI — GET /admin/agents/:id/connect-slack/callback", () => {
  let adminCookie: string;
  const PROVISION_STATE_COOKIE = "slack_provision_state";

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  async function makeProvisionStateCookie(
    opts: { agentId?: string; expired?: boolean } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return sign(
      {
        agentId: opts.agentId ?? AGENT_ID,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        signingSecret: "test-signing-secret",
        appId: "A0123456789",
        iat: now,
        exp: opts.expired ? now - 10 : now + 300,
      },
      SESSION_SECRET,
      "HS256",
    );
  }

  it("valid state cookie + code param → stores SLACK_BOT_TOKEN and renders the xapp-token page (same outcome as /admin/provision/complete)", async () => {
    const patchCalls: Array<{ env: Record<string, string> }> = [];
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async (_agentId: string, env: Record<string, string>) => {
            patchCalls.push({ env });
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const provisionState = await makeProvisionStateCookie();
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-slack/callback?code=valid-oauth-code`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${PROVISION_STATE_COOKIE}=${provisionState}`,
        },
      },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("xapp");
    expect(patchCalls.some((c) => "SLACK_BOT_TOKEN" in c.env)).toBe(true);
    // The rendered xapp-token form must submit to the per-agent connect-slack
    // route, not the removed /admin/provision/xapp-token alias (UAP-3.3).
    expect(html).toContain(
      `action="/admin/agents/${AGENT_ID}/connect-slack/app-token"`,
    );
    expect(html).not.toContain('action="/admin/provision/xapp-token"');
  });

  it("valid state cookie + code param → persists the resolved slackId through the full HTTP route, and the agent detail page then renders the Sync Manifest button (UAP-1.3 acceptance criterion 2)", async () => {
    // Step 1: exercise the real connect-slack/callback HTTP route (not just
    // the service layer) with an agent that has no slackId yet, and prove
    // agentService.updateFields is invoked with the Slack-resolved user id.
    const updateFieldsCalls: Array<{
      agentId: string;
      fields: { slackId?: string | null };
    }> = [];
    const initialAgent = {
      id: AGENT_ID,
      name: "Test Agent",
      slackId: null,
      selfHosted: false,
      typeName: "coding",
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
      repos: [],
      reviewAuthorAllowlist: [],
      patchAuthorAllowlist: [],
      restrictSlackToMembers: false,
      missingRequiredEnv: [],
    };

    const callbackApp = createAdminUIApp(
      makeMockDeps({
        agentService: {
          listAll: async () => [],
          listByIds: async () => [],
          searchByName: async () => [],
          listOptions: async () => [],
          create: async () => {
            throw new Error("not implemented");
          },
          delete: async () => {},
          getDetail: async () => initialAgent,
          updateFields: async (
            agentId: string,
            fields: { slackId?: string | null },
          ) => {
            updateFieldsCalls.push({ agentId, fields });
            return { ...initialAgent, ...fields };
          },
        },
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    // Sanity check: before the flow, the agent page does NOT show the
    // Sync Manifest button (slackId is null).
    const beforeRes = await callbackApp.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(beforeRes.status).toBe(200);
    const beforeHtml = await beforeRes.text();
    expect(beforeHtml).not.toContain("Sync Manifest");

    const provisionState = await makeProvisionStateCookie();
    const callbackRes = await callbackApp.request(
      `/admin/agents/${AGENT_ID}/connect-slack/callback?code=valid-oauth-code`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${PROVISION_STATE_COOKIE}=${provisionState}`,
        },
      },
    );
    expect(callbackRes.status).toBe(200);

    // The key assertion: updateFields was called through the real HTTP
    // route with a non-null, non-empty slackId for the correct agent.
    expect(updateFieldsCalls).toHaveLength(1);
    expect(updateFieldsCalls[0]?.agentId).toBe(AGENT_ID);
    expect(updateFieldsCalls[0]?.fields.slackId).toBeTruthy();

    // Step 2: prove admin-ui-pages.ts's Sync Manifest gate renders once
    // slackId is populated, by hitting the agent detail route again with
    // a mock reflecting the post-flow (slackId-populated) state — mirroring
    // what completeConnect() just persisted above.
    const resolvedSlackId = updateFieldsCalls[0]?.fields.slackId as string;
    const detailApp = createAdminUIApp(
      makeMockDeps({
        agentService: {
          listAll: async () => [],
          listByIds: async () => [],
          searchByName: async () => [],
          listOptions: async () => [],
          create: async () => {
            throw new Error("not implemented");
          },
          delete: async () => {},
          getDetail: async () => ({
            ...initialAgent,
            slackId: resolvedSlackId,
          }),
          updateFields: async () => {
            throw new Error("not implemented");
          },
        },
      }),
    );

    const afterRes = await detailApp.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(afterRes.status).toBe(200);
    const afterHtml = await afterRes.text();
    expect(afterHtml).toContain("Sync Manifest");
  });

  it("missing state cookie → renders an error page", async () => {
    const app = createAdminUIApp(makeMockDeps());

    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-slack/callback?code=some-code`,
      {
        headers: { Cookie: `admin_session=${adminCookie}` },
      },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
  });
});

describe("admin UI — POST /admin/agents/:id/connect-slack/app-token", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  it("valid xapp- token → 200, SLACK_APP_TOKEN stored, crons reconciled (same outcome as /admin/provision/xapp-token)", async () => {
    const patchCalls: Array<{ env: Record<string, string> }> = [];
    const reconcileCalls: string[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async (_agentId: string, env: Record<string, string>) => {
            patchCalls.push({ env });
          },
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
          reconcileSystemCrons: async (agentId: string) => {
            reconcileCalls.push(agentId);
            return { created: 3, updated: 0, deleted: 0 };
          },
        },
      }),
    );

    const body = new URLSearchParams({
      xappToken: "xapp-1-TEST-fake-socket-token",
    });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-slack/app-token`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${adminCookie}`,
        },
      },
    );

    expect(res.status).toBe(200);
    expect(
      patchCalls.some(
        (c) => c.env.SLACK_APP_TOKEN === "xapp-1-TEST-fake-socket-token",
      ),
    ).toBe(true);
    expect(reconcileCalls).toContain(AGENT_ID);
  });

  it("invalid xappToken (missing xapp- prefix) → shows error, no env write", async () => {
    let patched = false;
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {
            patched = true;
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const body = new URLSearchParams({
      xappToken: "not-a-valid-xapp-token",
    });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-slack/app-token`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${adminCookie}`,
        },
      },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
    expect(patched).toBe(false);
  });
});

// ─── connect-github routes (UAP-1.2) ───────────────────────────────────────────
//
// New per-agent routes that delegate to the same extracted
// GithubProvisioningService the legacy /admin/provision/* wizard's GitHub
// branches (and github-app/complete + github-app/installed) now call — they
// must reach the same successful outcomes as those legacy routes, for an
// already-existing agent id passed explicitly in the URL, across all three
// modes (pat / app-auto / app-manual).

const GITHUB_PROVISION_STATE_COOKIE = "github_provision_state";

describe("admin UI — POST /admin/agents/:id/connect-github (mode=pat)", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  it("valid PAT → 200 completion page, GH_TOKEN stored, no GitHub call", async () => {
    const patchCalls: Array<{ env: Record<string, string> }> = [];
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async (_agentId: string, env: Record<string, string>) => {
            patchCalls.push({ env });
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const body = new URLSearchParams({
      ghAuthMode: "pat",
      ghPat: "ghp_faketokenfortesting1234567890",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    expect(
      patchCalls.some(
        (c) => c.env.GH_TOKEN === "ghp_faketokenfortesting1234567890",
      ),
    ).toBe(true);
  });

  it("missing ghPat → error, no env write", async () => {
    let patched = false;
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {
            patched = true;
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const body = new URLSearchParams({ ghAuthMode: "pat" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
    expect(patched).toBe(false);
  });

  it("agent id that doesn't exist → error, no GitHub/env call", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
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
      }),
    );

    const body = new URLSearchParams({
      ghAuthMode: "pat",
      ghPat: "ghp_faketokenfortesting1234567890",
    });
    const res = await app.request(
      "/admin/agents/nonexistent-agent/connect-github",
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${adminCookie}`,
        },
      },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
  });
});

describe("admin UI — POST /admin/agents/:id/connect-github (mode=app, app-manual)", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  it("valid App ID/Installation ID/PEM key → 200 completion page, all three env vars stored", async () => {
    const patchCalls: Array<{ env: Record<string, string> }> = [];
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async (_agentId: string, env: Record<string, string>) => {
            patchCalls.push({ env });
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const body = new URLSearchParams({
      ghAuthMode: "app",
      ghAppMode: "manual",
      ghAppId: "12345",
      ghAppInstallationId: "67890",
      ghAppPrivateKey:
        "-----BEGIN RSA PRIVATE KEY-----\nfoo\n-----END RSA PRIVATE KEY-----",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    expect(patchCalls.some((c) => c.env.GH_APP_ID === "12345")).toBe(true);
    expect(
      patchCalls.some((c) => c.env.GH_APP_INSTALLATION_ID === "67890"),
    ).toBe(true);
    expect(
      patchCalls.some((c) =>
        c.env.GH_APP_PRIVATE_KEY?.includes("BEGIN RSA PRIVATE KEY"),
      ),
    ).toBe(true);
  });

  it("UAP-5.4: valid App ID/Installation ID/PEM uploaded as a file → 200 completion page, GH_APP_PRIVATE_KEY stored with the file's text content", async () => {
    const patchCalls: Array<{ env: Record<string, string> }> = [];
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async (_agentId: string, env: Record<string, string>) => {
            patchCalls.push({ env });
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const pemContents =
      "-----BEGIN RSA PRIVATE KEY-----\nfaketestkeydata\n-----END RSA PRIVATE KEY-----";
    const form = new FormData();
    form.append("ghAuthMode", "app");
    form.append("ghAppMode", "manual");
    form.append("ghAppId", "12345");
    form.append("ghAppInstallationId", "67890");
    form.append(
      "ghAppPrivateKeyFile",
      new File([pemContents], "private-key.pem", {
        type: "application/x-pem-file",
      }),
    );

    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: form,
      headers: {
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    expect(patchCalls.some((c) => c.env.GH_APP_ID === "12345")).toBe(true);
    expect(
      patchCalls.some((c) => c.env.GH_APP_INSTALLATION_ID === "67890"),
    ).toBe(true);
    expect(
      patchCalls.some((c) => c.env.GH_APP_PRIVATE_KEY === pemContents),
    ).toBe(true);
  });

  it("non-numeric App ID → error, no env write", async () => {
    let patched = false;
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {
            patched = true;
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const body = new URLSearchParams({
      ghAuthMode: "app",
      ghAppMode: "manual",
      ghAppId: "not-numeric",
      ghAppInstallationId: "67890",
      ghAppPrivateKey:
        "-----BEGIN RSA PRIVATE KEY-----\nfoo\n-----END RSA PRIVATE KEY-----",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
    expect(patched).toBe(false);
  });

  it("invalid PEM (missing BEGIN/PRIVATE KEY) → error, no env write", async () => {
    let patched = false;
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {
            patched = true;
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const body = new URLSearchParams({
      ghAuthMode: "app",
      ghAppMode: "manual",
      ghAppId: "12345",
      ghAppInstallationId: "67890",
      ghAppPrivateKey: "not-a-pem-key",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
    expect(patched).toBe(false);
  });
});

describe("admin UI — POST /admin/agents/:id/connect-github (mode=app, app-auto)", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  it("valid githubOrg → renders auto-submitting manifest redirect page targeting the org, with manifest hidden field, and sets state cookie with agentId + githubOrg", async () => {
    const app = createAdminUIApp(makeMockDeps());

    const body = new URLSearchParams({
      ghAuthMode: "app",
      ghAppMode: "auto",
      githubOrg: "my-org",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      'action="https://github.com/organizations/my-org/settings/apps/new"',
    );
    expect(html).toContain('name="manifest"');

    const setCookieHeader = res.headers.get("Set-Cookie") ?? "";
    const match = setCookieHeader.match(/([a-zA-Z_]+_provision_state)=([^;]+)/);
    expect(match).toBeTruthy();
    const jwtToken = decodeURIComponent(match?.[2] ?? "");
    const parts = jwtToken.split(".");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(
      Buffer.from(parts[1] ?? "", "base64url").toString("utf-8"),
    );
    expect(payload.githubOrg).toBe("my-org");
    expect(payload.agentId).toBe(AGENT_ID);
  });

  it("invalid githubOrg → error before any redirect page is rendered", async () => {
    const app = createAdminUIApp(makeMockDeps());

    const body = new URLSearchParams({
      ghAuthMode: "app",
      ghAppMode: "auto",
      githubOrg: "-not-valid-!!",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
    expect(html).not.toContain("github.com/organizations/");
  });
});

describe("admin UI — GET /admin/agents/:id/connect-github/callback", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  async function makeProvisionStateCookie(
    overrides?: Record<string, unknown>,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return sign(
      {
        agentId: AGENT_ID,
        githubOrg: "my-org",
        iat: now,
        exp: now + 300,
        ...overrides,
      },
      SESSION_SECRET,
      "HS256",
    );
  }

  it("valid state cookie + code param → exchanges code, writes GH_APP_ID + GH_APP_PRIVATE_KEY, renders installations/new link (same outcome as /admin/provision/github-app/complete)", async () => {
    const patchCalls: Array<{
      agentId: string;
      env: Record<string, string>;
      secretKeys?: Set<string>;
    }> = [];
    const app = createAdminUIApp(
      makeMockDeps({
        githubAppClient: {
          exchangeManifestCode: async (code: string) => {
            expect(code).toBe("valid-code-123");
            return {
              appId: "999111",
              slug: "my-shipwright-agent",
              pem: "-----BEGIN RSA PRIVATE KEY-----\nmock\n-----END RSA PRIVATE KEY-----",
              clientId: "gh-client-id",
              clientSecret: "gh-client-secret",
            };
          },
        },
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async (
            agentId: string,
            env: Record<string, string>,
            secretKeys?: Set<string>,
          ) => {
            patchCalls.push({ agentId, env, secretKeys });
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const stateCookie = await makeProvisionStateCookie();
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/callback?code=valid-code-123`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${GITHUB_PROVISION_STATE_COOKIE}=${stateCookie}`,
        },
      },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      "https://github.com/apps/my-shipwright-agent/installations/new",
    );
    expect(
      patchCalls.some(
        (c) => c.agentId === AGENT_ID && c.env.GH_APP_ID === "999111",
      ),
    ).toBe(true);
    expect(
      patchCalls.some((c) =>
        c.env.GH_APP_PRIVATE_KEY?.includes("BEGIN RSA PRIVATE KEY"),
      ),
    ).toBe(true);
    expect(
      patchCalls.some((c) => c.env.GH_APP_CLIENT_ID === "gh-client-id"),
    ).toBe(true);
    expect(
      patchCalls.some((c) => c.env.GH_APP_CLIENT_SECRET === "gh-client-secret"),
    ).toBe(true);
    const clientIdCall = patchCalls.find(
      (c) => c.env.GH_APP_CLIENT_ID === "gh-client-id",
    );
    expect(clientIdCall?.secretKeys?.has("GH_APP_CLIENT_SECRET")).toBe(true);
    expect(clientIdCall?.secretKeys?.has("GH_APP_CLIENT_ID")).toBe(false);
  });

  it("missing state cookie → renders an error page", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/callback?code=some-code`,
      {
        headers: { Cookie: `admin_session=${adminCookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
  });

  it("state cookie for a different agent id → forbidden", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const stateCookie = await makeProvisionStateCookie({
      agentId: "different-agent-id",
    });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/callback?code=some-code`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${GITHUB_PROVISION_STATE_COOKIE}=${stateCookie}`,
        },
      },
    );
    // Either forbidden or a state-mismatch error page — must not proceed to
    // exchange the code for the wrong agent's env.
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      const html = await res.text();
      expect(html.toLowerCase()).toContain("error");
    }
  });

  it("exchangeManifestCode rejecting → renders an error page rather than throwing", async () => {
    const stateCookie = await makeProvisionStateCookie();
    const app = createAdminUIApp(
      makeMockDeps({
        githubAppClient: {
          exchangeManifestCode: async () => {
            throw new Error("GitHub conversion failed");
          },
        },
      }),
    );
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/callback?code=bad-code`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${GITHUB_PROVISION_STATE_COOKIE}=${stateCookie}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
  });

  it("missing code query param → renders an error page", async () => {
    const stateCookie = await makeProvisionStateCookie();
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/callback`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${GITHUB_PROVISION_STATE_COOKIE}=${stateCookie}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
  });
});

describe("admin UI — GET /admin/agents/:id/connect-github/installed", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  async function makeProvisionStateCookie(
    overrides?: Record<string, unknown>,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return sign(
      {
        agentId: AGENT_ID,
        githubOrg: "my-org",
        iat: now,
        exp: now + 300,
        ...overrides,
      },
      SESSION_SECRET,
      "HS256",
    );
  }

  it("valid state cookie + installation_id → writes GH_APP_INSTALLATION_ID, renders success, reconciles crons (same outcome as /admin/provision/github-app/installed)", async () => {
    const patchCalls: Array<{ agentId: string; env: Record<string, string> }> =
      [];
    const reconcileCalls: string[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async (agentId: string, env: Record<string, string>) => {
            patchCalls.push({ agentId, env });
          },
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
          reconcileSystemCrons: async (agentId: string) => {
            reconcileCalls.push(agentId);
            return { created: 2, updated: 0, deleted: 0 };
          },
        },
      }),
    );

    const stateCookie = await makeProvisionStateCookie();
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/installed?installation_id=778899`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${GITHUB_PROVISION_STATE_COOKIE}=${stateCookie}`,
        },
      },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("alert-success");
    expect(
      patchCalls.some(
        (c) =>
          c.agentId === AGENT_ID && c.env.GH_APP_INSTALLATION_ID === "778899",
      ),
    ).toBe(true);
    expect(reconcileCalls).toContain(AGENT_ID);
  });

  it("reconcileSystemCrons rejecting → still renders success (best-effort, non-fatal)", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
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
          reconcileSystemCrons: async () => {
            throw new Error("reconcile boom");
          },
        },
      }),
    );

    const stateCookie = await makeProvisionStateCookie();
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/installed?installation_id=778899`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${GITHUB_PROVISION_STATE_COOKIE}=${stateCookie}`,
        },
      },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("alert-success");
  });

  it("non-numeric installation_id → error, no env write", async () => {
    let patched = false;
    const stateCookie = await makeProvisionStateCookie();
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {
            patched = true;
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/installed?installation_id=not-a-number`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${GITHUB_PROVISION_STATE_COOKIE}=${stateCookie}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
    expect(patched).toBe(false);
  });

  it("missing state cookie → renders an error page", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/installed?installation_id=123`,
      {
        headers: { Cookie: `admin_session=${adminCookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
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

  it("GET /admin/tasks with no params (default board view) forwards state=open and limit=200 (TBC-2.1)", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 200, offset: 0 };
        },
      }),
    );
    await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].get("state")).toBe("open");
    expect(capturedParams[0].has("status")).toBe(false);
    expect(capturedParams[0].get("limit")).toBe("200");
  });

  it("GET /admin/tasks?view=table with no other params forwards neither state nor status, with the standard limit=50 (TBC-2.1)", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/tasks?view=table", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].has("state")).toBe(false);
    expect(capturedParams[0].has("status")).toBe(false);
    expect(capturedParams[0].get("limit")).toBe("50");
  });

  it("GET /admin/tasks?hitl=true forwards hitl=true to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/tasks?hitl=true", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].get("hitl")).toBe("true");
  });

  it("GET /admin/tasks?hitl=false forwards hitl=false to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/tasks?hitl=false", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].get("hitl")).toBe("false");
  });

  it("GET /admin/tasks with no hitl param forwards no hitl to the task store", async () => {
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
    expect(capturedParams[0].has("hitl")).toBe(false);
  });

  it("GET /admin/tasks?hitl=garbage forwards no hitl to the task store (invalid values treated as no filter)", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/tasks?hitl=garbage", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].has("hitl")).toBe(false);
  });

  it("GET /admin/tasks requests sort=desc from the task store", async () => {
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
    expect(capturedParams[0].get("sort")).toBe("desc");
  });

  it("GET /admin/tasks?source=entropy-fix forwards source to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/tasks?source=entropy-fix", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].get("source")).toBe("entropy-fix");
  });

  it("GET /admin/tasks?repo=a&repo=b&org=app-vitals forwards repeated repo and org params to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/tasks?repo=a&repo=b&org=app-vitals", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].getAll("repo")).toEqual(["a", "b"]);
    expect(capturedParams[0].getAll("org")).toEqual(["app-vitals"]);
  });

  it("GET /admin/tasks?repo=org/repo (single value) still forwards a single repo param (backward compat)", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/tasks?repo=org%2Frepo", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].getAll("repo")).toEqual(["org/repo"]);
  });

  it("GET /admin/tasks with no repo/org params forwards neither to the task store", async () => {
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
    expect(capturedParams[0].has("repo")).toBe(false);
    expect(capturedParams[0].has("org")).toBe(false);
  });

  it("GET /admin/tasks?repo=a&repo=b renders both selected repo options in the multiselect", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
        fetchDistinctTaskValues: async () => ({
          sessions: [],
          repos: ["a", "b", "c"],
          orgs: [],
        }),
      }),
    );
    const res = await app.request("/admin/tasks?repo=a&repo=b", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    const html = await res.text();
    expect(html).toContain('<option value="a" selected>a</option>');
    expect(html).toContain('<option value="b" selected>b</option>');
    expect(html).toContain('<option value="c">c</option>');
  });

  it("GET /admin/tasks with no source param forwards no source to the task store", async () => {
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
    expect(capturedParams[0].has("source")).toBe(false);
  });

  it("GET /admin/tasks?source=entropy-fix round-trips into the source filter input value", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/tasks?source=entropy-fix", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    const html = await res.text();
    expect(html).toContain('name="source"');
    expect(html).toContain('value="entropy-fix"');
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

  it("GET /admin/tasks with no ?view= defaults to the board layout (AXR-1.3)", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
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
    expect(html).toContain('class="board"');
    expect(html).not.toContain('<table class="data-table">');
  });

  it("GET /admin/tasks?view=table renders the pre-redesign dense table (AXR-1.3)", async () => {
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
    const res = await app.request("/admin/tasks?view=table", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<table class="data-table">');
    expect(html).toContain("<th>ID</th>");
    expect(html).toContain("Build auth module");
  });

  it("GET /admin/tasks includes joined PR blocked/blockedReason/claimedBy/claimedAt/heartbeatAt for a task with an open PR (AXR-1.2)", async () => {
    const mockTasks = [
      {
        id: "task-join-1",
        title: "Task with an open PR",
        status: "in_progress",
        session: "session-abc",
        repo: "org/repo",
        pr: 200,
        assignee: null,
        claimedBy: null,
      },
    ];
    const MOCK_JOINED_PR: PrListItem = {
      id: "pr-join-1",
      repo: "org/repo",
      prNumber: 200,
      staged: false,
      state: "open",
      reviewState: "pending",
      patchCycles: 0,
      reviewCycles: 0,
      blocked: true,
      blockedReason: "Waiting on CI",
      claimedBy: "agent-join",
      claimedAt: "2026-01-01T00:00:00.000Z",
      heartbeatAt: "2026-01-01T00:05:00.000Z",
    };
    let capturedParams: URLSearchParams | null = null;
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: mockTasks,
          total: mockTasks.length,
          limit: 50,
          offset: 0,
        }),
        fetchTaskStorePrs: async (params: URLSearchParams) => {
          capturedParams = params;
          return { prs: [MOCK_JOINED_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-pr-blocked="true"');
    expect(html).toContain('data-pr-blocked-reason="Waiting on CI"');
    expect(html).toContain('data-pr-claimed-by="agent-join"');
    expect(html).toContain('data-pr-claimed-at="2026-01-01T00:00:00.000Z"');
    expect(html).toContain('data-pr-heartbeat-at="2026-01-01T00:05:00.000Z"');
    expect(capturedParams).not.toBeNull();
    const captured = capturedParams as unknown as URLSearchParams;
    expect(captured.get("repo")).toBe("org/repo");
    expect(captured.get("prNumber")).toBe("200");
  });

  it("GET /admin/tasks renders without PR join data when the task has no repo/pr set (AXR-1.2)", async () => {
    const mockTasks = [
      {
        id: "task-no-pr",
        title: "Task without a PR",
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
        fetchTaskStorePrs: async () => {
          throw new Error("should not be called for a task with no repo/pr");
        },
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("data-pr-blocked");
  });

  it("GET /admin/tasks renders without PR join data when fetchTaskStorePrs throws (degrade, don't fail the page) (AXR-1.2)", async () => {
    const mockTasks = [
      {
        id: "task-join-err",
        title: "Task whose PR lookup fails",
        status: "in_progress",
        session: null,
        repo: "org/repo",
        pr: 201,
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
        fetchTaskStorePrs: async () => {
          throw new Error("task store unavailable");
        },
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Task whose PR lookup fails");
    expect(html).not.toContain("data-pr-blocked");
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

  // TBF-1.1: the table row's Release button must carry the current table-view
  // list URL as `from` so the redirect back to Task Detail can hand it to
  // that page's "← Tasks" link — otherwise it falls back to bare
  // /admin/tasks, which is the board (AXR-1.3), not the table view the user
  // released the task from.
  it("GET /admin/tasks?view=table row Release form carries ?from=<current table-view URL>", async () => {
    const mockTasks = [
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
    const res = await app.request("/admin/tasks?view=table&status=in_progress", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const expectedFrom = encodeURIComponent(
      "/admin/tasks?status=in_progress&view=table",
    );
    expect(html).toContain(
      `action="/admin/tasks/task-2/release?from=${expectedFrom}"`,
    );
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

  it("GET /admin/tasks with fetchDistinctTaskValues configured includes agent names in the autocomplete datalist via AgentService", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
        fetchDistinctTaskValues: async () => ({
          sessions: [],
          repos: [],
          orgs: [],
        }),
      }),
    );
    const res = await app.request("/admin/tasks", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<datalist id="agents-list">');
    expect(html).toContain('<option value="Test Agent">');
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

  // TBF-1.1: a valid `from` on the release POST is forwarded onto the
  // redirect target so the Task Detail page's "← Tasks" link can send the
  // user back to the table view they released the task from.
  it("POST /admin/tasks/:id/release?from=<valid list URL> forwards it onto the redirect target", async () => {
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
    const from = "/admin/tasks?status=in_progress&view=table";
    const res = await app.request(
      `/admin/tasks/task-2/release?from=${encodeURIComponent(from)}`,
      {
        method: "POST",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/tasks/task-2?from=${encodeURIComponent(from)}`,
    );
    expect(released).toEqual(["task-2"]);
  });

  // Reuses the same TASK_LIST_BACK_HREF_PATTERN allowlist as the Task
  // Detail page's own back-link resolver — an unlisted `from` value on the
  // release POST must not become an open redirect off the admin domain.
  it.each([
    ["https://evil.com", "absolute URL"],
    ["//evil.com", "protocol-relative URL"],
    ["javascript:alert(1)", "javascript: URI"],
    ["/admin/other", "different admin path"],
  ])(
    "POST /admin/tasks/:id/release?from=<malicious %s (%s)> is rejected, not forwarded",
    async (maliciousFrom) => {
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
      const res = await app.request(
        `/admin/tasks/task-2/release?from=${encodeURIComponent(maliciousFrom)}`,
        {
          method: "POST",
          headers: { Cookie: `admin_session=${cookie}` },
        },
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/tasks/task-2");
      expect(released).toEqual(["task-2"]);
    },
  );

  it("POST /admin/tasks/:id/release with no ?from= redirects exactly as before (no from param)", async () => {
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

  it("GET /admin/tasks/:id?from=<valid list URL> round-trips into the ← Tasks back link", async () => {
    const mockTask = {
      id: "task-42",
      title: "Build the thing",
      status: "in_progress",
      session: null,
      repo: "org/repo",
    };
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
      }),
    );
    const from = "/admin/tasks?status=in_progress&page=2";
    const res = await app.request(
      `/admin/tasks/task-42?from=${encodeURIComponent(from)}`,
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `<a href="${from.replace(/&/g, "&amp;")}" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  it.each([
    ["https://evil.com", "absolute URL"],
    ["//evil.com", "protocol-relative URL"],
    ["javascript:alert(1)", "javascript: URI"],
    ["/admin/other", "different admin path"],
  ])(
    "GET /admin/tasks/:id?from=<malicious %s (%s)> falls back to /admin/tasks",
    async (maliciousFrom) => {
      const mockTask = {
        id: "task-42",
        title: "Build the thing",
        status: "in_progress",
        session: null,
        repo: "org/repo",
      };
      const app = createAdminUIApp(
        makeMockDeps({
          fetchTaskStoreTask: async (id: string) =>
            id === "task-42" ? mockTask : null,
        }),
      );
      const res = await app.request(
        `/admin/tasks/task-42?from=${encodeURIComponent(maliciousFrom)}`,
        { headers: { Cookie: `admin_session=${cookie}` } },
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(
        `<a href="/admin/tasks" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
      );
      expect(html).not.toContain(maliciousFrom);
    },
  );

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

  it("GET /admin/tasks/:id renders PR section when fetchTaskStorePrs finds a PR via repo+prNumber lookup", async () => {
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
      pr: 100,
      claimedAt: "2024-01-15T10:00:00.000Z",
    };
    const MOCK_PR_ITEM: PrListItem = {
      id: "pr-test-1",
      repo: "org/repo",
      prNumber: 100,
      staged: false,
      state: "open",
      reviewState: "approved",
      patchCycles: 1,
      reviewCycles: 0,
      reviewedAt: "2026-06-20T10:00:00Z",
      patchedAt: null,
    };
    let capturedParams: URLSearchParams | null = null;
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
        fetchTaskStorePrs: async (params: URLSearchParams) => {
          capturedParams = params;
          return { prs: [MOCK_PR_ITEM], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-42", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Pull Request Review");
    expect(html).toContain("#100");
    expect(capturedParams).not.toBeNull();
    const captured = capturedParams as unknown as URLSearchParams;
    expect(captured.get("repo")).toBe("org/repo");
    expect(captured.get("prNumber")).toBe("100");
    expect(captured.has("taskId")).toBe(false);
  });

  it("GET /admin/tasks/:id renders without PR section when fetchTaskStorePrs throws", async () => {
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
      pr: 100,
      claimedAt: "2024-01-15T10:00:00.000Z",
    };
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
        fetchTaskStorePrs: async (_params: URLSearchParams) => {
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

  it("GET /admin/tasks/:id renders without PR section when fetchTaskStorePrs is absent", async () => {
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
      pr: 100,
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

  it("GET /admin/tasks/:id renders without PR section when task has no repo/pr set", async () => {
    const mockTask = {
      id: "task-43",
      title: "Build another thing",
      status: "pending",
      description: "Do more work",
      branch: null,
      assignee: null,
      claimedBy: null,
      session: null,
      repo: null,
      pr: null,
    };
    let called = false;
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-43" ? mockTask : null,
        fetchTaskStorePrs: async (params: URLSearchParams) => {
          called = true;
          return { prs: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/tasks/task-43", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Pull Request Review");
    expect(called).toBe(false);
  });

  it("GET /admin/tasks?view=table with no ?state= forwards no state to task-store (show all)", async () => {
    let capturedParams: URLSearchParams | null = null;
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params: URLSearchParams) => {
          capturedParams = params;
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/tasks?view=table", {
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

// ─── Session detail page (ASV-1.1) ──────────────────────────────────────────

describe("admin UI — session detail page", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("GET /admin/sessions/:id renders stat cards + task table grouped by ready/in_progress/blocked/closed", async () => {
    const mockTasks = [
      {
        id: "task-1",
        title: "Build auth module",
        status: "pending",
        session: "session-abc",
        repo: "example-org/example-repo",
        layer: "Backend",
        hours: 2,
        assignee: null,
        claimedBy: null,
      },
      {
        id: "task-2",
        title: "Ship the feature",
        status: "done",
        session: "session-abc",
        repo: "example-org/example-repo",
        layer: "Frontend",
        hours: 3,
        assignee: null,
        claimedBy: null,
      },
    ];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params) => {
          expect(params.get("session")).toBe("session-abc");
          return {
            tasks: mockTasks,
            total: mockTasks.length,
            limit: 500,
            offset: 0,
          };
        },
      }),
    );
    const res = await app.request("/admin/sessions/session-abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Build auth module");
    expect(html).toContain("Ship the feature");
    // Ready/in_progress/blocked/closed grouping present — task-1 is pending
    // with no blockedBy entries (ready), task-2 is done (closed).
    expect(html).toMatch(/1[^0-9]*ready/i);
    expect(html).toMatch(/1[^0-9]*closed/i);
    expect(html).toContain("Ready (1)");
    expect(html).toContain("Closed (1)");
    // Status column
    expect(html).toContain("Status");
  });

  it("GET /admin/sessions/:id renders a sensible empty state for a session with no tasks", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/sessions/empty-session", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("no tasks");
  });

  it("GET /admin/sessions/:id requests sort=desc from the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async (params) => {
          capturedParams.push(params);
          return { tasks: [], total: 0, limit: 500, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/sessions/session-abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].get("sort")).toBe("desc");
  });

  it("GET /admin/sessions/:id?from=<valid task list URL> round-trips into the ← Tasks back link", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const from = "/admin/tasks?status=in_progress&page=2";
    const res = await app.request(
      `/admin/sessions/session-abc?from=${encodeURIComponent(from)}`,
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `<a href="${from.replace(/&/g, "&amp;")}" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  it("GET /admin/sessions/:id?from=<valid task detail URL> round-trips into the ← Tasks back link", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const from = "/admin/tasks/task-42";
    const res = await app.request(
      `/admin/sessions/session-abc?from=${encodeURIComponent(from)}`,
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `<a href="${from}" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  it.each([
    ["https://evil.com", "absolute URL"],
    ["//evil.com", "protocol-relative URL"],
    ["javascript:alert(1)", "javascript: URI"],
    ["/admin/other", "different admin path"],
  ])(
    "GET /admin/sessions/:id?from=<malicious %s (%s)> falls back to /admin/tasks",
    async (maliciousFrom) => {
      const app = createAdminUIApp(
        makeMockDeps({
          fetchTaskStoreTasks: async () => ({
            tasks: [],
            total: 0,
            limit: 500,
            offset: 0,
          }),
        }),
      );
      const res = await app.request(
        `/admin/sessions/session-abc?from=${encodeURIComponent(maliciousFrom)}`,
        { headers: { Cookie: `admin_session=${cookie}` } },
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(
        `<a href="/admin/tasks" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
      );
      expect(html).not.toContain(maliciousFrom);
    },
  );

  it("GET /admin/sessions/:id unauthenticated redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/sessions/session-abc");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });

  it("GET /admin/sessions/:id degrades gracefully when fetchTaskStoreTasks is not configured", async () => {
    const app = createAdminUIApp(makeMockDeps({}));
    const res = await app.request("/admin/sessions/session-abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Task store unavailable");
  });

  // AC4/AC5: full round-trip — tasks list (with filters/page) → Session Detail
  // → back link returns to the exact originating list URL.
  it("round-trip: tasks list → Session Detail → back link returns to the originating list view", async () => {
    const mockTasks = [
      {
        id: "task-1",
        title: "Build auth module",
        status: "in_progress",
        session: "session-abc",
        repo: "example-org/example-repo",
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
    const listRes = await app.request(
      "/admin/tasks?status=in_progress&page=2",
      {
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(listRes.status).toBe(200);
    const listHtml = await listRes.text();
    const match = listHtml.match(
      /<a href="(\/admin\/sessions\/session-abc\?from=[^"]+)"/,
    );
    expect(match).not.toBeNull();
    const sessionHref = (match as RegExpMatchArray)[1].replace(/&amp;/g, "&");

    const sessionRes = await app.request(sessionHref, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(sessionRes.status).toBe(200);
    const sessionHtml = await sessionRes.text();
    expect(sessionHtml).toContain(
      `<a href="/admin/tasks?status=in_progress&amp;page=2" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  // AC4/AC5: full round-trip — Task Detail → Session Detail → back link
  // returns to the originating task detail page.
  it("round-trip: Task Detail → Session Detail → back link returns to the originating task detail page", async () => {
    const mockTask = {
      id: "task-42",
      title: "Build the thing",
      status: "in_progress",
      session: "session-abc",
      repo: "org/repo",
    };
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-42" ? mockTask : null,
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 500,
          offset: 0,
        }),
      }),
    );
    const taskRes = await app.request("/admin/tasks/task-42", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(taskRes.status).toBe(200);
    const taskHtml = await taskRes.text();
    const match = taskHtml.match(
      /<a href="(\/admin\/sessions\/session-abc\?from=[^"]+)"/,
    );
    expect(match).not.toBeNull();
    const sessionHref = (match as RegExpMatchArray)[1].replace(/&amp;/g, "&");

    const sessionRes = await app.request(sessionHref, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(sessionRes.status).toBe(200);
    const sessionHtml = await sessionRes.text();
    expect(sessionHtml).toContain(
      `<a href="/admin/tasks/task-42" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });
});

describe("admin UI — create agent with author allowlist", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents with valid authorAllowlist creates agent and redirects to detail page", async () => {
    let capturedAllowlist: string[] | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      updateFields: async (
        id: string,
        input: { reviewAuthorAllowlist?: string[] },
      ) => {
        capturedAllowlist = input.reviewAuthorAllowlist;
        return {
          id,
          name: "Test Agent",
          slackId: null,
          selfHosted: true,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          reviewAuthorAllowlist: capturedAllowlist ?? [],
          patchAuthorAllowlist: [],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "Test Agent",
      type: "coding",
      authorAllowlist: "octocat\nanother-user\noctocat",
    });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
    // Deduped — "octocat" only appears once even though submitted twice.
    expect(capturedAllowlist).toEqual(["octocat", "another-user"]);
  });

  it("POST /admin/agents with invalid authorAllowlist entries deletes the created agent and redirects with error", async () => {
    let deletedId: string | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      delete: async (id: string) => {
        deletedId = id;
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "Test Agent",
      type: "coding",
      authorAllowlist: "octocat\nnot a valid login!",
    });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/agents/new?error=invalid_author_allowlist_format",
    );
    expect(deletedId).toBe(AGENT_ID);
  });
});

describe("admin UI — create agent with patch author allowlist", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents with valid patchAuthorAllowlist creates agent and redirects to detail page", async () => {
    let capturedAllowlist: string[] | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      updateFields: async (
        id: string,
        input: { patchAuthorAllowlist?: string[] },
      ) => {
        capturedAllowlist = input.patchAuthorAllowlist;
        return {
          id,
          name: "Test Agent",
          slackId: null,
          selfHosted: true,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          authorAllowlist: [],
          reviewAuthorAllowlist: [],
          patchAuthorAllowlist: capturedAllowlist ?? [],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "Test Agent",
      type: "coding",
      patchAuthorAllowlist: "octocat\nanother-user\noctocat",
    });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
    // Deduped — "octocat" only appears once even though submitted twice.
    expect(capturedAllowlist).toEqual(["octocat", "another-user"]);
  });

  it("POST /admin/agents with invalid patchAuthorAllowlist entries deletes the created agent and redirects with error", async () => {
    let deletedId: string | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      delete: async (id: string) => {
        deletedId = id;
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "Test Agent",
      type: "coding",
      patchAuthorAllowlist: "octocat\nnot a valid login!",
    });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/agents/new?error=invalid_author_allowlist_format",
    );
    expect(deletedId).toBe(AGENT_ID);
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
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => null,
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
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: ["my-org/my-repo"],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
      }),
      updateFields: async (id: string, input: { repos?: string[] }) => {
        capturedRepos = input.repos;
        return {
          id,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: capturedRepos ?? [],
          reviewAuthorAllowlist: [],
          patchAuthorAllowlist: [],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
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

describe("admin UI — author allowlist mutation routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/review-author-allowlist/add returns 403 for non-admin non-member", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/review-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${outsiderCookie}`,
        },
      },
    );
    expect(res.status).toBe(403);
  });

  it("POST /admin/agents/:id/review-author-allowlist/add with invalid login format redirects with error=invalid_author_allowlist_format", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "not a valid login!" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/review-author-allowlist/add`,
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
    expect(res.headers.get("Location")).toBe(
      `/admin/agents/${AGENT_ID}?error=invalid_author_allowlist_format`,
    );
  });

  it("POST /admin/agents/:id/review-author-allowlist/add returns 404 when agent not found", async () => {
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => null,
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/review-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("POST /admin/agents/:id/review-author-allowlist/add with valid login redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/review-author-allowlist/add`,
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

  it("POST /admin/agents/:id/review-author-allowlist/add deduplicates — does not add the same login twice", async () => {
    let capturedAllowlist: string[] | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: ["octocat"],
        patchAuthorAllowlist: ["octocat"],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
      }),
      updateFields: async (
        id: string,
        input: { reviewAuthorAllowlist?: string[] },
      ) => {
        capturedAllowlist = input.reviewAuthorAllowlist;
        return {
          id,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          reviewAuthorAllowlist: capturedAllowlist ?? [],
          patchAuthorAllowlist: [],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/review-author-allowlist/add`,
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
    // update should not have been called — no-op deduplication returns existing list
    // If update was called, allowlist should still be exactly ["octocat"]
    if (capturedAllowlist !== undefined) {
      expect(capturedAllowlist).toEqual(["octocat"]);
    }
  });

  it("POST /admin/agents/:id/review-author-allowlist/add writes to reviewAuthorAllowlist", async () => {
    let capturedInput: Record<string, unknown> | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
      }),
      updateFields: async (id: string, input: Record<string, unknown>) => {
        capturedInput = input;
        return {
          id,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          reviewAuthorAllowlist: ["octocat"],
          patchAuthorAllowlist: [],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/review-author-allowlist/add`,
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
    expect(capturedInput).toEqual({ reviewAuthorAllowlist: ["octocat"] });
  });

  it("POST /admin/agents/:id/review-author-allowlist/delete with valid login redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/review-author-allowlist/delete`,
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

  it("old route path /admin/agents/:id/author-allowlist/add no longer exists", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("old route path /admin/agents/:id/author-allowlist/delete no longer exists", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/author-allowlist/delete`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("admin UI — patch author allowlist mutation routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/patch-author-allowlist/add returns 403 for non-admin non-member", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${outsiderCookie}`,
        },
      },
    );
    expect(res.status).toBe(403);
  });

  it("POST /admin/agents/:id/patch-author-allowlist/add with invalid login format redirects with error=invalid_author_allowlist_format", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "not a valid login!" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/add`,
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
    expect(res.headers.get("Location")).toBe(
      `/admin/agents/${AGENT_ID}?error=invalid_author_allowlist_format`,
    );
  });

  it("POST /admin/agents/:id/patch-author-allowlist/add returns 404 when agent not found", async () => {
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => null,
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("POST /admin/agents/:id/patch-author-allowlist/add with valid login redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/add`,
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

  it("POST /admin/agents/:id/patch-author-allowlist/add deduplicates — does not add the same login twice", async () => {
    let capturedAllowlist: string[] | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: ["octocat"],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
      }),
      updateFields: async (
        id: string,
        input: { patchAuthorAllowlist?: string[] },
      ) => {
        capturedAllowlist = input.patchAuthorAllowlist;
        return {
          id,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          reviewAuthorAllowlist: [],
          patchAuthorAllowlist: capturedAllowlist ?? [],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/add`,
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
    // update should not have been called — no-op deduplication returns existing list
    // If update was called, allowlist should still be exactly ["octocat"]
    if (capturedAllowlist !== undefined) {
      expect(capturedAllowlist).toEqual(["octocat"]);
    }
  });

  it("POST /admin/agents/:id/patch-author-allowlist/add writes to patchAuthorAllowlist", async () => {
    let capturedInput: Record<string, unknown> | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
      }),
      updateFields: async (id: string, input: Record<string, unknown>) => {
        capturedInput = input;
        return {
          id,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          reviewAuthorAllowlist: [],
          patchAuthorAllowlist: ["octocat"],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/add`,
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
    expect(capturedInput).toEqual({ patchAuthorAllowlist: ["octocat"] });
  });

  it("POST /admin/agents/:id/patch-author-allowlist/delete with valid login redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/delete`,
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

  it("POST /admin/agents/:id/patch-author-allowlist/delete removes the login from patchAuthorAllowlist", async () => {
    let capturedInput: Record<string, unknown> | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: ["octocat", "other-user"],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
      }),
      updateFields: async (id: string, input: Record<string, unknown>) => {
        capturedInput = input;
        return {
          id,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          reviewAuthorAllowlist: [],
          patchAuthorAllowlist: ["other-user"],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/delete`,
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
    expect(capturedInput).toEqual({ patchAuthorAllowlist: ["other-user"] });
  });
});

describe("admin UI — Slack access settings route (restrictSlackToMembers)", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/settings returns 403 for non-admin non-member", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ restrictSlackToMembers: "true" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${outsiderCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("POST /admin/agents/:id/settings returns 403 for non-admin AgentMember", async () => {
    const MEMBER_EMAIL = "member@example.com";
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      MEMBER_EMAIL,
      false,
    );
    const deps = makeMockDeps();
    deps.agentMemberService = {
      ...deps.agentMemberService,
      exists: async (_agentId: string, email: string) => email === MEMBER_EMAIL,
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ restrictSlackToMembers: "true" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${memberCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("POST /admin/agents/:id/settings with restrictSlackToMembers:true and zero members redirects with warning query param", async () => {
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      updateFields: async (
        id: string,
        input: { restrictSlackToMembers?: boolean },
      ) => ({
        id,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: input.restrictSlackToMembers ?? false,
        missingRequiredEnv: [],
      }),
    };
    deps.agentMemberService = {
      ...deps.agentMemberService,
      listByAgentId: async () => [],
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ restrictSlackToMembers: "true" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/agents/${AGENT_ID}?warning=restrict_slack_no_members`,
    );
  });

  it("POST /admin/agents/:id/settings with restrictSlackToMembers:true and existing members redirects with no warning param", async () => {
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      updateFields: async (
        id: string,
        input: { restrictSlackToMembers?: boolean },
      ) => ({
        id,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: input.restrictSlackToMembers ?? false,
        missingRequiredEnv: [],
      }),
    };
    deps.agentMemberService = {
      ...deps.agentMemberService,
      listByAgentId: async () => [
        {
          id: "m1",
          agentId: AGENT_ID,
          email: "member@example.com",
          createdAt: new Date("2024-01-01"),
        },
      ],
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ restrictSlackToMembers: "true" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
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

  it("POST /admin/agents/:id/settings with restrictSlackToMembers:false never redirects with a warning, even with zero members", async () => {
    const deps = makeMockDeps();
    deps.agentMemberService = {
      ...deps.agentMemberService,
      listByAgentId: async () => [],
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({});
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
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

  it("GET /admin/agents/:id with warning=restrict_slack_no_members renders a warning banner", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}?warning=restrict_slack_no_members`,
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="alert alert-warning"');
    expect(html).toContain("no members");
  });

  it("GET /admin/agents/:id without a warning query param renders no warning banner", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("restrict_slack_no_members");
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

  it("GET /admin/prs renders the 'Waiting: Blocked' badge for a blocked PR", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [{ ...MOCK_PR, blocked: true }],
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
    expect(html).toContain("Waiting: Blocked");
    expect(html).not.toContain("Waiting: HITL");
  });

  it("GET /admin/prs requests sort=desc from the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrs: async (params) => {
          capturedParams.push(params);
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].get("sort")).toBe("desc");
  });

  it("GET /admin/prs?blocked=true forwards blocked=true to the task store", async () => {
    let capturedParams: URLSearchParams | null = null;
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrs: async (params: URLSearchParams) => {
          capturedParams = params;
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/prs?blocked=true", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(capturedParams).not.toBeNull();
    expect((capturedParams as unknown as URLSearchParams).get("blocked")).toBe(
      "true",
    );
  });

  it("GET /admin/prs without blocked param does not forward a blocked param", async () => {
    let capturedParams: URLSearchParams | null = null;
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrs: async (params: URLSearchParams) => {
          capturedParams = params;
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(capturedParams).not.toBeNull();
    expect(
      (capturedParams as unknown as URLSearchParams).get("blocked"),
    ).toBeNull();
  });

  it("GET /admin/prs?repo=a&repo=b&org=app-vitals forwards repeated repo and org params to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrs: async (params) => {
          capturedParams.push(params);
          return { prs: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/prs?repo=a&repo=b&org=app-vitals", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].getAll("repo")).toEqual(["a", "b"]);
    expect(capturedParams[0].getAll("org")).toEqual(["app-vitals"]);
  });

  it("GET /admin/prs?repo=org/repo (single value) still forwards a single repo param (backward compat)", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrs: async (params) => {
          capturedParams.push(params);
          return { prs: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/prs?repo=org%2Frepo", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].getAll("repo")).toEqual(["org/repo"]);
  });

  it("GET /admin/prs with no repo/org params forwards neither to the task store", async () => {
    const capturedParams: URLSearchParams[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrs: async (params) => {
          capturedParams.push(params);
          return { prs: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].has("repo")).toBe(false);
    expect(capturedParams[0].has("org")).toBe(false);
  });

  it("GET /admin/prs?repo=a&repo=b renders both selected repo options in the multiselect", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
        fetchDistinctTaskValues: async () => ({
          sessions: [],
          repos: ["a", "b", "c"],
          orgs: [],
        }),
      }),
    );
    const res = await app.request("/admin/prs?repo=a&repo=b", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    const html = await res.text();
    expect(html).toContain('<option value="a" selected>a</option>');
    expect(html).toContain('<option value="b" selected>b</option>');
    expect(html).toContain('<option value="c">c</option>');
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

  it("GET /admin/prs renders all linked tasks for a PR with 2 linked tasks", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [MOCK_PR],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        fetchTaskStoreTasks: async (params: URLSearchParams) => {
          if (
            params.get("repo") === "app-vitals/shipwright" &&
            params.get("pr") === "42"
          ) {
            return {
              tasks: [
                { id: "TASK-A", title: "A", status: "done" },
                { id: "TASK-B", title: "B", status: "done" },
              ],
              total: 2,
              limit: 50,
              offset: 0,
            };
          }
          return { tasks: [], total: 0, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<a href="/admin/tasks/TASK-A"');
    expect(html).toContain('<a href="/admin/tasks/TASK-B"');
  });

  it("GET /admin/prs renders the empty-state dash for a PR with 0 linked tasks", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [MOCK_PR],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        fetchTaskStoreTasks: async (_params: URLSearchParams) => ({
          tasks: [],
          total: 0,
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
    expect(html).not.toContain('<a href="/admin/tasks/task-abc"');
    expect(html).toContain('<span style="color:#9ca3af">—</span>');
  });

  it("GET /admin/prs degrades linked tasks to empty when fetchTaskStoreTasks throws", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [MOCK_PR],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        fetchTaskStoreTasks: async (_params: URLSearchParams) => {
          throw new Error("task store unavailable");
        },
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<span style="color:#9ca3af">—</span>');
  });

  it("GET /admin/prs renders empty-state dash for linked tasks when fetchTaskStoreTasks is absent", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [MOCK_PR],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        // fetchTaskStoreTasks intentionally absent
      }),
    );
    const res = await app.request("/admin/prs", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<span style="color:#9ca3af">—</span>');
  });

  it("GET /admin/prs?taskId= resolves the task's repo+pr live instead of forwarding taskId to /prs", async () => {
    let capturedPrsParams: URLSearchParams | null = null;
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-abc"
            ? {
                id: "task-abc",
                title: "Some task",
                status: "done",
                repo: "app-vitals/shipwright",
                pr: 42,
              }
            : null,
        fetchTaskStorePrs: async (params: URLSearchParams) => {
          capturedPrsParams = params;
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/prs?taskId=task-abc", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Filter form still shows what the user typed
    expect(html).toContain('value="task-abc"');
    expect(capturedPrsParams).not.toBeNull();
    const capturedPrs = capturedPrsParams as unknown as URLSearchParams;
    expect(capturedPrs.get("repo")).toBe("app-vitals/shipwright");
    expect(capturedPrs.get("prNumber")).toBe("42");
    expect(capturedPrs.has("taskId")).toBe(false);
  });

  it("GET /admin/prs?taskId=&repo= with a repo filter matching the task's resolved repo still applies the task filter", async () => {
    let capturedPrsParams: URLSearchParams | null = null;
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-abc"
            ? {
                id: "task-abc",
                title: "Some task",
                status: "done",
                repo: "app-vitals/shipwright",
                pr: 42,
              }
            : null,
        fetchTaskStorePrs: async (params: URLSearchParams) => {
          capturedPrsParams = params;
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request(
      "/admin/prs?taskId=task-abc&repo=app-vitals%2Fshipwright",
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    expect(capturedPrsParams).not.toBeNull();
    const capturedPrs = capturedPrsParams as unknown as URLSearchParams;
    expect(capturedPrs.getAll("repo")).toEqual(["app-vitals/shipwright"]);
    expect(capturedPrs.get("prNumber")).toBe("42");
  });

  it("GET /admin/prs?taskId=&repo= with a repo filter conflicting with the task's resolved repo renders empty list instead of silently overwriting the user's repo filter", async () => {
    let prsCalled = false;
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-abc"
            ? {
                id: "task-abc",
                title: "Some task",
                status: "done",
                repo: "app-vitals/shipwright",
                pr: 42,
              }
            : null,
        fetchTaskStorePrs: async (_params: URLSearchParams) => {
          prsCalled = true;
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request(
      "/admin/prs?taskId=task-abc&repo=some-other-org%2Fother-repo",
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(prsCalled).toBe(false);
    expect(html).toContain("No PRs found");
    // The user's own repo selection is preserved in the form, not silently dropped.
    expect(html).toContain("some-other-org/other-repo");
  });

  it("GET /admin/prs?taskId= for a task with no pr set renders empty list without an unfiltered query", async () => {
    let prsCalled = false;
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async (id: string) =>
          id === "task-nopr"
            ? {
                id: "task-nopr",
                title: "No PR yet",
                status: "pending",
                repo: "app-vitals/shipwright",
                pr: null,
              }
            : null,
        fetchTaskStorePrs: async (_params: URLSearchParams) => {
          prsCalled = true;
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/prs?taskId=task-nopr", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(prsCalled).toBe(false);
    expect(html).toContain("No PRs found");
  });

  it("GET /admin/prs?taskId= for an unknown task renders empty list without an unfiltered query", async () => {
    let prsCalled = false;
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStoreTask: async (_id: string) => null,
        fetchTaskStorePrs: async (_params: URLSearchParams) => {
          prsCalled = true;
          return { prs: [MOCK_PR], total: 1, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/admin/prs?taskId=missing-task", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(prsCalled).toBe(false);
    expect(html).toContain("No PRs found");
  });

  it("GET /admin/prs/:id returns 200 with PR detail when fetchTaskStorePrById is injected and returns a PR", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? MOCK_PR : null,
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
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

  it("GET /admin/prs/:id renders 'Blocked' field, not 'HITL', when the PR is blocked", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? { ...MOCK_PR, blocked: true } : null,
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/prs/pr-smoke-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Blocked");
    expect(html).not.toContain("HITL");
  });

  it("GET /admin/prs/:id renders linked task(s) via a live GET /tasks?repo=&pr= lookup instead of pr.taskId", async () => {
    let capturedParams: URLSearchParams | null = null;
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? MOCK_PR : null,
        fetchTaskStoreTasks: async (params: URLSearchParams) => {
          capturedParams = params;
          return {
            tasks: [{ id: "TASK-LIVE", title: "Live", status: "done" }],
            total: 1,
            limit: 50,
            offset: 0,
          };
        },
      }),
    );
    const res = await app.request("/admin/prs/pr-smoke-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<a href="/admin/tasks/TASK-LIVE"');
    expect(capturedParams).not.toBeNull();
    expect((capturedParams as unknown as URLSearchParams).get("repo")).toBe(
      "app-vitals/shipwright",
    );
    expect((capturedParams as unknown as URLSearchParams).get("pr")).toBe("42");
  });

  it("GET /admin/prs/:id renders no Task row when fetchTaskStoreTasks is not injected", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? MOCK_PR : null,
        // fetchTaskStoreTasks intentionally absent
      }),
    );
    const res = await app.request("/admin/prs/pr-smoke-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("/admin/tasks/");
  });

  it("GET /admin/prs/:id renders no Task row when fetchTaskStoreTasks throws", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? MOCK_PR : null,
        fetchTaskStoreTasks: async () => {
          throw new Error("task store unavailable");
        },
      }),
    );
    const res = await app.request("/admin/prs/pr-smoke-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("/admin/tasks/");
  });

  it("GET /admin/prs resolves claimedBy agent id to its name via AgentService", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrs: async () => ({
          prs: [{ ...MOCK_PR, claimedBy: AGENT_ID }],
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
    expect(html).toContain("Test Agent");
  });

  it("GET /admin/prs/:id resolves claimedBy agent id to its name via AgentService", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        fetchTaskStorePrById: async (id: string) =>
          id === "pr-smoke-1" ? { ...MOCK_PR, claimedBy: AGENT_ID } : null,
        fetchTaskStoreTasks: async () => ({
          tasks: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/admin/prs/pr-smoke-1", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Test Agent");
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

  it("GET /public/tasks?source=entropy-fix forwards source to the task store", async () => {
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
    await app.request("/public/tasks?source=entropy-fix");
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].get("source")).toBe("entropy-fix");
  });

  it("GET /public/tasks with no source param forwards no source to the task store", async () => {
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
    expect(capturedParams[0].has("source")).toBe(false);
  });

  it("GET /public/tasks?source=entropy-fix returns only matching rows and round-trips the filter value", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async (params) => {
          // Simulate the task-store applying the source filter server-side.
          const all = [
            {
              id: "pub-task-src-1",
              title: "Entropy sourced task",
              status: "pending",
              session: "sess-pub",
              repo: PUBLIC_REPO,
              assignee: null,
              claimedBy: null,
              source: "entropy-fix",
            },
            {
              id: "pub-task-src-2",
              title: "Manually filed task",
              status: "pending",
              session: "sess-pub",
              repo: PUBLIC_REPO,
              assignee: null,
              claimedBy: null,
              source: "manual",
            },
          ];
          const source = params.get("source");
          const tasks = source ? all.filter((t) => t.source === source) : all;
          return { tasks, total: tasks.length, limit: 50, offset: 0 };
        },
      }),
    );
    const res = await app.request("/public/tasks?source=entropy-fix");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Entropy sourced task");
    expect(html).not.toContain("Manually filed task");
  });

  it("GET /public/tasks requests sort=desc from the task store", async () => {
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
    expect(capturedParams[0].get("sort")).toBe("desc");
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

  it("GET /public/tasks does not leak /admin/ links for claimed or blocked tasks", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async () => ({
          tasks: [
            {
              id: "pub-task-3",
              title: "Public task gamma",
              status: "blocked",
              session: "sess-pub",
              repo: PUBLIC_REPO,
              assignee: null,
              claimedBy: "agent-pub",
              blockedBy: [
                { type: "dependency", id: "pub-task-1", status: "pending" },
              ],
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    const res = await app.request("/public/tasks");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Public task gamma");
    expect(html).toContain("Blocked:");
    expect(html).toContain("agent-pub");
    expect(html).not.toContain("/admin/");
  });

  it("GET /public/tasks never includes the joined PR fields, even for a task with repo+pr set and fetchTaskStorePrs wired (AXR-1.2)", async () => {
    let fetchTaskStorePrsCalled = false;
    const app = createAdminUIApp(
      makeMockDeps({
        publicRepo: PUBLIC_REPO,
        fetchTaskStoreTasks: async () => ({
          tasks: [
            {
              id: "pub-task-4",
              title: "Public task delta",
              status: "in_progress",
              session: "sess-pub",
              repo: PUBLIC_REPO,
              pr: 300,
              assignee: null,
              claimedBy: "agent-pub",
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        fetchTaskStorePrs: async () => {
          fetchTaskStorePrsCalled = true;
          return {
            prs: [
              {
                id: "pr-pub-1",
                repo: PUBLIC_REPO,
                prNumber: 300,
                staged: false,
                state: "open",
                reviewState: "pending",
                patchCycles: 0,
                reviewCycles: 0,
                blocked: true,
                blockedReason: "Waiting on CI",
                claimedBy: "agent-pub",
                claimedAt: "2026-01-01T00:00:00.000Z",
                heartbeatAt: "2026-01-01T00:05:00.000Z",
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          };
        },
      }),
    );
    const res = await app.request("/public/tasks");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Public task delta");
    // The public route never calls the PR-join fetcher and never renders the
    // joined fields — this is the read-only board, join data stays admin-only.
    expect(fetchTaskStorePrsCalled).toBe(false);
    expect(html).not.toContain("data-pr-blocked");
    expect(html).not.toContain("data-pr-blocked-reason");
    expect(html).not.toContain("data-pr-claimed-by");
    expect(html).not.toContain("data-pr-claimed-at");
    expect(html).not.toContain("data-pr-heartbeat-at");
    expect(html).not.toContain("Waiting on CI");
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

// ─── Okta-authenticated access control ────────────────────────────────────────
//
// ESR-2.1: verification-only coverage. These duplicate the Google-authenticated
// access-control cases above (agents-list filtering, per-agent 403s,
// admin-only-route 403s, /admin/chat 403) under an Okta-issued session, to
// confirm isAdmin/AgentMember/assertAgentAccess behave identically regardless
// of which OAuth provider minted the session cookie — completeLogin() in
// admin-ui.ts is shared across providers, so the session JWT shape (and thus
// every downstream access check) is provider-agnostic. No new access-control
// logic is introduced here.
//
// The first test below closes the gap flagged in review: rather than minting
// the session JWT directly via makeSessionCookie() (which never touches Okta
// code), it drives the real GET /admin/auth/okta/callback handler — token
// exchange + userinfo normalization via the makeOktaClient mock — and then
// reuses the cookie that handler actually sets on a subsequent authenticated
// request, proving the callback-minted session drives access control exactly
// like the directly-minted ones the remaining tests below use.

describe("admin UI — Okta-authenticated access control", () => {
  const OKTA_MEMBER_EMAIL = "okta-member@example.com";
  const OKTA_OTHER_AGENT_ID = "agent-okta-other-456";

  it("session minted by the real Okta callback route grants access like a directly-minted session", async () => {
    // Drive the actual /admin/auth/okta/callback handler: CSRF state check,
    // exchangeCode() + getUserInfo() via the makeOktaClient mock, allowlist
    // check, then completeLogin() mints the session cookie.
    const nonce = "test-okta-nonce-real-callback";
    const oauthState = encodeURIComponent(JSON.stringify({ nonce }));
    const params = new URLSearchParams({ state: nonce, code: "auth-code-123" });
    const callbackApp = createAdminUIApp(
      makeMockDeps({
        oktaClient: makeOktaClient({
          getUserInfo: () =>
            Promise.resolve({
              sub: "okta-sub-real-callback",
              email: "admin@example.com",
              email_verified: true,
              name: "Admin User",
            }),
        }),
      }),
    );
    const callbackRes = await callbackApp.request(
      new Request(
        `https://example.com/admin/auth/okta/callback?${params.toString()}`,
        { headers: { Cookie: `oauth_state=${oauthState}` } },
      ),
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("Location")).toBe("/admin/agents");
    // Response.headers.get() folds multiple Set-Cookie headers (here: the
    // oauth_state deletion + the new admin_session) into one comma-joined
    // string, so pull out the admin_session value specifically.
    const setCookieHeader = callbackRes.headers.get("Set-Cookie") ?? "";
    const sessionCookieMatch = setCookieHeader.match(/admin_session=([^;,]+)/);
    const sessionCookie = sessionCookieMatch?.[1];
    expect(sessionCookie).toBeTruthy();

    // Reuse the callback-minted cookie on a subsequent request — same
    // access-control path (isAdmin from the session) as the
    // makeSessionCookie()-based tests below, but now proven to originate
    // from the real Okta callback handler rather than a bypass.
    const listApp = createAdminUIApp(makeMockDeps());
    const listRes = await listApp.request("/admin/agents", {
      headers: { Cookie: `admin_session=${sessionCookie}` },
    });
    expect(listRes.status).toBe(200);
    const listHtml = await listRes.text();
    expect(listHtml).toContain("Test Agent");
  });

  it("Okta-authenticated admin sees all agents and can create one", async () => {
    const adminCookie = await makeSessionCookie(
      SESSION_SECRET,
      "okta-sub-admin",
      "admin@example.com",
      true,
    );

    // AC1a: admin sees all agents in the agents list.
    const listApp = createAdminUIApp(makeMockDeps());
    const listRes = await listApp.request("/admin/agents", {
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(listRes.status).toBe(200);
    const listHtml = await listRes.text();
    expect(listHtml).toContain("Test Agent");

    // AC1b: admin can create an agent.
    const createApp = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({
      name: "Okta Created Agent",
      type: "coding",
    });
    const createRes = await createApp.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(createRes.status).toBe(302);
    expect(createRes.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("Okta-authenticated non-admin sees only their AgentMember agent(s), 403s elsewhere", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "okta-sub-member",
      OKTA_MEMBER_EMAIL,
      false,
    );

    // AC2a: agents list is filtered down to the member's own agent(s).
    const deps = makeMockDeps({
      prisma: {
        agent: {
          findMany: async ({
            where,
          }: { where?: { id?: { in?: string[] } } } = {}) => {
            const allAgents = [
              {
                id: AGENT_ID,
                name: "My Okta Agent",
                slackId: "U1",
                createdAt: new Date("2024-01-01"),
              },
              {
                id: OKTA_OTHER_AGENT_ID,
                name: "Other Okta Agent",
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
            name: "My Okta Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "My Okta Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          delete: async () => ({
            id: AGENT_ID,
            name: "My Okta Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
        },
        agentEnv: { findMany: async () => [] },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [
            {
              id: "m1",
              agentId: AGENT_ID,
              email: OKTA_MEMBER_EMAIL,
              createdAt: new Date(),
            },
          ],
          findUnique: async () => null,
          create: async () => ({
            id: "m1",
            agentId: AGENT_ID,
            email: OKTA_MEMBER_EMAIL,
          }),
          deleteMany: async () => ({ count: 0 }),
        },
      },
      agentMemberService: {
        listByEmail: async (email: string) =>
          email === OKTA_MEMBER_EMAIL
            ? [
                {
                  id: "m1",
                  agentId: AGENT_ID,
                  email: OKTA_MEMBER_EMAIL,
                  createdAt: new Date(),
                },
              ]
            : [],
        exists: async (_agentId: string, email: string) =>
          email === OKTA_MEMBER_EMAIL,
        add: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: OKTA_MEMBER_EMAIL,
          createdAt: new Date(),
        }),
        remove: async () => {},
        listByAgentId: async () => [],
      },
      agentService: {
        listAll: async () => [
          {
            id: AGENT_ID,
            name: "My Okta Agent",
            slackId: "U1",
            selfHosted: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          },
          {
            id: OKTA_OTHER_AGENT_ID,
            name: "Other Okta Agent",
            slackId: "U2",
            selfHosted: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          },
        ],
        listByIds: async (ids: string[]) =>
          [
            {
              id: AGENT_ID,
              name: "My Okta Agent",
              slackId: "U1",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
            {
              id: OKTA_OTHER_AGENT_ID,
              name: "Other Okta Agent",
              slackId: "U2",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
          ].filter((a) => ids.includes(a.id)),
        searchByName: async () => [],
        listOptions: async () => [
          { id: AGENT_ID, name: "My Okta Agent" },
          { id: OKTA_OTHER_AGENT_ID, name: "Other Okta Agent" },
        ],
        create: async () => {
          throw new Error("not implemented");
        },
        delete: async () => {},
        getDetail: async () => null,
        updateFields: async () => {
          throw new Error("not implemented");
        },
      },
    });
    const listApp = createAdminUIApp(deps);
    const listRes = await listApp.request("/admin/agents", {
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(listRes.status).toBe(200);
    const listHtml = await listRes.text();
    expect(listHtml).toContain("My Okta Agent");
    expect(listHtml).not.toContain("Other Okta Agent");

    // AC2b: per-agent access — a non-member gets 403 on an agent they don't belong to.
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "okta-sub-outsider",
      "okta-outsider@example.com",
      false,
    );
    const detailApp = createAdminUIApp(makeMockDeps());
    const detailRes = await detailApp.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${outsiderCookie}` },
    });
    expect(detailRes.status).toBe(403);

    // AC2c: admin-only-route 403 for a non-admin Okta session.
    const provisionApp = createAdminUIApp(makeMockDeps());
    const provisionRes = await provisionApp.request("/admin/agents/new", {
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(provisionRes.status).toBe(403);
  });

  it("Okta-authenticated non-admin can configure their own agent's settings", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "okta-sub-member",
      OKTA_MEMBER_EMAIL,
      false,
    );
    let upsertCalledWith: unknown[] = [];
    const deps = makeMockDeps({
      agentMemberService: {
        listByEmail: async () => [],
        exists: async (_agentId: string, email: string) =>
          email === OKTA_MEMBER_EMAIL,
        add: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: OKTA_MEMBER_EMAIL,
          createdAt: new Date(),
        }),
        remove: async () => {},
        listByAgentId: async () => [],
      },
      agentEnvService: {
        getByAgentId: async () => ({ env: { FOO: "bar" }, secretKeys: [] }),
        upsert: async (...args: unknown[]) => {
          upsertCalledWith = args;
        },
        patch: async (...args: unknown[]) => {
          upsertCalledWith = args;
        },
        deleteKey: async () => {},
        getConfigBundle: async () => null,
      },
    });
    const app = createAdminUIApp(deps);
    const form = new FormData();
    form.append("key", "MY_VAR");
    form.append("value", "configured-by-okta-member");
    const res = await app.request(`/admin/agents/${AGENT_ID}/envs`, {
      method: "POST",
      body: form,
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(res.status).toBe(302);
    expect(upsertCalledWith.length).toBeGreaterThan(0);
  });

  it("/admin/chat returns 403 for an Okta-authenticated non-admin", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "okta-sub-member",
      OKTA_MEMBER_EMAIL,
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/chat", {
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(res.status).toBe(403);
  });
});

// ─── Web Push routes (CFB-4.2) ─────────────────────────────────────────────

const PUSH_WEBHOOK_TOKEN = "test-push-webhook-token";
const PUSH_SUBSCRIPTION_BODY = {
  endpoint: "https://push.example.com/sub-1",
  p256dh: "test-p256dh-key",
  auth: "test-auth-secret",
};

function makeFakePushService(
  notifyThreadReply: (thread: {
    threadId: string;
    agentId: string;
    title: string | null;
    preview: string | null;
  }) => Promise<{ delivered: number; pruned: number }> = async () => ({
    delivered: 0,
    pruned: 0,
  }),
): PushService {
  return { notifyThreadReply } as unknown as PushService;
}

describe("admin UI — POST /admin/chat/:agentId/push/subscribe", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("returns 503 when push is not enabled", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/subscribe`, {
      method: "POST",
      body: JSON.stringify(PUSH_SUBSCRIPTION_BODY),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "push_disabled" });
  });

  it("returns 403 for a non-admin session", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      "member@example.com",
      false,
    );
    const deps = makeMockDeps({
      pushService: makeFakePushService(),
      vapidPublicKey: "test-vapid-public-key",
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/subscribe`, {
      method: "POST",
      body: JSON.stringify(PUSH_SUBSCRIPTION_BODY),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${memberCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 when the body is missing required fields", async () => {
    const deps = makeMockDeps({
      pushService: makeFakePushService(),
      vapidPublicKey: "test-vapid-public-key",
    });
    deps.prisma.pushSubscription = {
      upsert: async () => ({ id: "sub-1" }),
      deleteMany: async () => ({ count: 0 }),
    };
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/subscribe`, {
      method: "POST",
      body: JSON.stringify({ endpoint: "https://push.example.com/sub-1" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("upserts the subscription and returns ok:true when push is enabled", async () => {
    let upsertCalledWith: unknown;
    const deps = makeMockDeps({
      pushService: makeFakePushService(),
      vapidPublicKey: "test-vapid-public-key",
    });
    deps.prisma.pushSubscription = {
      upsert: async (args: unknown) => {
        upsertCalledWith = args;
        return { id: "sub-1" };
      },
      deleteMany: async () => ({ count: 0 }),
    };
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/subscribe`, {
      method: "POST",
      body: JSON.stringify(PUSH_SUBSCRIPTION_BODY),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(upsertCalledWith).toBeDefined();
  });
});

describe("admin UI — POST /admin/chat/:agentId/push/unsubscribe", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("returns 503 when push is not enabled", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/unsubscribe`, {
      method: "POST",
      body: JSON.stringify({ endpoint: PUSH_SUBSCRIPTION_BODY.endpoint }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "push_disabled" });
  });

  it("returns 403 for a non-admin session", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      "member@example.com",
      false,
    );
    const deps = makeMockDeps({
      pushService: makeFakePushService(),
      vapidPublicKey: "test-vapid-public-key",
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/unsubscribe`, {
      method: "POST",
      body: JSON.stringify({ endpoint: PUSH_SUBSCRIPTION_BODY.endpoint }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${memberCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 when the body is missing the endpoint", async () => {
    const deps = makeMockDeps({
      pushService: makeFakePushService(),
      vapidPublicKey: "test-vapid-public-key",
    });
    deps.prisma.pushSubscription = {
      upsert: async () => ({ id: "sub-1" }),
      deleteMany: async () => ({ count: 0 }),
    };
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/unsubscribe`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("deletes the caller's subscription and returns ok:true when push is enabled", async () => {
    let deleteCalledWith: unknown;
    const deps = makeMockDeps({
      pushService: makeFakePushService(),
      vapidPublicKey: "test-vapid-public-key",
    });
    deps.prisma.pushSubscription = {
      upsert: async () => ({ id: "sub-1" }),
      deleteMany: async (args: unknown) => {
        deleteCalledWith = args;
        return { count: 1 };
      },
    };
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/unsubscribe`, {
      method: "POST",
      body: JSON.stringify({ endpoint: PUSH_SUBSCRIPTION_BODY.endpoint }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteCalledWith).toBeDefined();
  });
});

describe("admin UI — POST /admin/push/notify", () => {
  it("returns 503 when push is not enabled (no pushService/token configured)", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/push/notify", {
      method: "POST",
      body: JSON.stringify({ threadId: "thread-1", agentId: AGENT_ID }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "push_disabled" });
  });

  it("returns 401 when the bearer token does not match", async () => {
    const deps = makeMockDeps({
      pushService: makeFakePushService(),
      vapidPublicKey: "test-vapid-public-key",
      pushWebhookToken: PUSH_WEBHOOK_TOKEN,
    });
    const app = createAdminUIApp(deps);
    const res = await app.request("/admin/push/notify", {
      method: "POST",
      body: JSON.stringify({ threadId: "thread-1", agentId: AGENT_ID }),
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer wrong-token",
      },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 400 when the body is missing threadId or agentId", async () => {
    const deps = makeMockDeps({
      pushService: makeFakePushService(),
      vapidPublicKey: "test-vapid-public-key",
      pushWebhookToken: PUSH_WEBHOOK_TOKEN,
    });
    const app = createAdminUIApp(deps);
    const res = await app.request("/admin/push/notify", {
      method: "POST",
      body: JSON.stringify({ threadId: "thread-1" }),
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${PUSH_WEBHOOK_TOKEN}`,
      },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("returns ok:true with delivered/pruned counts on a valid request", async () => {
    const deps = makeMockDeps({
      pushService: makeFakePushService(async () => ({
        delivered: 2,
        pruned: 1,
      })),
      vapidPublicKey: "test-vapid-public-key",
      pushWebhookToken: PUSH_WEBHOOK_TOKEN,
    });
    const app = createAdminUIApp(deps);
    const res = await app.request("/admin/push/notify", {
      method: "POST",
      body: JSON.stringify({
        threadId: "thread-1",
        agentId: AGENT_ID,
        title: "Agent replied",
        preview: "Here's the answer...",
      }),
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${PUSH_WEBHOOK_TOKEN}`,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      delivered: 2,
      pruned: 1,
    });
  });
});
