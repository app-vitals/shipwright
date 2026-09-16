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
  agents: Array<{ id: string; name?: string; repos?: string[] }> = [],
): SessionsListAgentService {
  // Name defaults to something distinct from the id (`<id>-name`) so a test
  // asserting the Agents column shows the *name* rather than the raw id
  // can't accidentally pass because the two strings happen to be equal.
  return {
    listByIds: async (ids: string[]) =>
      agents
        .filter((a) => ids.includes(a.id))
        .map((a) => ({
          id: a.id,
          name: a.name ?? `${a.id}-name`,
          slackId: null,
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: a.repos ?? [],
        })),
    listOptions: async () =>
      agents.map((a) => ({ id: a.id, name: a.name ?? `${a.id}-name` })),
    // Real case-insensitive substring match, mirroring AgentService.searchByName
    // (agents.ts), so tests exercising the agent-name filter can assert on
    // genuine fuzzy/partial-match and zero-match behavior rather than a
    // fixed/stubbed return value.
    searchByName: async (query: string) => {
      const q = query.toLowerCase();
      return agents
        .filter((a) => (a.name ?? `${a.id}-name`).toLowerCase().includes(q))
        .map((a) => ({
          id: a.id,
          name: a.name ?? `${a.id}-name`,
          slackId: null,
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: a.repos ?? [],
        }));
    },
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

// ─── SPT-1.2 AC1: Pacific timezone ──────────────────────────────────────────

describe("GET /admin/sessions — timezone", () => {
  it("renders Waiting since / Last activity in the configured timezone rather than server-local time", async () => {
    // 09:00 UTC lands on a different calendar hour in America/Los_Angeles
    // (01:00 PST, UTC-8) — a real, observable difference rather than an
    // assertion that merely re-implements the production code.
    const utcTimestamp = "2026-01-01T09:00:00.000Z";
    const sessions = [
      makeSession({
        slug: "s-tz",
        title: "TZ session",
        state: "waiting",
        waitingSince: utcTimestamp,
        lastActivityAt: utcTimestamp,
      }),
    ];
    const app = buildApp({
      timezone: "America/Los_Angeles",
      fetchTaskStoreSessions: async () => ({
        sessions,
        total: sessions.length,
        limit: 50,
        offset: 0,
      }),
    });
    const res = await app.request("/admin/sessions");
    const html = await res.text();

    const pacific = new Date(utcTimestamp).toLocaleString(undefined, {
      timeZone: "America/Los_Angeles",
    });
    const utc = new Date(utcTimestamp).toLocaleString(undefined, {
      timeZone: "UTC",
    });
    expect(pacific).not.toBe(utc);
    expect(html).toContain(pacific);
    expect(html).not.toContain(utc);
  });
});

// ─── SPT-1.2 AC2: agent name resolution ─────────────────────────────────────

describe("GET /admin/sessions — agent names", () => {
  it("resolves agent ids to names in the Agents column, falling back to the raw id when unmatched", async () => {
    const sessions = [
      makeSession({
        slug: "s-agents",
        title: "Agents session",
        agentIds: ["agent-a", "agent-unknown"],
      }),
    ];
    const app = buildApp({
      agentService: makeAgentService([{ id: "agent-a", name: "Agent Alpha" }]),
      fetchTaskStoreSessions: async () => ({
        sessions,
        total: sessions.length,
        limit: 50,
        offset: 0,
      }),
    });
    const res = await app.request("/admin/sessions");
    const html = await res.text();
    expect(html).toContain("Agent Alpha");
    // Unmatched id falls back to the raw id.
    expect(html).toContain("agent-unknown");
    // The matched id's raw form should not leak into the rendered badge.
    expect(html).not.toContain(">agent-a<");
  });
});

// ─── SPT-1.2 AC3: merged Session/Slug column ────────────────────────────────

describe("GET /admin/sessions — merged Session/Slug column", () => {
  it("has 7 columns, not 8 (no separate Slug <th>)", async () => {
    const app = buildApp({
      fetchTaskStoreSessions: async () => ({
        sessions: [],
        total: 0,
        limit: 50,
        offset: 0,
      }),
    });
    const res = await app.request("/admin/sessions");
    const html = await res.text();
    expect(html).not.toContain("<th>Slug</th>");
    expect(html).toContain('colspan="7"');
    expect(html).not.toContain('colspan="8"');
  });

  it("shows the slug underneath the title only when it differs from the title", async () => {
    const sessions = [
      makeSession({
        slug: "slug-one",
        title: "Custom Title",
        state: "active",
      }),
      makeSession({
        slug: "slug-two",
        title: null,
        state: "active",
      }),
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
    // title != slug: the slug renders separately as its own text node
    // (the title link's own text is "Custom Title", not the slug).
    expect(html).toContain(">slug-one<");
    // no title (title falls back to slug): the slug is the title link's
    // own text — it must not additionally render a second, separate slug
    // row underneath (that would just duplicate it).
    const slugTwoTextNodeCount = (html.match(/>slug-two</g) ?? []).length;
    expect(slugTwoTextNodeCount).toBe(1);
  });
});

// ─── SPT-1.2 AC4: Org+Repo+Agent filter autocomplete ────────────────────────

describe("GET /admin/sessions — filter autocomplete", () => {
  it("renders Org/Repo multiselects and an Agent datalist when fetchDistinctTaskValues is configured", async () => {
    const app = buildApp({
      fetchDistinctTaskValues: async () => ({
        sessions: [],
        repos: ["org/repo-a"],
        orgs: ["org"],
      }),
      agentService: makeAgentService([{ id: "agent-a", name: "Agent Alpha" }]),
      fetchTaskStoreSessions: async () => ({
        sessions: [],
        total: 0,
        limit: 50,
        offset: 0,
      }),
    });
    const res = await app.request("/admin/sessions");
    const html = await res.text();
    expect(html).toContain('name="org" multiple');
    expect(html).toContain('name="repo" multiple');
    expect(html).toContain('<option value="org/repo-a">org/repo-a</option>');
    expect(html).toContain('<option value="org">org</option>');
    expect(html).toContain('list="agents-list"');
    expect(html).toContain('<datalist id="agents-list">');
    expect(html).toContain('<option value="Agent Alpha">');
  });

  it("still renders working filter fields (no datalist, no crash) when fetchDistinctTaskValues is absent — degraded-mode parity with the Tasks page", async () => {
    const app = buildApp({
      fetchTaskStoreSessions: async () => ({
        sessions: [],
        total: 0,
        limit: 50,
        offset: 0,
      }),
    });
    const res = await app.request("/admin/sessions");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="org" multiple');
    expect(html).toContain('name="repo" multiple');
    expect(html).not.toContain("agents-list");
  });
});

// ─── SPT-1.2 AC5: org filter forwarding ─────────────────────────────────────

describe("GET /admin/sessions — org filter forwarding", () => {
  it("forwards repeated org= query values through to the task-store /sessions fetch", async () => {
    const captured: { org: string[] } = { org: [] };
    const app = buildApp({
      fetchTaskStoreSessions: async (params) => {
        captured.org = params.getAll("org");
        return { sessions: [], total: 0, limit: 50, offset: 0 };
      },
    });
    const res = await app.request("/admin/sessions?org=my-org&org=other-org");
    expect(res.status).toBe(200);
    expect(captured.org).toEqual(["my-org", "other-org"]);
  });
});

// ─── SLF-1.1: agent-name filter resolves to ids, not forwarded as agentId ───
//
// The Agent filter's <input> + datalist suggest agent *names*
// (agentService.listOptions()), but the task-store's GET /sessions only
// matches real agent *ids* (rollup.agentIds). Forwarding the typed name
// straight through as `agentId` always returned zero sessions. The fix
// resolves the name to matching ids via agentService.searchByName() first
// (shared with the Tasks page via resolveAgentNameFilterAndPaginate in
// admin-ui-pages.ts) and filters sessions client-side by agentIds membership.

describe("GET /admin/sessions — agent name filter (SLF-1.1)", () => {
  it("?agent=<name> returns only sessions whose agentIds resolve via searchByName, and never forwards the raw name as agentId", async () => {
    const sessions = [
      makeSession({ slug: "s-alpha", title: "Alpha session", agentIds: ["agent-alpha"] }),
      makeSession({ slug: "s-beta", title: "Beta session", agentIds: ["agent-beta"] }),
      makeSession({ slug: "s-none", title: "No agent session", agentIds: [] }),
    ];
    let capturedAgentId: string | null | undefined;
    const app = buildApp({
      agentService: makeAgentService([
        { id: "agent-alpha", name: "Agent Alpha" },
        { id: "agent-beta", name: "Agent Beta" },
      ]),
      fetchTaskStoreSessions: async (params) => {
        capturedAgentId = params.get("agentId");
        return { sessions, total: sessions.length, limit: 500, offset: 0 };
      },
    });
    const res = await app.request("/admin/sessions?agent=Alpha");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Alpha session");
    expect(html).not.toContain("Beta session");
    expect(html).not.toContain("No agent session");
    // The route must never forward the raw typed name as agentId — the
    // task-store only understands real agent ids, not display names.
    expect(capturedAgentId).toBeNull();
  });

  it("multiple fuzzy-matching agents are combined with OR semantics", async () => {
    const sessions = [
      makeSession({ slug: "s-alpha", title: "Alpha session", agentIds: ["agent-alpha"] }),
      makeSession({ slug: "s-beta", title: "Beta session", agentIds: ["agent-beta"] }),
      makeSession({ slug: "s-gamma", title: "Gamma session", agentIds: ["agent-gamma"] }),
    ];
    const app = buildApp({
      agentService: makeAgentService([
        { id: "agent-alpha", name: "Test Alpha" },
        { id: "agent-beta", name: "Test Beta" },
        { id: "agent-gamma", name: "Gamma Only" },
      ]),
      fetchTaskStoreSessions: async () => ({
        sessions,
        total: sessions.length,
        limit: 500,
        offset: 0,
      }),
    });
    const res = await app.request("/admin/sessions?agent=Test");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Alpha session");
    expect(html).toContain("Beta session");
    expect(html).not.toContain("Gamma session");
  });

  it("an agent-name filter with zero matches returns an empty session list, not a full/unfiltered list or a 500", async () => {
    const sessions = [
      makeSession({ slug: "s-alpha", title: "Alpha session", agentIds: ["agent-alpha"] }),
    ];
    const app = buildApp({
      agentService: makeAgentService([{ id: "agent-alpha", name: "Agent Alpha" }]),
      fetchTaskStoreSessions: async () => ({
        sessions,
        total: sessions.length,
        limit: 500,
        offset: 0,
      }),
    });
    const res = await app.request("/admin/sessions?agent=no-such-agent-name");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Alpha session");
    expect(html).toContain("No sessions.");
  });

  it("keeps pagination correct (limit/offset) when the agent filter is active", async () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      makeSession({
        slug: `s-${i}`,
        title: `Match session ${i}`,
        state: "active",
        agentIds: ["agent-match"],
      }),
    );
    const app = buildApp({
      agentService: makeAgentService([{ id: "agent-match", name: "Match Agent" }]),
      fetchTaskStoreSessions: async (params) => {
        // The route must widen to a large page (mirroring the Tasks page's
        // 500/0) rather than forwarding the caller's own small limit/offset,
        // since filtering happens client-side after this fetch.
        expect(params.get("limit")).toBe("500");
        expect(params.get("offset")).toBe("0");
        return { sessions, total: sessions.length, limit: 500, offset: 0 };
      },
    });
    const res = await app.request(
      "/admin/sessions?agent=Match&limit=2&offset=2",
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Match session 2");
    expect(html).toContain("Match session 3");
    expect(html).not.toContain("Match session 0");
    expect(html).not.toContain("Match session 1");
    expect(html).not.toContain("Match session 4");
    // 5 total matches, page 2 of a 2-per-page window: 3–4 of 5.
    expect(html).toContain("3–4 of 5");
  });
});
