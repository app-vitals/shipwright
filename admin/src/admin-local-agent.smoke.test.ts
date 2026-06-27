/**
 * admin/src/admin-local-agent.smoke.test.ts
 * Smoke tests for the "New local agent" create flow.
 *
 * Tests:
 * - GET /admin/agents/new — admin session returns 200 with form containing name input
 * - GET /admin/agents/new — non-admin session returns 403
 * - POST /admin/agents — admin creates agent with selfHosted:true → 302 redirect to /admin/agents/:id
 * - POST /admin/agents — non-admin session returns 403
 * - POST /admin/agents with repos — repos are attached to created agent
 * - POST /admin/agents with missing name — stays on form or redirects with error
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
const ADMIN_ALLOWED_EMAILS = ["admin@example.com"];
const NEW_AGENT_ID = "agent-new-local-123";

// ─── JWT helper ───────────────────────────────────────────────────────────────

async function makeSessionCookie(
  isAdmin = true,
  email = "admin@example.com",
): Promise<string> {
  return sign(
    {
      userId: "google-sub-123",
      email,
      isAdmin,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SESSION_SECRET,
    "HS256",
  );
}

// ─── Mock Google client ───────────────────────────────────────────────────────

function makeGoogleClient(): GoogleAuthClient {
  return {
    exchangeCode: () =>
      Promise.resolve({
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresIn: 3600,
      }),
    getUserInfo: () =>
      Promise.resolve({
        sub: "google-sub-123",
        email: "admin@example.com",
        email_verified: true,
        name: "Admin User",
      }),
  };
}

// ─── Mock deps factory ────────────────────────────────────────────────────────

function makeMockDeps(overrides?: Partial<AdminUIDeps>): AdminUIDeps {
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

  const defaults: AdminUIDeps = {
    prisma: {
      agent: {
        findMany: async () => [],
        findUnique: async () => null,
        create: async () => ({
          id: NEW_AGENT_ID,
          name: "New Local Agent",
          slackId: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        update: async () => ({
          id: NEW_AGENT_ID,
          name: "New Local Agent",
          slackId: null,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        delete: async () => ({
          id: NEW_AGENT_ID,
          name: "New Local Agent",
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
          agentId: NEW_AGENT_ID,
          email: "admin@example.com",
        }),
        deleteMany: async () => ({ count: 0 }),
      },
    },
    agentEnvService: {
      getByAgentId: async () => ({}),
      upsert: async () => {},
      deleteKey: async () => {},
      getConfigBundle: async () => null,
    },
    agentCronJobService: {
      list: async () => [],
      listWithRunSummary: async () => [],
      get: async () => {
        throw new Error("not found");
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
      create: async () => ({
        token: {
          id: "t1",
          label: null,
          createdAt: new Date(),
          revokedAt: null,
          agentId: NEW_AGENT_ID,
          token: "hash",
        },
        rawToken: "sw_raw123456",
      }),
      revoke: async () => {
        throw new Error("not implemented");
      },
    },
    agentPluginService: {
      list: async () => [],
    },
    sessionSecret: SESSION_SECRET,
    googleClientId: "test-google-client-id",
    googleClientSecret: "test-google-client-secret",
    adminAllowedEmails: ADMIN_ALLOWED_EMAILS,
    googleClient: makeGoogleClient(),
    slackClient: BASE_SLACK_CLIENT,
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
  };

  return { ...defaults, ...overrides };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("admin UI — new local agent create flow", () => {
  let adminCookie: string;
  let nonAdminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie(true);
    nonAdminCookie = await makeSessionCookie(false, "member@example.com");
  });

  // ── GET /admin/agents/new ─────────────────────────────────────────────────

  it("GET /admin/agents/new — admin session returns 200 with form containing name input", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents/new", {
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="name"');
    expect(html).toContain("New Local Agent");
  });

  it("GET /admin/agents/new — non-admin session returns 403", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents/new", {
      headers: { Cookie: `admin_session=${nonAdminCookie}` },
    });
    expect(res.status).toBe(403);
  });

  it("GET /admin/agents/new — unauthenticated redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents/new");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });

  // ── POST /admin/agents ────────────────────────────────────────────────────

  it("POST /admin/agents — admin creates agent with selfHosted:true → 302 redirect to /admin/agents/:id", async () => {
    let createdArgs: { data: { name: string; selfHosted?: boolean } } | null =
      null;
    const deps = makeMockDeps({
      prisma: {
        ...makeMockDeps().prisma,
        agent: {
          ...makeMockDeps().prisma.agent,
          create: async (args: {
            data: { name: string; selfHosted?: boolean };
          }) => {
            createdArgs = args;
            return {
              id: NEW_AGENT_ID,
              name: args.data.name,
              slackId: null,
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
            };
          },
        },
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ name: "My Local Agent" });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${NEW_AGENT_ID}`);
    expect(createdArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(createdArgs).not.toBeNull() above
    expect(createdArgs!.data.selfHosted).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(createdArgs).not.toBeNull() above
    expect(createdArgs!.data.name).toBe("My Local Agent");
  });

  it("POST /admin/agents — non-admin session returns 403", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ name: "My Local Agent" });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${nonAdminCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("POST /admin/agents with repos — repos are attached to created agent via update", async () => {
    let updateArgs: {
      where: { id: string };
      data: { repos: string[] };
    } | null = null;
    const deps = makeMockDeps({
      prisma: {
        ...makeMockDeps().prisma,
        agent: {
          ...makeMockDeps().prisma.agent,
          create: async (args: {
            data: { name: string; selfHosted?: boolean };
          }) => ({
            id: NEW_AGENT_ID,
            name: args.data.name,
            slackId: null,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          update: async (args: {
            where: { id: string };
            data: { repos: string[] };
          }) => {
            updateArgs = args;
            return {
              id: args.where.id,
              name: "My Local Agent",
              slackId: null,
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: args.data.repos,
            };
          },
        },
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "My Local Agent",
      repos: "my-org/repo-one\nmy-org/repo-two",
    });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${NEW_AGENT_ID}`);
    expect(updateArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(updateArgs).not.toBeNull() above
    expect(updateArgs!.data.repos).toContain("my-org/repo-one");
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(updateArgs).not.toBeNull() above
    expect(updateArgs!.data.repos).toContain("my-org/repo-two");
  });

  it("POST /admin/agents with missing name — returns non-200 or error response", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ name: "" });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    // Should not succeed — either redirect back with error or re-render form
    // Must not redirect to an agent detail page
    const location = res.headers.get("Location") ?? "";
    const isErrorResponse =
      res.status === 200 ||
      (res.status === 302 && !location.startsWith("/admin/agents/agent-"));
    expect(isErrorResponse).toBe(true);
  });

  it("POST /admin/agents with invalid repo format — deletes agent and redirects to error page", async () => {
    let deleteCalled = false;
    const deps = makeMockDeps({
      prisma: {
        ...makeMockDeps().prisma,
        agent: {
          ...makeMockDeps().prisma.agent,
          create: async (args: {
            data: { name: string; selfHosted?: boolean };
          }) => ({
            id: NEW_AGENT_ID,
            name: args.data.name,
            slackId: null,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          delete: async () => {
            deleteCalled = true;
            return {
              id: NEW_AGENT_ID,
              name: "My Local Agent",
              slackId: null,
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
            };
          },
        },
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "My Local Agent",
      repos: "not-valid-repo",
    });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/agents/new?error=invalid_repo_format",
    );
    expect(deleteCalled).toBe(true);
  });

  it("GET /admin/agents/new with error query param — renders error banner", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      "/admin/agents/new?error=invalid_repo_format",
      {
        headers: { Cookie: `admin_session=${adminCookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("alert-error");
    expect(html).toContain("Repo must be in org/repo format");
  });

  // ── /admin/agents list page has "New local agent" button ──────────────────

  it("GET /admin/agents — admin sees 'New local agent' button", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("New local agent");
    expect(html).toContain("/admin/agents/new");
  });

  it("GET /admin/agents — non-admin does NOT see 'New local agent' button", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${nonAdminCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("New local agent");
  });
});
