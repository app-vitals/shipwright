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
    },
    agentWorkQueueService: {
      get: async () => null,
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
        authorAllowlist: [],
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
        authorAllowlist: [],
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
        authorAllowlist: [],
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
            authorAllowlist: [],
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
          authorAllowlist: [],
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
            authorAllowlist: [],
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
            authorAllowlist: [],
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
            authorAllowlist: [],
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
          authorAllowlist: [],
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
            authorAllowlist: [],
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
});
