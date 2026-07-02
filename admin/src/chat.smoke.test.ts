/**
 * admin/src/chat.smoke.test.ts
 * Smoke tests for the Admin Chat UI routes.
 *
 * Uses app.request() — no real server, no real network calls.
 * ChatClient is injected as an in-memory test double.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import type { ChatClient, ChatMessage, ChatThread } from "./http-chat-client.ts";
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
const ADMIN_ALLOWED_EMAILS = ["admin@example.com"];
const AGENT_ID = "agent-test-chat-123";
const THREAD_ID = "thread-test-456";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_THREAD: ChatThread = {
  id: THREAD_ID,
  agentId: AGENT_ID,
  title: "Test Thread",
  memberId: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const MOCK_MESSAGE: ChatMessage = {
  id: "msg-test-789",
  threadId: THREAD_ID,
  role: "user",
  body: "Hello, agent!",
  createdAt: "2024-01-01T00:00:00.000Z",
  claimedBy: null,
  repliedAt: null,
  tokens: null,
  costUsd: null,
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

// ─── Mock ChatClient ──────────────────────────────────────────────────────────

function makeMockChatClient(overrides?: Partial<ChatClient>): ChatClient {
  return {
    listThreads: async () => ({
      threads: [MOCK_THREAD],
      total: 1,
      limit: 50,
      offset: 0,
    }),
    getThread: async () => MOCK_THREAD,
    createThread: async () => MOCK_THREAD,
    updateThread: async (_id: string, data: { title?: string }) => ({
      ...MOCK_THREAD,
      title: data.title ?? MOCK_THREAD.title,
    }),
    deleteThread: async () => {},
    listMessages: async () => ({
      messages: [MOCK_MESSAGE],
      total: 1,
      limit: 50,
      offset: 0,
    }),
    createMessage: async () => MOCK_MESSAGE,
    ...overrides,
  };
}

// ─── Mock Google client ───────────────────────────────────────────────────────

function makeGoogleClient(): GoogleAuthClient {
  return {
    exchangeCode: () =>
      Promise.resolve({
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresIn: 3600,
      } as GoogleTokenResponse),
    getUserInfo: () =>
      Promise.resolve({
        sub: "google-sub-123",
        email: "admin@example.com",
        email_verified: true,
        name: "Admin User",
      } as GoogleUserInfo),
  };
}

const MOCK_CRON = {
  id: "cron-1",
  agentId: AGENT_ID,
  schedule: "0 * * * *",
  prompt: "check",
  channel: null,
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
  id: "tool-1",
  agentId: AGENT_ID,
  pattern: "Bash(git:*)",
  enabled: true,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const MOCK_TOKEN = {
  id: "token-1",
  agentId: AGENT_ID,
  token: "hashed",
  label: "CI",
  createdAt: new Date("2024-01-01"),
  revokedAt: null,
};

// ─── Shared base deps factory ─────────────────────────────────────────────────

const BASE_SLACK_CLIENT: AdminUISlackClient = {
  createAppManifest: async () => ({
    appId: "A123",
    oauthRedirectUrl: "https://slack.com/oauth",
    clientId: "cid",
    clientSecret: "csecret",
    signingSecret: "ssecret",
  }),
  updateAppManifest: async () => {},
  exchangeOAuthCode: async () => ({ botToken: "xoxb-mock" }),
};

function makeBaseDeps(overrides?: Partial<AdminUIDeps>): AdminUIDeps {
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
          selfHosted: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        update: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: null,
          selfHosted: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
        }),
        delete: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
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
        create: async () => ({ id: "m1", agentId: AGENT_ID, email: "x@x.com" }),
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
      reconcileSystemCrons: async () => ({ created: 0, updated: 0, deleted: 0 }),
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
      create: async () => ({ token: MOCK_TOKEN, rawToken: "sw_raw123" }),
      revoke: async () => MOCK_TOKEN,
    },
    agentPluginService: { list: async () => [] },
    provisioner: {
      provision: async () => ({
        resourceName: "r",
        secretName: "s",
        deploymentName: "d",
      }),
      deprovision: async () => {},
      reconcile: async () => ({
        recreated: [],
        orphans: [],
        failed: [],
        updated: [],
      }),
    },
    sessionSecret: SESSION_SECRET,
    googleClientId: GOOGLE_CLIENT_ID,
    googleClientSecret: GOOGLE_CLIENT_SECRET,
    adminAllowedEmails: ADMIN_ALLOWED_EMAILS,
    googleClient: makeGoogleClient(),
    slackClient: BASE_SLACK_CLIENT,
    appBaseUrl: "http://localhost:3001",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /admin/chat — auth gate", () => {
  it("returns 302 redirect to login without session cookie", async () => {
    const app = createAdminUIApp(makeBaseDeps());
    const res = await app.request("/admin/chat");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/admin/login");
  });
});

describe("GET /admin/chat — degraded mode (no chatClient)", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    sessionCookie = await makeSessionCookie();
  });

  it("returns 200 with agent selector and degraded notice when chatClient absent", async () => {
    const app = createAdminUIApp(makeBaseDeps()); // no chatClient
    const res = await app.request("/admin/chat", {
      headers: { Cookie: `admin_session=${sessionCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Should show agent selector / chat page shell
    expect(html).toContain("Chat");
    // Should show a degraded notice
    expect(html.toLowerCase()).toMatch(/not configured|unavailable|degraded/);
  });
});

describe("GET /admin/chat?agentId=X — with chatClient", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    sessionCookie = await makeSessionCookie();
  });

  it("returns 200 with thread list for selected agent", async () => {
    const chatClient = makeMockChatClient();
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request(`/admin/chat?agentId=${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${sessionCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(THREAD_ID);
    expect(html).toContain("Test Thread");
  });

  it("shows agent selector with the agent pre-selected", async () => {
    const chatClient = makeMockChatClient();
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request(`/admin/chat?agentId=${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${sessionCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(AGENT_ID);
  });

  it("shows empty state when no agentId selected", async () => {
    const chatClient = makeMockChatClient();
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request("/admin/chat", {
      headers: { Cookie: `admin_session=${sessionCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Chat");
    // No thread table when no agent selected
    expect(html).not.toContain(THREAD_ID);
  });
});

describe("GET /admin/chat/:agentId/threads/:threadId — thread detail", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    sessionCookie = await makeSessionCookie();
  });

  it("returns 401 without session cookie", async () => {
    const chatClient = makeMockChatClient();
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request(
      `/admin/chat/${AGENT_ID}/threads/${THREAD_ID}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/admin/login");
  });

  it("returns 200 with messages when chatClient present", async () => {
    const chatClient = makeMockChatClient();
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request(
      `/admin/chat/${AGENT_ID}/threads/${THREAD_ID}`,
      { headers: { Cookie: `admin_session=${sessionCookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Hello, agent!");
    expect(html).toContain("user");
  });

  it("returns degraded mode when chatClient absent", async () => {
    const app = createAdminUIApp(makeBaseDeps()); // no chatClient
    const res = await app.request(
      `/admin/chat/${AGENT_ID}/threads/${THREAD_ID}`,
      { headers: { Cookie: `admin_session=${sessionCookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toMatch(/not configured|unavailable|degraded/);
  });
});

describe("POST /admin/chat/:agentId/threads — create thread", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    sessionCookie = await makeSessionCookie();
  });

  it("returns 302 to thread detail on success", async () => {
    const chatClient = makeMockChatClient();
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request(`/admin/chat/${AGENT_ID}/threads`, {
      method: "POST",
      headers: {
        Cookie: `admin_session=${sessionCookie}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "title=My+New+Thread",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(THREAD_ID);
  });
});

describe("POST /admin/chat/:agentId/threads/:threadId/messages — create message", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    sessionCookie = await makeSessionCookie();
  });

  it("returns 302 back to thread detail on success", async () => {
    const chatClient = makeMockChatClient();
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request(
      `/admin/chat/${AGENT_ID}/threads/${THREAD_ID}/messages`,
      {
        method: "POST",
        headers: {
          Cookie: `admin_session=${sessionCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "body=Hello+from+admin",
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(THREAD_ID);
  });
});

describe("Toolbar", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    sessionCookie = await makeSessionCookie();
  });

  it("includes Chat nav link in the toolbar", async () => {
    const app = createAdminUIApp(makeBaseDeps());
    const res = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${sessionCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/admin/chat");
    expect(html).toContain(">Chat<");
  });
});

describe("POST /admin/chat/:agentId/threads/:threadId/rename — rename thread", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    sessionCookie = await makeSessionCookie();
  });

  it("returns 302 redirect back to the thread page on success", async () => {
    let updatedTitle: string | undefined;
    const chatClient = makeMockChatClient({
      updateThread: async (_id: string, data: { title?: string }) => {
        updatedTitle = data.title;
        return { ...MOCK_THREAD, title: data.title ?? MOCK_THREAD.title };
      },
    });
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request(
      `/admin/chat/${AGENT_ID}/threads/${THREAD_ID}/rename`,
      {
        method: "POST",
        headers: {
          Cookie: `admin_session=${sessionCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "title=Renamed+Thread",
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(THREAD_ID);
    expect(updatedTitle).toBe("Renamed Thread");
  });

  it("returns 302 to chat list when chatClient absent", async () => {
    const app = createAdminUIApp(makeBaseDeps()); // no chatClient
    const res = await app.request(
      `/admin/chat/${AGENT_ID}/threads/${THREAD_ID}/rename`,
      {
        method: "POST",
        headers: {
          Cookie: `admin_session=${sessionCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "title=Whatever",
      },
    );
    expect(res.status).toBe(302);
  });
});

describe("POST /admin/chat/:agentId/threads/:threadId/delete — delete thread", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    sessionCookie = await makeSessionCookie();
  });

  it("returns 302 redirect to /admin/chat?agentId=X on success", async () => {
    let deletedId: string | undefined;
    const chatClient = makeMockChatClient({
      deleteThread: async (id: string) => {
        deletedId = id;
      },
    });
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request(
      `/admin/chat/${AGENT_ID}/threads/${THREAD_ID}/delete`,
      {
        method: "POST",
        headers: {
          Cookie: `admin_session=${sessionCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "",
      },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/admin/chat");
    expect(location).toContain(AGENT_ID);
    expect(deletedId).toBe(THREAD_ID);
  });

  it("returns 302 when chatClient absent", async () => {
    const app = createAdminUIApp(makeBaseDeps()); // no chatClient
    const res = await app.request(
      `/admin/chat/${AGENT_ID}/threads/${THREAD_ID}/delete`,
      {
        method: "POST",
        headers: {
          Cookie: `admin_session=${sessionCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "",
      },
    );
    expect(res.status).toBe(302);
  });

  it("swallows deleteThread errors and still redirects to the agent thread list", async () => {
    const chatClient = makeMockChatClient({
      deleteThread: async () => {
        throw new Error("chat service unavailable");
      },
    });
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request(
      `/admin/chat/${AGENT_ID}/threads/${THREAD_ID}/delete`,
      {
        method: "POST",
        headers: {
          Cookie: `admin_session=${sessionCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "",
      },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/admin/chat");
    expect(location).toContain(AGENT_ID);
    // Must NOT redirect to the thread detail page
    expect(location).not.toContain(THREAD_ID);
  });
});

describe("GET /admin/chat?agentId=X&q=foo — search/filter threads", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    sessionCookie = await makeSessionCookie();
  });

  it("returns only threads matching the search query", async () => {
    const SECOND_THREAD: ChatThread = {
      id: "thread-other-999",
      agentId: AGENT_ID,
      title: "Unrelated topic",
      memberId: null,
      createdAt: "2024-01-02T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    };
    const chatClient = makeMockChatClient({
      listThreads: async () => ({
        threads: [MOCK_THREAD, SECOND_THREAD],
        total: 2,
        limit: 50,
        offset: 0,
      }),
    });
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request(
      `/admin/chat?agentId=${AGENT_ID}&q=Test`,
      {
        headers: { Cookie: `admin_session=${sessionCookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // Should show matching thread
    expect(html).toContain("Test Thread");
    // Should not show non-matching thread
    expect(html).not.toContain("Unrelated topic");
  });

  it("shows search input on the chat page", async () => {
    const chatClient = makeMockChatClient();
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request(`/admin/chat?agentId=${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${sessionCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Should have a search input with name "q"
    expect(html).toContain('name="q"');
  });

  it("returns all threads when q is empty", async () => {
    const SECOND_THREAD: ChatThread = {
      id: "thread-other-999",
      agentId: AGENT_ID,
      title: "Unrelated topic",
      memberId: null,
      createdAt: "2024-01-02T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    };
    const chatClient = makeMockChatClient({
      listThreads: async () => ({
        threads: [MOCK_THREAD, SECOND_THREAD],
        total: 2,
        limit: 50,
        offset: 0,
      }),
    });
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request(`/admin/chat?agentId=${AGENT_ID}&q=`, {
      headers: { Cookie: `admin_session=${sessionCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Test Thread");
    expect(html).toContain("Unrelated topic");
  });
});

describe("GET /admin/chat/:agentId/threads/:threadId — thread list pane on detail page", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    sessionCookie = await makeSessionCookie();
  });

  it("renders thread list links in the sidebar pane", async () => {
    const SECOND_THREAD: ChatThread = {
      id: "thread-other-999",
      agentId: AGENT_ID,
      title: "Second Thread",
      memberId: null,
      createdAt: "2024-01-02T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    };
    const chatClient = makeMockChatClient({
      listThreads: async () => ({
        threads: [MOCK_THREAD, SECOND_THREAD],
        total: 2,
        limit: 50,
        offset: 0,
      }),
    });
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request(
      `/admin/chat/${AGENT_ID}/threads/${THREAD_ID}`,
      { headers: { Cookie: `admin_session=${sessionCookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The thread detail page should include links to other threads (sidebar pane)
    expect(html).toContain("thread-other-999");
    expect(html).toContain("Second Thread");
  });

  it("renders rename form on the thread detail page", async () => {
    const chatClient = makeMockChatClient({
      updateThread: async (_id: string, data: { title?: string }) => ({
        ...MOCK_THREAD,
        title: data.title ?? null,
      }),
    });
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request(
      `/admin/chat/${AGENT_ID}/threads/${THREAD_ID}`,
      { headers: { Cookie: `admin_session=${sessionCookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // Should have a rename form pointing to the rename endpoint
    expect(html).toContain("/rename");
  });

  it("renders delete button on the thread detail page", async () => {
    const chatClient = makeMockChatClient({
      deleteThread: async () => {},
    });
    const app = createAdminUIApp(makeBaseDeps({ chatClient }));
    const res = await app.request(
      `/admin/chat/${AGENT_ID}/threads/${THREAD_ID}`,
      { headers: { Cookie: `admin_session=${sessionCookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // Should have a delete form pointing to the delete endpoint
    expect(html).toContain("/delete");
  });
});
