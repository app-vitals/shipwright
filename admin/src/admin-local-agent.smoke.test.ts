/**
 * admin/src/admin-local-agent.smoke.test.ts
 * Smoke tests for the "New agent" create flow (/admin/agents/new).
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
          agentId: NEW_AGENT_ID,
          email: "admin@example.com",
        }),
        deleteMany: async () => ({ count: 0 }),
      },
    },
    agentEnvService: {
      getByAgentId: async () => ({ env: {}, secretKeys: [] }),
      upsert: async () => {},
      patch: async () => {},
      deleteKey: async () => {},
      getConfigBundle: async () => null,
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
    agentWorkQueueService: {
      get: async () => null,
      getMany: async () => [],
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
    agentMemberService: {
      listByEmail: async () => [],
      exists: async () => false,
      add: async (agentId: string, email: string) => ({
        id: "m1",
        agentId,
        email,
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
      create: async () => ({
        id: NEW_AGENT_ID,
        name: "New Local Agent",
        slackId: null,
        selfHosted: true,
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
        id: NEW_AGENT_ID,
        name: "New Local Agent",
        slackId: null,
        selfHosted: true,
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        missingRequiredEnv: [],
      }),
      updateFields: async () => ({
        id: NEW_AGENT_ID,
        name: "New Local Agent",
        slackId: null,
        selfHosted: true,
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        missingRequiredEnv: [],
      }),
    },
    sessionSecret: SESSION_SECRET,
    googleClientId: "test-google-client-id",
    googleClientSecret: "test-google-client-secret",
    adminAllowedEmails: ADMIN_ALLOWED_EMAILS,
    googleClient: makeGoogleClient(),
    slackClient: BASE_SLACK_CLIENT,
    githubAppClient: BASE_GITHUB_APP_CLIENT,
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
    expect(html).toContain("New Agent");
  });

  it("GET /admin/agents/new — renders a required type select listing the registry's built-in types", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents/new", {
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<select[^>]*name="type"[^>]*required/);
    expect(html).toContain('<option value="coding">Coding Agent</option>');
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
    let createdArgs: { name: string; selfHosted?: boolean } | null = null;
    const deps = makeMockDeps({
      agentService: {
        ...makeMockDeps().agentService,
        create: async (input: { name: string; selfHosted?: boolean }) => {
          createdArgs = input;
          return {
            id: NEW_AGENT_ID,
            name: input.name,
            slackId: null,
            selfHosted: input.selfHosted ?? false,
            repos: [],
            reviewAuthorAllowlist: [],
            patchAuthorAllowlist: [],
            restrictSlackToMembers: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            missingRequiredEnv: [],
          };
        },
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "My Local Agent",
      type: "coding",
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
    expect(createdArgs).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(createdArgs).not.toBeNull() above
    expect(createdArgs!.selfHosted).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(createdArgs).not.toBeNull() above
    expect(createdArgs!.name).toBe("My Local Agent");
  });

  it("POST /admin/agents — non-admin session returns 403", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({
      name: "My Local Agent",
      type: "coding",
    });
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
    let updateArgs: { id: string; repos: string[] } | null = null;
    const deps = makeMockDeps({
      agentService: {
        ...makeMockDeps().agentService,
        create: async (input: { name: string; selfHosted?: boolean }) => ({
          id: NEW_AGENT_ID,
          name: input.name,
          slackId: null,
          selfHosted: input.selfHosted ?? false,
          repos: [],
          reviewAuthorAllowlist: [],
          patchAuthorAllowlist: [],
          restrictSlackToMembers: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          missingRequiredEnv: [],
        }),
        updateFields: async (id: string, input: { repos?: string[] }) => {
          updateArgs = { id, repos: input.repos ?? [] };
          return {
            id,
            name: "My Local Agent",
            slackId: null,
            selfHosted: true,
            repos: input.repos ?? [],
            reviewAuthorAllowlist: [],
            patchAuthorAllowlist: [],
            restrictSlackToMembers: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            missingRequiredEnv: [],
          };
        },
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "My Local Agent",
      type: "coding",
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
    expect(updateArgs!.repos).toContain("my-org/repo-one");
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect(updateArgs).not.toBeNull() above
    expect(updateArgs!.repos).toContain("my-org/repo-two");
  });

  // ── UAP-5.2: inline member-email textarea for restrictSlackToMembers ──────

  it("POST /admin/agents with restrictSlackToMembers=true and memberEmails — creates an AgentMember row for each email", async () => {
    const addCalls: Array<{ agentId: string; email: string }> = [];
    const deps = makeMockDeps({
      agentMemberService: {
        ...makeMockDeps().agentMemberService,
        add: async (agentId: string, email: string) => {
          addCalls.push({ agentId, email });
          return { id: "m1", agentId, email, createdAt: new Date() };
        },
        listByAgentId: async () =>
          addCalls.map((c) => ({
            id: "m1",
            agentId: c.agentId,
            email: c.email,
            createdAt: new Date(),
          })),
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "My Local Agent",
      type: "coding",
      restrictSlackToMembers: "true",
      memberEmails: "a@example.com\nb@example.com",
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
    expect(addCalls.map((c) => c.email)).toContain("a@example.com");
    expect(addCalls.map((c) => c.email)).toContain("b@example.com");
    expect(addCalls.length).toBe(2);
    // Members were created before redirectWithMembersWarning ran, so no
    // zero-members warning should be appended.
    expect(res.headers.get("Location")).toBe(`/admin/agents/${NEW_AGENT_ID}`);
  });

  it("POST /admin/agents with duplicate memberEmails (or agentMemberService.add throwing) does not 500 — still 302 redirects", async () => {
    const deps = makeMockDeps({
      agentMemberService: {
        ...makeMockDeps().agentMemberService,
        add: async () => {
          throw new Error("unique constraint violation");
        },
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "My Local Agent",
      type: "coding",
      restrictSlackToMembers: "true",
      memberEmails: "dup@example.com\ndup@example.com",
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
    expect(res.headers.get("Location")).toStartWith(
      `/admin/agents/${NEW_AGENT_ID}`,
    );
  });

  it("POST /admin/agents with restrictSlackToMembers=true and an empty memberEmails textarea — still creates the agent, no regression to the zero-members warning", async () => {
    const deps = makeMockDeps({
      agentMemberService: {
        ...makeMockDeps().agentMemberService,
        listByAgentId: async () => [],
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "My Local Agent",
      type: "coding",
      restrictSlackToMembers: "true",
      memberEmails: "",
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
      `/admin/agents/${NEW_AGENT_ID}?warning=restrict_slack_no_members`,
    );
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

  it("POST /admin/agents with missing type — redirects with error, no agent created", async () => {
    let createCalled = false;
    const deps = makeMockDeps({
      agentService: {
        ...makeMockDeps().agentService,
        create: async (input: { name: string; selfHosted?: boolean }) => {
          createCalled = true;
          return {
            id: NEW_AGENT_ID,
            name: input.name,
            slackId: null,
            selfHosted: input.selfHosted ?? false,
            repos: [],
            reviewAuthorAllowlist: [],
            patchAuthorAllowlist: [],
            restrictSlackToMembers: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            missingRequiredEnv: [],
          };
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
    expect(res.headers.get("Location")).toBe(
      "/admin/agents/new?error=invalid_type",
    );
    expect(createCalled).toBe(false);
  });

  it("POST /admin/agents with a bogus type — redirects with error, no agent created", async () => {
    let createCalled = false;
    const deps = makeMockDeps({
      agentService: {
        ...makeMockDeps().agentService,
        create: async (input: { name: string; selfHosted?: boolean }) => {
          createCalled = true;
          return {
            id: NEW_AGENT_ID,
            name: input.name,
            slackId: null,
            selfHosted: input.selfHosted ?? false,
            repos: [],
            reviewAuthorAllowlist: [],
            patchAuthorAllowlist: [],
            restrictSlackToMembers: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            missingRequiredEnv: [],
          };
        },
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "My Local Agent",
      type: "not-a-real-type",
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
      "/admin/agents/new?error=invalid_type",
    );
    expect(createCalled).toBe(false);
  });

  it("POST /admin/agents with invalid repo format — deletes agent and redirects to error page", async () => {
    let deleteCalled = false;
    const deps = makeMockDeps({
      agentService: {
        ...makeMockDeps().agentService,
        create: async (input: { name: string; selfHosted?: boolean }) => ({
          id: NEW_AGENT_ID,
          name: input.name,
          slackId: null,
          selfHosted: input.selfHosted ?? false,
          repos: [],
          reviewAuthorAllowlist: [],
          patchAuthorAllowlist: [],
          restrictSlackToMembers: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          missingRequiredEnv: [],
        }),
        delete: async () => {
          deleteCalled = true;
        },
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "My Local Agent",
      type: "coding",
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

  // ── /admin/agents list page has the primary "New agent" button ────────────

  it("GET /admin/agents — admin sees the '+ New agent' button linking to /admin/agents/new", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("+ New agent");
    expect(html).toContain("/admin/agents/new");
  });

  it("GET /admin/agents — non-admin does NOT see the '+ New agent' button", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${nonAdminCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("+ New agent");
  });

  // ── runtime=in-cluster (Slack-free provisioning) ──────────────────────────

  /**
   * Builds deps with a recording provisioner / cron service / env service so a
   * test can assert exactly what the create path did. `canProvision` defaults
   * to true because these cases exercise the in-cluster branch.
   */
  function makeProvisioningDeps(opts?: {
    canProvision?: boolean;
    provisionError?: Error;
    reconcileError?: Error;
    deleteError?: Error;
  }) {
    const calls = {
      created: null as { name: string; selfHosted?: boolean } | null,
      provisioned: [] as Array<{ id: string; slug?: string }>,
      reconciled: [] as string[],
      deleted: [] as string[],
      envPatches: [] as Array<{
        agentId: string;
        env: Record<string, string>;
        secretKeys: Set<string> | undefined;
      }>,
    };
    const base = makeMockDeps();
    const deps = makeMockDeps({
      agentService: {
        ...base.agentService,
        create: async (input: { name: string; selfHosted?: boolean }) => {
          calls.created = input;
          return {
            id: NEW_AGENT_ID,
            name: input.name,
            slackId: null,
            selfHosted: input.selfHosted ?? false,
            repos: [],
            reviewAuthorAllowlist: [],
            patchAuthorAllowlist: [],
            restrictSlackToMembers: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            missingRequiredEnv: [],
          };
        },
        delete: async (id: string) => {
          calls.deleted.push(id);
          if (opts?.deleteError) throw opts.deleteError;
        },
      },
      agentEnvService: {
        ...base.agentEnvService,
        patch: async (
          agentId: string,
          env: Record<string, string>,
          secretKeys?: Set<string>,
        ) => {
          calls.envPatches.push({ agentId, env, secretKeys });
        },
      },
      agentCronJobService: {
        ...base.agentCronJobService,
        reconcileSystemCrons: async (agentId: string) => {
          calls.reconciled.push(agentId);
          if (opts?.reconcileError) throw opts.reconcileError;
          return { created: 3, updated: 0, deleted: 0 };
        },
      },
      provisioner: {
        ...base.provisioner,
        canProvision: opts?.canProvision ?? true,
        provision: async (id: string, o?: { slug?: string }) => {
          calls.provisioned.push({ id, slug: o?.slug });
          if (opts?.provisionError) throw opts.provisionError;
          return {
            resourceName: "r",
            secretName: "s",
            deploymentName: "d",
          };
        },
      },
    });
    return { deps, calls };
  }

  async function postAgent(
    deps: AdminUIDeps,
    fields: Record<string, string>,
  ): Promise<Response> {
    return createAdminUIApp(deps).request("/admin/agents", {
      method: "POST",
      body: new URLSearchParams(fields).toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
  }

  it("runtime=in-cluster creates a non-self-hosted agent, provisions it, and seeds system crons", async () => {
    const { deps, calls } = makeProvisioningDeps();
    const res = await postAgent(deps, {
      name: "minikube-agent",
      type: "coding",
      runtime: "in-cluster",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${NEW_AGENT_ID}`);
    expect(calls.created?.selfHosted).toBe(false);
    expect(calls.provisioned).toEqual([
      { id: NEW_AGENT_ID, slug: "minikube-agent" },
    ]);
    expect(calls.reconciled).toEqual([NEW_AGENT_ID]);
    expect(calls.deleted).toEqual([]);
  });

  it("runtime=self-hosted keeps the historical behavior — selfHosted:true, provisioner untouched", async () => {
    const { deps, calls } = makeProvisioningDeps();
    const res = await postAgent(deps, {
      name: "docker-agent",
      type: "coding",
      runtime: "self-hosted",
    });
    expect(res.status).toBe(302);
    expect(calls.created?.selfHosted).toBe(true);
    expect(calls.provisioned).toEqual([]);
  });

  it("omitted runtime defaults to self-hosted", async () => {
    const { deps, calls } = makeProvisioningDeps();
    await postAgent(deps, { name: "no-runtime-field", type: "coding" });
    expect(calls.created?.selfHosted).toBe(true);
    expect(calls.provisioned).toEqual([]);
  });

  it("runtime=in-cluster is rejected before any row is created when provisioning is disabled", async () => {
    const { deps, calls } = makeProvisioningDeps({ canProvision: false });
    const res = await postAgent(deps, {
      name: "nope",
      type: "coding",
      runtime: "in-cluster",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/agents/new?error=provisioning_disabled",
    );
    expect(calls.created).toBeNull();
    expect(calls.provisioned).toEqual([]);
  });

  it("provisioning failure rolls the agent row back and redirects with provision_failed", async () => {
    const { deps, calls } = makeProvisioningDeps({
      provisionError: new Error("no cluster"),
    });
    const res = await postAgent(deps, {
      name: "doomed",
      type: "coding",
      runtime: "in-cluster",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/agents/new?error=provision_failed",
    );
    expect(calls.deleted).toEqual([NEW_AGENT_ID]);
    expect(calls.reconciled).toEqual([]);
  });

  it("provisioning failure still redirects with provision_failed even when the rollback delete itself fails", async () => {
    const { deps, calls } = makeProvisioningDeps({
      provisionError: new Error("no cluster"),
      deleteError: new Error("db unreachable"),
    });
    const res = await postAgent(deps, {
      name: "doubly-doomed",
      type: "coding",
      runtime: "in-cluster",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/agents/new?error=provision_failed",
    );
    // The rollback was attempted (and failed) but the create flow still
    // reports provision_failed rather than throwing — the cleanup error is
    // swallowed (logged), not propagated.
    expect(calls.deleted).toEqual([NEW_AGENT_ID]);
    expect(calls.reconciled).toEqual([]);
  });

  it("a cron-seeding failure is non-fatal — the agent survives and the redirect succeeds", async () => {
    const { deps, calls } = makeProvisioningDeps({
      reconcileError: new Error("db down"),
    });
    const res = await postAgent(deps, {
      name: "crons-broke",
      type: "coding",
      runtime: "in-cluster",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${NEW_AGENT_ID}`);
    expect(calls.deleted).toEqual([]);
  });

  it("a supplied Claude token is stored as a secret env var before provisioning", async () => {
    const { deps, calls } = makeProvisioningDeps();
    await postAgent(deps, {
      name: "with-creds",
      type: "coding",
      runtime: "in-cluster",
      claudeCodeOauthToken: "sk-ant-oat01-example",
    });
    expect(calls.envPatches).toHaveLength(1);
    const patch = calls.envPatches[0];
    expect(patch?.agentId).toBe(NEW_AGENT_ID);
    expect(patch?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-example");
    expect(patch?.secretKeys?.has("CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
  });

  it("no Claude token supplied → no env patch at all", async () => {
    const { deps, calls } = makeProvisioningDeps();
    await postAgent(deps, {
      name: "no-creds",
      type: "coding",
      runtime: "in-cluster",
    });
    expect(calls.envPatches).toEqual([]);
  });

  // ── UAP-2.1: unified create page — Anthropic key, Connect Slack, GitHub auth ──

  it("a supplied Anthropic API key is stored as a secret env var alongside the Claude token in a single patch", async () => {
    const { deps, calls } = makeProvisioningDeps();
    await postAgent(deps, {
      name: "with-anthropic-key",
      type: "coding",
      claudeCodeOauthToken: "sk-ant-oat01-example",
      anthropicApiKey: "sk-ant-api03-example",
    });
    expect(calls.envPatches).toHaveLength(1);
    const patch = calls.envPatches[0];
    expect(patch?.agentId).toBe(NEW_AGENT_ID);
    expect(patch?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-example");
    expect(patch?.env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-example");
    expect(patch?.secretKeys?.has("ANTHROPIC_API_KEY")).toBe(true);
  });

  it("an Anthropic API key alone (no Claude token) is still patched", async () => {
    const { deps, calls } = makeProvisioningDeps();
    await postAgent(deps, {
      name: "anthropic-only",
      type: "coding",
      anthropicApiKey: "sk-ant-api03-only",
    });
    expect(calls.envPatches).toHaveLength(1);
    expect(calls.envPatches[0]?.env.ANTHROPIC_API_KEY).toBe(
      "sk-ant-api03-only",
    );
  });

  it("all-skipped baseline — no Slack/GitHub/Anthropic fields — redirects to detail page exactly as before (regression guard)", async () => {
    const { deps, calls } = makeProvisioningDeps();
    const res = await postAgent(deps, {
      name: "plain-agent",
      type: "coding",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${NEW_AGENT_ID}`);
    expect(calls.envPatches).toEqual([]);
  });

  it("Connect Slack checked redirects into the Slack OAuth URL for the newly created agent", async () => {
    const base = makeMockDeps();
    const deps = makeMockDeps({
      agentService: {
        ...base.agentService,
        create: async (input: { name: string; selfHosted?: boolean }) => ({
          id: NEW_AGENT_ID,
          name: input.name,
          slackId: null,
          selfHosted: input.selfHosted ?? false,
          repos: [],
          reviewAuthorAllowlist: [],
          patchAuthorAllowlist: [],
          restrictSlackToMembers: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          missingRequiredEnv: [],
        }),
      },
      provisioner: { ...base.provisioner, canProvision: true },
    });
    const res = await postAgent(deps, {
      name: "slack-agent",
      type: "coding",
      runtime: "in-cluster",
      connectSlack: "true",
      xoxpToken: "xoxe.xoxp-test-token",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("slack.com/oauth/authorize");
    // Cookie carrying provision state must be set for the OAuth callback.
    expect(res.headers.get("Set-Cookie") ?? "").toContain(
      "slack_provision_state=",
    );
  });

  it("Connect Slack with a bad/missing token redirects to the agent detail page with an error, not the New Agent form", async () => {
    const base = makeMockDeps();
    const deps = makeMockDeps({
      provisioner: { ...base.provisioner, canProvision: true },
    });
    const res = await postAgent(deps, {
      name: "slack-bad-token",
      type: "coding",
      runtime: "in-cluster",
      connectSlack: "true",
      xoxpToken: "not-a-valid-token",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toStartWith(`/admin/agents/${NEW_AGENT_ID}?error=`);
  });

  it("GitHub App requested renders the manifest auto-submit redirect flow for the newly created agent", async () => {
    const base = makeMockDeps();
    const deps = makeMockDeps({
      provisioner: { ...base.provisioner, canProvision: true },
    });
    const res = await postAgent(deps, {
      name: "gh-app-agent",
      type: "coding",
      runtime: "in-cluster",
      ghAuthMode: "app",
      githubOrg: "my-org",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("github.com/organizations/my-org/settings/apps/new");
    expect(res.headers.get("Set-Cookie") ?? "").toContain(
      "github_provision_state=",
    );
  });

  it("GitHub App with an invalid org name redirects to the agent detail page with an error — agent is NOT rolled back", async () => {
    const { deps, calls } = makeProvisioningDeps();
    const res = await postAgent(deps, {
      name: "gh-app-bad-org",
      type: "coding",
      runtime: "in-cluster",
      ghAuthMode: "app",
      githubOrg: "not a valid org!!",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toStartWith(`/admin/agents/${NEW_AGENT_ID}?error=`);
    expect(calls.deleted).toEqual([]);
  });

  it("GitHub PAT provided stores GH_TOKEN directly and continues to the detail page", async () => {
    const { deps, calls } = makeProvisioningDeps();
    const res = await postAgent(deps, {
      name: "gh-pat-agent",
      type: "coding",
      runtime: "in-cluster",
      ghAuthMode: "pat",
      ghPat: "ghp_exampletoken",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${NEW_AGENT_ID}`);
    const patch = calls.envPatches.find((p) => p.env.GH_TOKEN);
    expect(patch).toBeDefined();
    expect(patch?.env.GH_TOKEN).toBe("ghp_exampletoken");
    expect(patch?.secretKeys?.has("GH_TOKEN")).toBe(true);
  });

  it("GitHub PAT mode with no token supplied redirects to the detail page with an error — agent is NOT rolled back", async () => {
    const { deps, calls } = makeProvisioningDeps();
    const res = await postAgent(deps, {
      name: "gh-pat-missing",
      type: "coding",
      runtime: "in-cluster",
      ghAuthMode: "pat",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toStartWith(`/admin/agents/${NEW_AGENT_ID}?error=`);
    expect(calls.deleted).toEqual([]);
  });

  // ── UAP-5.3: ghAuthMode=app + ghAppMode=manual ("Use existing GitHub App") ──

  it("ghAuthMode=app&ghAppMode=manual with a valid App ID/Installation ID/uploaded PEM file persists GH_APP_ID/GH_APP_INSTALLATION_ID/GH_APP_PRIVATE_KEY and redirects to the agent detail page", async () => {
    const { deps, calls } = makeProvisioningDeps();
    const pemContents =
      "-----BEGIN RSA PRIVATE KEY-----\nfaketestkeydata\n-----END RSA PRIVATE KEY-----";
    const form = new FormData();
    form.append("name", "gh-app-manual-agent");
    form.append("type", "coding");
    form.append("runtime", "in-cluster");
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

    const res = await createAdminUIApp(deps).request("/admin/agents", {
      method: "POST",
      body: form,
      headers: { Cookie: `admin_session=${adminCookie}` },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${NEW_AGENT_ID}`);
    const ghAppIdPatch = calls.envPatches.find((p) => p.env.GH_APP_ID);
    expect(ghAppIdPatch?.env.GH_APP_ID).toBe("12345");
    const ghAppInstallationIdPatch = calls.envPatches.find(
      (p) => p.env.GH_APP_INSTALLATION_ID,
    );
    expect(ghAppInstallationIdPatch?.env.GH_APP_INSTALLATION_ID).toBe("67890");
    const ghAppPrivateKeyPatch = calls.envPatches.find(
      (p) => p.env.GH_APP_PRIVATE_KEY,
    );
    expect(ghAppPrivateKeyPatch?.env.GH_APP_PRIVATE_KEY).toBe(pemContents);
  });

  it("ghAuthMode=app&ghAppMode=manual with a missing/invalid App ID redirects to the detail page with an error — agent is NOT rolled back", async () => {
    const { deps, calls } = makeProvisioningDeps();
    const form = new FormData();
    form.append("name", "gh-app-manual-bad-id");
    form.append("type", "coding");
    form.append("runtime", "in-cluster");
    form.append("ghAuthMode", "app");
    form.append("ghAppMode", "manual");
    form.append("ghAppInstallationId", "67890");
    form.append(
      "ghAppPrivateKeyFile",
      new File(
        ["-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----"],
        "private-key.pem",
      ),
    );

    const res = await createAdminUIApp(deps).request("/admin/agents", {
      method: "POST",
      body: form,
      headers: { Cookie: `admin_session=${adminCookie}` },
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toStartWith(`/admin/agents/${NEW_AGENT_ID}?error=`);
    expect(calls.deleted).toEqual([]);
    expect(calls.envPatches.find((p) => p.env.GH_APP_ID)).toBeUndefined();
  });

  it("ghAuthMode=app with ghAppMode omitted still runs the auto/manifest flow — no regression to the default", async () => {
    const base = makeMockDeps();
    const deps = makeMockDeps({
      provisioner: { ...base.provisioner, canProvision: true },
    });
    const res = await postAgent(deps, {
      name: "gh-app-default-auto",
      type: "coding",
      runtime: "in-cluster",
      ghAuthMode: "app",
      githubOrg: "my-org",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("github.com/organizations/my-org/settings/apps/new");
  });

  it("ghAuthMode=skip (or omitted) with connectSlack unchecked behaves exactly like today — plain redirect to detail page", async () => {
    const { deps, calls } = makeProvisioningDeps();
    const res = await postAgent(deps, {
      name: "gh-skip-agent",
      type: "coding",
      runtime: "in-cluster",
      ghAuthMode: "skip",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${NEW_AGENT_ID}`);
    expect(calls.envPatches).toEqual([]);
  });

  it("both Connect Slack and GitHub PAT requested — GitHub PAT is stored first, then Slack's OAuth redirect is returned", async () => {
    const { deps, calls } = makeProvisioningDeps();
    const res = await postAgent(deps, {
      name: "slack-and-gh-pat",
      type: "coding",
      runtime: "in-cluster",
      connectSlack: "true",
      xoxpToken: "xoxe.xoxp-test-token",
      ghAuthMode: "pat",
      ghPat: "ghp_bothflow",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("slack.com/oauth/authorize");
    const patch = calls.envPatches.find((p) => p.env.GH_TOKEN);
    expect(patch?.env.GH_TOKEN).toBe("ghp_bothflow");
  });

  it("both Connect Slack and GitHub PAT requested — GitHub PAT storage fails while Slack succeeds: Slack redirect is preserved and the failure is carried through the signed provision-state cookie", async () => {
    const { deps, calls } = makeProvisioningDeps();
    // Omitting ghPat makes startPatConnect() return ok:false
    // ("GitHub Personal Access Token is required.") — the same failure path a
    // rejected PAT storage would take. connectSlack=true means the handler
    // must NOT early-redirect on that failure; it continues into Slack's OAuth
    // flow, but the GitHub failure must be surfaced rather than swallowed.
    const res = await postAgent(deps, {
      name: "slack-ok-gh-pat-fail",
      type: "coding",
      runtime: "in-cluster",
      connectSlack: "true",
      xoxpToken: "xoxe.xoxp-test-token",
      ghAuthMode: "pat",
      // no ghPat → startPatConnect fails
    });

    // Existing behavior preserved: still redirects into Slack's OAuth flow.
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("slack.com/oauth/authorize");

    // GH_TOKEN was never stored.
    expect(calls.envPatches.find((p) => p.env.GH_TOKEN)).toBeUndefined();

    // The failure is carried through Slack's OAuth round trip via the signed
    // provision-state cookie so the post-callback landing can surface it —
    // rather than being silently console.error'd and swallowed.
    const setCookieHeader = res.headers.get("Set-Cookie") ?? "";
    expect(setCookieHeader).toContain("slack_provision_state=");
    const match = setCookieHeader.match(/slack_provision_state=([^;]+)/);
    expect(match).toBeTruthy();
    const jwtToken = decodeURIComponent(match?.[1] ?? "");
    const parts = jwtToken.split(".");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(
      Buffer.from(parts[1] ?? "", "base64url").toString("utf-8"),
    );
    expect(payload.ghConnectError).toBe(
      "GitHub Personal Access Token is required.",
    );
  });

  // ── UAP-5.1: runtime=self-hosted must never trigger Slack/GitHub provisioning ──

  it("runtime=self-hosted with connectSlack=true performs no Slack provisioning — plain redirect, no OAuth redirect, no env writes", async () => {
    const { deps, calls } = makeProvisioningDeps();
    const res = await postAgent(deps, {
      name: "self-hosted-slack",
      type: "coding",
      runtime: "self-hosted",
      connectSlack: "true",
      xoxpToken: "xoxe.xoxp-test-token",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${NEW_AGENT_ID}`);
    const location = res.headers.get("Location") ?? "";
    expect(location).not.toContain("slack.com/oauth/authorize");
    expect(res.headers.get("Set-Cookie") ?? "").not.toContain(
      "slack_provision_state=",
    );
    expect(calls.envPatches).toEqual([]);
    expect(calls.provisioned).toEqual([]);
  });

  it("runtime=self-hosted with ghAuthMode=app performs no GitHub App provisioning — plain redirect, no manifest page, no cookie", async () => {
    const { deps, calls } = makeProvisioningDeps();
    const res = await postAgent(deps, {
      name: "self-hosted-gh-app",
      type: "coding",
      runtime: "self-hosted",
      ghAuthMode: "app",
      githubOrg: "my-org",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${NEW_AGENT_ID}`);
    expect(res.headers.get("Set-Cookie") ?? "").not.toContain(
      "github_provision_state=",
    );
    expect(calls.envPatches).toEqual([]);
  });

  it("runtime=self-hosted with ghAuthMode=pat performs no GH_TOKEN write", async () => {
    const { deps, calls } = makeProvisioningDeps();
    const res = await postAgent(deps, {
      name: "self-hosted-gh-pat",
      type: "coding",
      runtime: "self-hosted",
      ghAuthMode: "pat",
      ghPat: "ghp_shouldnotbestored",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${NEW_AGENT_ID}`);
    expect(calls.envPatches.find((p) => p.env.GH_TOKEN)).toBeUndefined();
    expect(calls.envPatches).toEqual([]);
  });

  it("runtime=self-hosted with both connectSlack=true and ghAuthMode=app set (raw POST bypassing the UI) performs no provisioning of either kind", async () => {
    const { deps, calls } = makeProvisioningDeps();
    const res = await postAgent(deps, {
      name: "self-hosted-both",
      type: "coding",
      runtime: "self-hosted",
      connectSlack: "true",
      xoxpToken: "xoxe.xoxp-test-token",
      ghAuthMode: "app",
      githubOrg: "my-org",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${NEW_AGENT_ID}`);
    const location = res.headers.get("Location") ?? "";
    expect(location).not.toContain("slack.com/oauth/authorize");
    expect(res.headers.get("Set-Cookie") ?? "").not.toContain(
      "slack_provision_state=",
    );
    expect(res.headers.get("Set-Cookie") ?? "").not.toContain(
      "github_provision_state=",
    );
    expect(calls.envPatches).toEqual([]);
    expect(calls.created?.selfHosted).toBe(true);
    expect(calls.provisioned).toEqual([]);
  });
});
