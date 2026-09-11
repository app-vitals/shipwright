/**
 * admin/src/admin-ui-sessions-list.smoke.test.ts
 * Smoke tests for GET /admin/sessions (SESH-4.2).
 *
 * Uses app.request() against a minimal Hono<AdminUIEnv> instance with
 * registerSessionsListRoutes() applied directly — no real server, no real
 * DB. agentMemberService/agentService and fetchTaskStoreSessions are
 * injected as plain in-memory doubles (per the "no mock.module()" isolation
 * rule), mirroring admin-ui-sessions.smoke.test.ts's pattern for the
 * sibling settings-routes module.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AdminUIEnv } from "./admin-ui.ts";
import {
  type Session,
  type SessionsListAgentMemberService,
  type SessionsListAgentService,
  type SessionsListDeps,
  registerSessionsListRoutes,
} from "./admin-ui-sessions-list.ts";

const DEFAULT_EMAIL = "admin@example.com";

// ─── Test doubles ─────────────────────────────────────────────────────────────

function fakeHtml(content: string, opts?: { status?: number }): Response {
  return new Response(content, {
    status: opts?.status ?? 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function makeFakeRequireAuth(): MiddlewareHandler<AdminUIEnv> {
  return async (c, next) => {
    c.set("userEmail", c.req.header("x-test-user-email") ?? DEFAULT_EMAIL);
    c.set("isAdmin", c.req.header("x-test-is-admin") !== "false");
    await next();
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    slug: "session-1",
    title: "Session One",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    archivedAt: null,
    archivedBy: null,
    state: "active",
    waitingSince: null,
    lastActivityAt: "2026-01-02T00:00:00.000Z",
    counts: { total: 2, open: 1, closed: 1 },
    agentIds: ["agent-a"],
    repos: ["org/repo-a"],
    waitingTasks: [],
    archived: false,
    ...overrides,
  };
}

function makeMemberService(
  memberships: Array<{ agentId: string }> = [],
): SessionsListAgentMemberService {
  return {
    listByEmail: async () =>
      memberships.map((m, i) => ({
        id: `member-${i}`,
        agentId: m.agentId,
        email: DEFAULT_EMAIL,
        createdAt: new Date("2024-01-01"),
      })),
  };
}

function makeAgentService(
  agents: Array<{ id: string; repos?: string[] }> = [],
): SessionsListAgentService {
  return {
    listByIds: async (ids: string[]) =>
      agents
        .filter((a) => ids.includes(a.id))
        .map((a) => ({
          id: a.id,
          name: a.id,
          slackId: null,
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: a.repos ?? [],
        })),
  };
}

function buildApp(overrides: Partial<SessionsListDeps> = {}): Hono<AdminUIEnv> {
  const app = new Hono<AdminUIEnv>();
  const deps: SessionsListDeps = {
    requireAuth: makeFakeRequireAuth(),
    agentMemberService: makeMemberService(),
    agentService: makeAgentService(),
    html: fakeHtml,
    ...overrides,
  };
  registerSessionsListRoutes(app, deps);
  return app;
}

// ─── AC1: admin sees all three sections, waiting sorted oldest-first ────────

describe("GET /admin/sessions — admin view", () => {
  it("renders Waiting/Active/Closed sections with sessions bucketed by state", async () => {
    const sessions = [
      makeSession({ slug: "s-waiting", title: "Waiting session", state: "waiting", waitingSince: "2026-01-01T00:00:00.000Z" }),
      makeSession({ slug: "s-active", title: "Active session", state: "active" }),
      makeSession({ slug: "s-closed", title: "Closed session", state: "closed" }),
    ];
    const app = buildApp({
      fetchTaskStoreSessions: async (params) => {
        expect(params.get("state")).toBe("all");
        return { sessions, total: sessions.length, limit: 50, offset: 0 };
      },
    });
    const res = await app.request("/admin/sessions");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Waiting session");
    expect(html).toContain("Active session");
    expect(html).toContain("Closed session");
    expect(html).toContain("Waiting on you");
    expect(html).toContain("Active");
    expect(html).toContain("Closed");
  });

  it("requests sort=waitingSince by default so waiting sessions come back oldest-first", async () => {
    const captured: { sort: string | null } = { sort: null };
    const app = buildApp({
      fetchTaskStoreSessions: async (params) => {
        captured.sort = params.get("sort");
        return { sessions: [], total: 0, limit: 50, offset: 0 };
      },
    });
    const res = await app.request("/admin/sessions");
    expect(res.status).toBe(200);
    expect(captured.sort).toBe("waitingSince");
  });

  it("excludes archived sessions from the default (non-archived) view", async () => {
    const sessions = [
      makeSession({ slug: "s-archived", title: "Archived session", state: "closed", archivedAt: "2026-01-05T00:00:00.000Z" }),
    ];
    const app = buildApp({
      fetchTaskStoreSessions: async () => ({
        sessions,
        total: sessions.length,
        limit: 50,
        offset: 0,
      }),
    });
    const res = await app.request("/admin/sessions");
    const html = await res.text();
    expect(html).not.toContain("Archived session");
  });

  it("?archived=true requests state=archived and renders only archived sessions", async () => {
    const captured: { state: string | null } = { state: null };
    const sessions = [
      makeSession({ slug: "s-archived", title: "Archived session", archivedAt: "2026-01-05T00:00:00.000Z" }),
    ];
    const app = buildApp({
      fetchTaskStoreSessions: async (params) => {
        captured.state = params.get("state");
        return { sessions, total: sessions.length, limit: 50, offset: 0 };
      },
    });
    const res = await app.request("/admin/sessions?archived=true");
    expect(res.status).toBe(200);
    expect(captured.state).toBe("archived");
    const html = await res.text();
    expect(html).toContain("Archived session");
  });
});

// ─── AC2: member scoping ─────────────────────────────────────────────────────

describe("GET /admin/sessions — member scoping", () => {
  it("a member of agent A only sees sessions with a task assigned to A or in A's repos", async () => {
    const sessions = [
      makeSession({ slug: "s-mine", title: "My session", agentIds: ["agent-a"], repos: [] }),
      makeSession({ slug: "s-repo-mine", title: "My repo session", agentIds: [], repos: ["org/repo-a"] }),
      makeSession({ slug: "s-not-mine", title: "Not my session", agentIds: ["agent-b"], repos: ["org/repo-b"] }),
    ];
    const app = buildApp({
      agentMemberService: makeMemberService([{ agentId: "agent-a" }]),
      agentService: makeAgentService([{ id: "agent-a", repos: ["org/repo-a"] }]),
      fetchTaskStoreSessions: async () => ({
        sessions,
        total: sessions.length,
        limit: 50,
        offset: 0,
      }),
    });
    const res = await app.request("/admin/sessions", {
      headers: { "x-test-is-admin": "false", "x-test-user-email": "member@example.com" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("My session");
    expect(html).toContain("My repo session");
    expect(html).not.toContain("Not my session");
  });

  // total/limit/offset come back from the task store BEFORE the client-side
  // member filter runs, so the summary must not claim they describe the
  // rendered rows.
  it("labels the pagination summary with the true visible count for a scoped member", async () => {
    const sessions = [
      makeSession({ slug: "s-mine", title: "My session", agentIds: ["agent-a"], repos: [] }),
      makeSession({ slug: "s-not-mine", title: "Not my session", agentIds: ["agent-b"], repos: [] }),
    ];
    const app = buildApp({
      agentMemberService: makeMemberService([{ agentId: "agent-a" }]),
      agentService: makeAgentService([{ id: "agent-a", repos: [] }]),
      fetchTaskStoreSessions: async () => ({
        sessions,
        total: 120,
        limit: 50,
        offset: 0,
      }),
    });
    const res = await app.request("/admin/sessions", {
      headers: { "x-test-is-admin": "false", "x-test-user-email": "member@example.com" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // One of the two fetched rows survived the scope filter.
    expect(html).toContain("1 visible in results 1–50 of 120");
    // …and never the bare pre-filter range, which would imply 50 visible rows.
    expect(html).not.toContain(">1–50 of 120<");
  });

  it("keeps the plain range summary for an admin (no client-side filtering)", async () => {
    const app = buildApp({
      fetchTaskStoreSessions: async () => ({
        sessions: [makeSession({ slug: "s-1", title: "Some session" })],
        total: 120,
        limit: 50,
        offset: 0,
      }),
    });
    const res = await app.request("/admin/sessions");
    const html = await res.text();
    expect(html).toContain(">1–50 of 120<");
    expect(html).not.toContain("visible in results");
  });

  it("a member with zero memberships renders an empty page, no error", async () => {
    const sessions = [makeSession({ slug: "s-1", title: "Some session" })];
    let fetchCalled = false;
    const app = buildApp({
      agentMemberService: makeMemberService([]),
      fetchTaskStoreSessions: async () => {
        fetchCalled = true;
        return { sessions, total: sessions.length, limit: 50, offset: 0 };
      },
    });
    const res = await app.request("/admin/sessions", {
      headers: { "x-test-is-admin": "false", "x-test-user-email": "nobody@example.com" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Some session");
    // Zero-membership scope resolves without ever needing to call the task store.
    expect(fetchCalled).toBe(false);
  });
});

// ─── Degraded mode ───────────────────────────────────────────────────────────

describe("GET /admin/sessions — degraded mode", () => {
  it("renders a degraded banner when fetchTaskStoreSessions is not configured", async () => {
    const app = buildApp({ fetchTaskStoreSessions: undefined });
    const res = await app.request("/admin/sessions");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Task store unavailable");
  });

  it("renders a degraded banner when fetchTaskStoreSessions throws", async () => {
    const app = buildApp({
      fetchTaskStoreSessions: async () => {
        throw new Error("boom");
      },
    });
    const res = await app.request("/admin/sessions");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Task store unavailable");
  });
});

// ─── Follow/Following stub ───────────────────────────────────────────────────

describe("GET /admin/sessions — row actions", () => {
  it("renders a Follow toggle stub per row", async () => {
    const sessions = [makeSession({ slug: "s-1", title: "Some session" })];
    const app = buildApp({
      fetchTaskStoreSessions: async () => ({
        sessions,
        total: sessions.length,
        limit: 50,
        offset: 0,
      }),
    });
    const res = await app.request("/admin/sessions");
    const html = await res.text();
    expect(html).toContain("Follow");
  });
});
