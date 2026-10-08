/**
 * admin/src/admin-ui-account-scope.smoke.test.ts
 *
 * SSP-6.8 — the admin UI's Tasks, PRs and Sessions views for account users.
 * Injected task-store fetchers emulate the task-store's admin-token
 * `?accountId=` narrowing over a fixture set spanning account A, account B
 * and the default account, so each test asserts both what renders and which
 * accountId the route forwarded.
 *
 *   - account user (flag on): only their account's rows; another account's
 *     task/PR/session id → 404; may rename/archive their own sessions
 *   - platform admin: every row, plus an Account column on the sessions list
 *   - caller with no account (flag off): Tasks/PRs stay admin-only (403)
 */

import { describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import type {
  AdminUIDeps,
  AdminUIGithubAppClient,
  AdminUISlackClient,
} from "./admin-ui.ts";
import { createAdminUIApp } from "./admin-ui.ts";
import type { PrListItem, TaskItem } from "./admin-ui-pages.ts";
import type { Session } from "./admin-ui-sessions-list.ts";
import type { CallerScopeResolver } from "./caller-scope.ts";
import type { GoogleAuthClient } from "./google-auth-client.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const ADMIN_ALLOWED_EMAILS = ["admin@example.com"];
const NEW_AGENT_ID = "agent-new-local-123";

const ADMIN = "admin@example.com";
const A_USER = "a-user@example.com";
const B_USER = "b-user@example.com";
const NO_ACCOUNT = "member@example.com";

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
      listShipwrightLoopJobs: async () => [],
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
      add: async (agentId: string, pattern: string) => ({
        id: "tool1",
        agentId,
        pattern,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
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
      add: async (agentId: string, name: string) => ({
        id: "plugin1",
        agentId,
        name,
        version: null,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    },
    agentPhaseMethodologyService: {
      list: async () => [],
      upsert: async (
        agentId: string,
        phase: string,
        subagentType: string | null,
      ) => ({
        id: "pm1",
        agentId,
        phase,
        subagentType,
        updatedAt: new Date(),
      }),
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

// ─── Two-account task-store fixture ──────────────────────────────────────────

const TASKS: (TaskItem & { accountId: string })[] = [
  {
    id: "A-1",
    title: "Alpha task in account A",
    status: "pending",
    repo: "org/shared",
    session: "sess-a",
    assignee: "agt-a",
    accountId: "acct-a",
  },
  {
    id: "B-1",
    title: "Bravo task in account B",
    status: "pending",
    repo: "org/shared",
    session: "sess-b",
    assignee: "agt-b",
    accountId: "acct-b",
  },
  {
    id: "D-1",
    title: "Delta task in default account",
    status: "pending",
    repo: "org/shared",
    session: "sess-d",
    accountId: "default",
  },
];

const PRS: (PrListItem & { accountId: string })[] = [
  {
    id: "pr-a",
    repo: "org/shared",
    prNumber: 101,
    staged: false,
    state: "open",
    reviewState: "pending",
    patchCycles: 0,
    reviewCycles: 0,
    accountId: "acct-a",
  },
  {
    id: "pr-b",
    repo: "org/shared",
    prNumber: 202,
    staged: false,
    state: "open",
    reviewState: "pending",
    patchCycles: 0,
    reviewCycles: 0,
    accountId: "acct-b",
  },
];

function session(
  slug: string,
  accountId: string,
  agentIds: string[],
): Session & { accountId: string } {
  return {
    slug,
    title: `Title of ${slug}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: "active",
    waitingSince: null,
    lastActivityAt: null,
    counts: { total: 1, open: 1, closed: 0 },
    agentIds,
    repos: ["org/shared"],
    waitingTasks: [],
    archived: false,
    accountId,
  };
}

const SESSIONS = [
  session("sess-a", "acct-a", ["agt-a"]),
  // B's session reuses A's agent id and repo: only accountId separates them.
  session("sess-b", "acct-b", ["agt-a"]),
  session("sess-d", "default", []),
];

const inAccount = <T extends { accountId: string }>(
  rows: T[],
  accountId: string | undefined,
): T[] =>
  accountId ? rows.filter((r) => r.accountId === accountId) : [...rows];

/** Records every accountId the routes forwarded, per fetcher. */
type Calls = Record<string, (string | undefined)[]>;

function twoAccountFetchers(calls: Calls): Partial<AdminUIDeps> {
  const note = (name: string, accountId: string | undefined) => {
    calls[name] ??= [];
    calls[name].push(accountId);
  };
  return {
    fetchTaskStoreTasks: async (params, accountId) => {
      note("fetchTaskStoreTasks", accountId);
      let rows = inAccount(TASKS, accountId);
      const s = params.get("session");
      if (s) rows = rows.filter((t) => t.session === s);
      return { tasks: rows, total: rows.length, limit: 50, offset: 0 };
    },
    fetchTaskStoreTask: async (id, accountId) => {
      note("fetchTaskStoreTask", accountId);
      return inAccount(TASKS, accountId).find((t) => t.id === id) ?? null;
    },
    releaseTask: async (id, accountId) => {
      note(`releaseTask:${id}`, accountId);
    },
    fetchDistinctTaskValues: async (accountId) => {
      note("fetchDistinctTaskValues", accountId);
      return { sessions: [], repos: [], orgs: [] };
    },
    fetchTaskStorePrs: async (_params, accountId) => {
      note("fetchTaskStorePrs", accountId);
      const rows = inAccount(PRS, accountId);
      return { prs: rows, total: rows.length, limit: 50, offset: 0 };
    },
    fetchTaskStorePrById: async (id, accountId) => {
      note("fetchTaskStorePrById", accountId);
      return inAccount(PRS, accountId).find((p) => p.id === id) ?? null;
    },
    fetchVerificationChecks: async (_params, accountId) => {
      note("fetchVerificationChecks", accountId);
      return { checks: [], total: 0, limit: 50, offset: 0 };
    },
    fetchTaskStoreSessions: async (_params, accountId) => {
      note("fetchTaskStoreSessions", accountId);
      const rows = inAccount(SESSIONS, accountId);
      return { sessions: rows, total: rows.length, limit: 50, offset: 0 };
    },
    fetchTaskStoreSession: async (slug, accountId) => {
      note("fetchTaskStoreSession", accountId);
      // Mirrors task-store: an admin token without ?accountId= addresses
      // the default account's slug.
      return (
        SESSIONS.find(
          (s) => s.slug === slug && s.accountId === (accountId ?? "default"),
        ) ?? null
      );
    },
    patchTaskStoreSession: async (slug, patch, accountId) => {
      note(`patchTaskStoreSession:${slug}`, accountId);
      const row = SESSIONS.find(
        (s) => s.slug === slug && s.accountId === (accountId ?? "default"),
      );
      return row ? { ...row, ...patch } : null;
    },
    fetchIsFollowingSession: async () => false,
  };
}

const callerScopeResolver: CallerScopeResolver = async (email, isAdmin) => {
  if (isAdmin) return { kind: "all" };
  if (email === A_USER)
    return { kind: "scoped", accountId: "acct-a", agentIds: ["agt-a"] };
  if (email === B_USER)
    return { kind: "scoped", accountId: "acct-b", agentIds: ["agt-b"] };
  // Flag off (or no account): AgentMember-only, accountId null.
  return { kind: "scoped", accountId: null, agentIds: ["agt-a"] };
};

function makeApp(calls: Calls = {}) {
  const followed: string[] = [];
  const deps = makeMockDeps({
    callerScopeResolver,
    ...twoAccountFetchers(calls),
  });
  // Minimal sessionFollow double so POST .../follow can succeed.
  (deps.prisma as unknown as Record<string, unknown>).sessionFollow = {
    upsert: async (args: { create: { sessionSlug: string } }) => {
      followed.push(args.create.sessionSlug);
      return {};
    },
    findMany: async () => [],
    deleteMany: async () => ({ count: 0 }),
  };
  return { app: createAdminUIApp(deps), followed };
}

async function get(
  app: ReturnType<typeof createAdminUIApp>,
  path: string,
  email: string,
): Promise<Response> {
  const cookie = await makeSessionCookie(email === ADMIN, email);
  return app.request(path, { headers: { Cookie: `admin_session=${cookie}` } });
}

async function post(
  app: ReturnType<typeof createAdminUIApp>,
  path: string,
  email: string,
  form?: Record<string, string>,
): Promise<Response> {
  const cookie = await makeSessionCookie(email === ADMIN, email);
  return app.request(path, {
    method: "POST",
    headers: {
      Cookie: `admin_session=${cookie}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

describe("SSP-6.8 — /admin/tasks scoped by account", () => {
  it("an account user sees only their account's tasks", async () => {
    const calls: Calls = {};
    const { app } = makeApp(calls);
    const res = await get(app, "/admin/tasks?view=table", A_USER);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Alpha task in account A");
    expect(body).not.toContain("Bravo task in account B");
    expect(body).not.toContain("Delta task in default account");
    expect(calls.fetchTaskStoreTasks).toEqual(["acct-a"]);
    expect(calls.fetchDistinctTaskValues).toEqual(["acct-a"]);
  });

  it("account B's view is the mirror image", async () => {
    const { app } = makeApp();
    const body = await (
      await get(app, "/admin/tasks?view=table", B_USER)
    ).text();
    expect(body).toContain("Bravo task in account B");
    expect(body).not.toContain("Alpha task in account A");
  });

  it("a platform admin still sees every account's tasks, unfiltered", async () => {
    const calls: Calls = {};
    const { app } = makeApp(calls);
    const body = await (
      await get(app, "/admin/tasks?view=table", ADMIN)
    ).text();
    expect(body).toContain("Alpha task in account A");
    expect(body).toContain("Bravo task in account B");
    expect(body).toContain("Delta task in default account");
    expect(calls.fetchTaskStoreTasks).toEqual([undefined]);
  });

  it("a caller with no account (flag off) still gets 403", async () => {
    const { app } = makeApp();
    expect((await get(app, "/admin/tasks", NO_ACCOUNT)).status).toBe(403);
    expect((await get(app, "/admin/tasks/A-1", NO_ACCOUNT)).status).toBe(403);
    expect(
      (await post(app, "/admin/tasks/A-1/release", NO_ACCOUNT)).status,
    ).toBe(403);
  });

  it("task detail: own task 200, another account's task 404", async () => {
    const { app } = makeApp();
    const own = await get(app, "/admin/tasks/A-1", A_USER);
    expect(own.status).toBe(200);
    expect(await own.text()).toContain("Alpha task in account A");
    expect((await get(app, "/admin/tasks/B-1", A_USER)).status).toBe(404);
    expect((await get(app, "/admin/tasks/D-1", A_USER)).status).toBe(404);
  });

  it("release: another account's task 404s without calling the task store", async () => {
    const calls: Calls = {};
    const { app } = makeApp(calls);
    const res = await post(app, "/admin/tasks/B-1/release", A_USER);
    expect(res.status).toBe(404);
    expect(calls["releaseTask:B-1"]).toBeUndefined();

    const own = await post(app, "/admin/tasks/A-1/release", A_USER);
    expect(own.status).toBe(302);
    expect(calls["releaseTask:A-1"]).toEqual(["acct-a"]);
  });
});

// ─── PRs ─────────────────────────────────────────────────────────────────────

describe("SSP-6.8 — /admin/prs scoped by account", () => {
  it("an account user sees only their account's PRs", async () => {
    const calls: Calls = {};
    const { app } = makeApp(calls);
    const res = await get(app, "/admin/prs", A_USER);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("#101");
    expect(body).not.toContain("#202");
    expect(calls.fetchTaskStorePrs?.every((a) => a === "acct-a")).toBe(true);
  });

  it("a platform admin sees every PR", async () => {
    const { app } = makeApp();
    const body = await (await get(app, "/admin/prs", ADMIN)).text();
    expect(body).toContain("#101");
    expect(body).toContain("#202");
  });

  it("PR detail: own PR 200, another account's PR 404", async () => {
    const { app } = makeApp();
    expect((await get(app, "/admin/prs/pr-a", A_USER)).status).toBe(200);
    expect((await get(app, "/admin/prs/pr-b", A_USER)).status).toBe(404);
  });

  it("a caller with no account still gets 403", async () => {
    const { app } = makeApp();
    expect((await get(app, "/admin/prs", NO_ACCOUNT)).status).toBe(403);
    expect((await get(app, "/admin/prs/pr-a", NO_ACCOUNT)).status).toBe(403);
  });
});

// ─── Sessions ────────────────────────────────────────────────────────────────

describe("SSP-6.8 — sessions scoped by account", () => {
  it("an account user's session list shows only their account's sessions", async () => {
    const calls: Calls = {};
    const { app } = makeApp(calls);
    const res = await get(app, "/admin/sessions", A_USER);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Title of sess-a");
    // sess-b shares agt-a with A, but lives in account B.
    expect(body).not.toContain("Title of sess-b");
    expect(body).not.toContain("Title of sess-d");
    expect(body).not.toContain("<th>Account</th>");
    expect(calls.fetchTaskStoreSessions?.every((a) => a === "acct-a")).toBe(
      true,
    );
  });

  it("a platform admin sees every session with an Account column", async () => {
    const { app } = makeApp();
    const body = await (await get(app, "/admin/sessions", ADMIN)).text();
    expect(body).toContain("<th>Account</th>");
    expect(body).toContain("Title of sess-a");
    expect(body).toContain("Title of sess-b");
    expect(body).toContain("Title of sess-d");
    expect(body).toContain("acct-b");
    // Non-default rows link to their own account's detail page.
    expect(body).toContain("/admin/sessions/sess-b?accountId=acct-b");
  });

  it("session detail: own session 200 with actions, another account's 404", async () => {
    const calls: Calls = {};
    const { app } = makeApp(calls);
    const own = await get(app, "/admin/sessions/sess-a", A_USER);
    expect(own.status).toBe(200);
    const body = await own.text();
    expect(body).toContain("/admin/sessions/sess-a/rename");
    expect(body).toContain("/admin/sessions/sess-a/archive");
    expect((await get(app, "/admin/sessions/sess-b", A_USER)).status).toBe(404);
    expect(calls.fetchTaskStoreTasks?.every((a) => a === "acct-a")).toBe(true);
  });

  it("an account user cannot widen their scope with ?accountId=", async () => {
    const calls: Calls = {};
    const { app } = makeApp(calls);
    const res = await get(
      app,
      "/admin/sessions/sess-b?accountId=acct-b",
      A_USER,
    );
    expect(res.status).toBe(404);
    expect(calls.fetchTaskStoreTasks).toEqual(["acct-a"]);
  });

  it("an account user can rename and archive their own session", async () => {
    const calls: Calls = {};
    const { app } = makeApp(calls);
    const rename = await post(app, "/admin/sessions/sess-a/rename", A_USER, {
      newTitle: "Renamed",
    });
    expect(rename.status).toBe(302);
    expect(rename.headers.get("location")).toContain("success=renamed");
    const archive = await post(app, "/admin/sessions/sess-a/archive", A_USER);
    expect(archive.status).toBe(302);
    expect(archive.headers.get("location")).toContain("success=archived");
    expect(calls["patchTaskStoreSession:sess-a"]).toEqual(["acct-a", "acct-a"]);
  });

  it("an account user cannot rename, archive or unarchive another account's session", async () => {
    const calls: Calls = {};
    const { app } = makeApp(calls);
    for (const action of ["rename", "archive", "unarchive"]) {
      const res = await post(app, `/admin/sessions/sess-b/${action}`, A_USER, {
        newTitle: "x",
      });
      expect(res.status).toBe(404);
    }
    // Every patch was pinned to A's account, never B's.
    expect(
      calls["patchTaskStoreSession:sess-b"]?.every((a) => a === "acct-a"),
    ).toBe(true);
  });

  it("session actions stay admin-only for a caller with no account", async () => {
    const { app } = makeApp();
    const res = await post(app, "/admin/sessions/sess-a/archive", NO_ACCOUNT);
    expect(res.status).toBe(403);
  });

  it("a platform admin acts on another account's session via ?accountId=", async () => {
    const calls: Calls = {};
    const { app } = makeApp(calls);
    const detail = await get(
      app,
      "/admin/sessions/sess-b?accountId=acct-b",
      ADMIN,
    );
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain(
      "/admin/sessions/sess-b/archive?accountId=acct-b",
    );
    const res = await post(
      app,
      "/admin/sessions/sess-b/archive?accountId=acct-b",
      ADMIN,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/admin/sessions/sess-b?accountId=acct-b&success=archived",
    );
    expect(calls["patchTaskStoreSession:sess-b"]).toEqual(["acct-b"]);
  });

  it("follow: own session 200, another account's 404", async () => {
    const { app, followed } = makeApp();
    expect(
      (await post(app, "/admin/sessions/sess-a/follow", A_USER)).status,
    ).toBe(200);
    expect(
      (await post(app, "/admin/sessions/sess-b/follow", A_USER)).status,
    ).toBe(404);
    expect(followed).toEqual(["sess-a"]);
  });
});

// ─── Agent detail verification rollup ────────────────────────────────────────

describe("SSP-6.8 — agent detail verification rollup scoped by account", () => {
  it("a non-admin's rollup reads only the agent's own account", async () => {
    const calls: Calls = {};
    const base = makeMockDeps();
    const detail = await base.agentService.getDetail(NEW_AGENT_ID);
    const deps = makeMockDeps({
      callerScopeResolver: async () => ({
        kind: "scoped",
        accountId: "acct-a",
        agentIds: ["agt-a"],
      }),
      ...twoAccountFetchers(calls),
      agentService: {
        ...base.agentService,
        getDetail: async () =>
          detail ? { ...detail, id: "agt-a", accountId: "acct-a" } : null,
      },
      agentCronRunService: {
        ...base.agentCronRunService,
        listForAgent: async () => ({
          items: [
            { itemType: "pr", itemId: "org/shared#101" },
          ] as unknown as Awaited<
            ReturnType<AdminUIDeps["agentCronRunService"]["listForAgent"]>
          >["items"],
          total: 1,
          limit: 20,
          offset: 0,
        }),
      },
    });
    const res = await get(
      createAdminUIApp(deps),
      "/admin/agents/agt-a",
      A_USER,
    );
    expect(res.status).toBe(200);
    expect(calls.fetchTaskStorePrs).toEqual(["acct-a"]);
    expect(calls.fetchVerificationChecks?.every((a) => a === "acct-a")).toBe(
      true,
    );
  });
});
