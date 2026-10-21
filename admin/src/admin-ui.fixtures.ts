/**
 * admin/src/admin-ui.fixtures.ts
 * Shared test doubles for the admin UI smoke tests (createAdminUIApp deps,
 * session cookies, OAuth clients). Extracted from admin-ui.smoke.test.ts so
 * the coding extension's relocated UI smoke tests (admin/src/coding/) build
 * on the same doubles (AEP-3.2).
 */

import { sign } from "hono/jwt";
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

// ─── Constants ────────────────────────────────────────────────────────────────

export const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
export const GOOGLE_CLIENT_ID = "test-google-client-id";
export const GOOGLE_CLIENT_SECRET = "test-google-client-secret";
export const OKTA_CLIENT_ID = "test-okta-client-id";
export const OKTA_CLIENT_SECRET = "test-okta-client-secret";
export const OKTA_ISSUER = "https://example.okta.com/oauth2/default";
export const ADMIN_ALLOWED_EMAILS = ["admin@example.com", "other@example.com"];
export const AGENT_ID = "agent-test-123";
export const CRON_ID = "cron-test-456";
export const TOOL_ID = "tool-test-789";
export const TOKEN_ID = "token-test-abc";

// ─── Mock fixtures ────────────────────────────────────────────────────────────

export const MOCK_CRON = {
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
  lockdownDisabledAt: null,
  silent: false,
  preCheck: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

export const MOCK_TOOL = {
  id: TOOL_ID,
  agentId: AGENT_ID,
  pattern: "Bash(git:*)",
  enabled: true,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

export const MOCK_TOKEN = {
  id: TOKEN_ID,
  agentId: AGENT_ID,
  token: "hashed-token-value",
  label: "CI token",
  createdAt: new Date("2024-01-01"),
  revokedAt: null,
};

// ─── JWT helper ───────────────────────────────────────────────────────────────

export async function makeSessionCookie(
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

export function makeGoogleClient(overrides?: {
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

export function makeOktaClient(overrides?: {
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

export const BASE_SLACK_CLIENT: AdminUISlackClient = {
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

export const BASE_GITHUB_APP_CLIENT: AdminUIGithubAppClient = {
  exchangeManifestCode: async () => ({
    appId: "999111",
    slug: "test-shipwright-agent",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nmock\n-----END RSA PRIVATE KEY-----",
    clientId: "gh-app-client-id",
    clientSecret: "gh-app-client-secret",
  }),
};

export function makeMockDeps(
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
      add: async (agentId: string, name: string) => ({
        id: "p1",
        agentId,
        name,
        version: null,
        enabled: true,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      }),
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
        migrated: [],
        noOwner: [],
        dryRun: false,
        updated: [],
        orphans: [],
        failed: [],
      }),
    },
    serviceIntegrations: [
      {
        name: "task-store",
        listTokensForAgent: async () => [],
        revokeToken: async () => {},
      },
    ],
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
