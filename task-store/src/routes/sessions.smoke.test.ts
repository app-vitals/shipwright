/**
 * task-store/src/routes/sessions.smoke.test.ts
 *
 * Smoke tests for the /sessions routes via in-process app.request(), mirroring
 * routes/tasks.openapi.smoke.test.ts's pattern: createSessionsRoutes is
 * exercised directly against an injected SessionServiceLike double (no real
 * DB), wrapped in a minimal parent app that sets the auth context variables
 * (agentId/repos) the way the real bearer-auth middleware would.
 *
 * Per SESH-2.2's test decision (AC5): smoke tests only. SessionService's real
 * list()/get() logic is not under test here — the fake below implements the
 * same filtering/sorting/visibility semantics purely so route-level wiring
 * (query param parsing, agentScope construction, 404 mapping) can be
 * exercised end to end.
 */

import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { ApiError } from "../errors.ts";
import type {
  SessionListFilters,
  SessionListItem,
  SessionListResult,
  SessionServiceLike,
} from "../session-service.ts";
import { createSessionsRoutes } from "./sessions.ts";

// ─── Fake double ──────────────────────────────────────────────────────────────

interface FakeSessionRecord extends SessionListItem {
  /** Tasks used only by the fake's agentScope visibility check — not part of the real response shape. */
  scopeTasks: { assignee: string | null; repo: string | null }[];
}

function activityTime(v: string | null): number {
  return v === null ? Number.NEGATIVE_INFINITY : new Date(v).getTime();
}

function toItem(record: FakeSessionRecord): SessionListItem {
  const { scopeTasks: _scopeTasks, ...item } = record;
  return item;
}

function visible(
  record: FakeSessionRecord,
  agentScope?: { agentId: string; repos: string[] },
): boolean {
  if (!agentScope) return true;
  return record.scopeTasks.some(
    (t) =>
      t.assignee === agentScope.agentId ||
      (t.repo !== null && agentScope.repos.includes(t.repo)),
  );
}

function fakeSessionService(records: FakeSessionRecord[]): SessionServiceLike {
  return {
    async list(filters: SessionListFilters = {}): Promise<SessionListResult> {
      let items = records.filter((r) => visible(r, filters.agentScope));

      if (filters.q) {
        const needle = filters.q.toLowerCase();
        items = items.filter(
          (r) =>
            r.slug.toLowerCase().includes(needle) ||
            (r.title ?? "").toLowerCase().includes(needle),
        );
      }

      if (filters.state === undefined) {
        items = items.filter((r) => !r.archived && r.state !== "closed");
      } else if (filters.state === "archived") {
        items = items.filter((r) => r.archived);
      } else if (filters.state !== "all") {
        items = items.filter((r) => r.state === filters.state);
      }

      if (filters.agentId !== undefined) {
        const agentId = filters.agentId;
        items = items.filter((r) => r.agentIds.includes(agentId));
      }

      if (filters.repo !== undefined) {
        const repoList = Array.isArray(filters.repo)
          ? filters.repo
          : [filters.repo];
        items = items.filter((r) =>
          r.repos.some((repo) => repoList.includes(repo)),
        );
      }

      let sorted = [...items];
      if (filters.sort === "waitingSince") {
        const waiting = sorted.filter((r) => r.state === "waiting");
        const nonWaiting = sorted.filter((r) => r.state !== "waiting");
        waiting.sort(
          (a, b) =>
            new Date(a.waitingSince as string).getTime() -
            new Date(b.waitingSince as string).getTime(),
        );
        nonWaiting.sort(
          (a, b) =>
            activityTime(b.lastActivityAt) - activityTime(a.lastActivityAt),
        );
        sorted = [...waiting, ...nonWaiting];
      } else {
        sorted.sort(
          (a, b) =>
            activityTime(b.lastActivityAt) - activityTime(a.lastActivityAt),
        );
      }

      const total = sorted.length;
      const limit = filters.limit ?? 50;
      const offset = filters.offset ?? 0;
      const paged = sorted.slice(offset, offset + limit).map(toItem);
      return { sessions: paged, total, limit, offset };
    },

    async get(
      slug: string,
      agentScope?: { agentId: string; repos: string[] },
    ): Promise<SessionListItem | null> {
      const record = records.find((r) => r.slug === slug);
      if (!record) return null;
      if (!visible(record, agentScope)) return null;
      return toItem(record);
    },
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<FakeSessionRecord>): FakeSessionRecord {
  return {
    slug: "session-1",
    title: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    archivedAt: null,
    archivedBy: null,
    state: "active",
    waitingSince: null,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    counts: { total: 1, open: 1, closed: 0 },
    agentIds: [],
    repos: [],
    waitingTasks: [],
    archived: false,
    scopeTasks: [],
    ...overrides,
  } as FakeSessionRecord;
}

const FIXTURES: FakeSessionRecord[] = [
  makeRecord({
    slug: "waiting-old",
    state: "waiting",
    waitingSince: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    agentIds: ["agent-1"],
    repos: ["org/a"],
    waitingTasks: [{ id: "t-1", kind: "hitl" }],
    scopeTasks: [{ assignee: "agent-1", repo: "org/a" }],
  }),
  makeRecord({
    slug: "waiting-new",
    state: "waiting",
    waitingSince: "2026-01-05T00:00:00.000Z",
    lastActivityAt: "2026-01-05T00:00:00.000Z",
    agentIds: ["agent-2"],
    repos: ["org/b"],
    waitingTasks: [{ id: "t-2", kind: "blocked" }],
    scopeTasks: [{ assignee: "agent-2", repo: "org/b" }],
  }),
  makeRecord({
    slug: "active-1",
    state: "active",
    lastActivityAt: "2026-01-10T00:00:00.000Z",
    agentIds: ["agent-1"],
    repos: ["org/a"],
    scopeTasks: [{ assignee: "agent-1", repo: "org/a" }],
  }),
  makeRecord({
    slug: "active-2",
    title: "Launch Prep",
    state: "active",
    lastActivityAt: "2026-01-08T00:00:00.000Z",
    agentIds: [],
    repos: ["org/c"],
    scopeTasks: [{ assignee: null, repo: "org/c" }],
  }),
  makeRecord({
    slug: "closed-1",
    state: "closed",
    lastActivityAt: "2025-12-01T00:00:00.000Z",
    agentIds: ["agent-1"],
    repos: ["org/a"],
    scopeTasks: [{ assignee: "agent-1", repo: "org/a" }],
  }),
  makeRecord({
    slug: "empty-1",
    state: "empty",
    lastActivityAt: null,
    agentIds: [],
    repos: [],
    counts: { total: 0, open: 0, closed: 0 },
    scopeTasks: [],
  }),
  makeRecord({
    slug: "archived-1",
    state: "active",
    lastActivityAt: "2025-11-01T00:00:00.000Z",
    archivedAt: new Date("2025-11-02T00:00:00.000Z"),
    archivedBy: "dan",
    archived: true,
    agentIds: ["agent-1"],
    repos: ["org/a"],
    scopeTasks: [{ assignee: "agent-1", repo: "org/a" }],
  }),
  makeRecord({
    slug: "no-scope",
    state: "active",
    lastActivityAt: "2026-01-09T00:00:00.000Z",
    agentIds: ["agent-9"],
    repos: ["org/z"],
    scopeTasks: [{ assignee: "agent-9", repo: "org/z" }],
  }),
];

// ─── Parent-app auth harness (mirrors tasks.openapi.smoke.test.ts) ────────────

function makeParent(
  app: OpenAPIHono<TaskStoreAuthEnv>,
  agentId: string | null,
  repos: string[] | null,
) {
  const parent = new OpenAPIHono<TaskStoreAuthEnv>();
  parent.use("*", async (c, next) => {
    c.set("agentId", agentId);
    c.set("repos", repos);
    c.set("scopeDegraded", false);
    await next();
  });
  parent.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.message }, err.statusCode as 400);
    }
    return c.json({ error: "internal error" }, 500);
  });
  parent.route("/", app);
  return parent;
}

function makeAdminParent(app: OpenAPIHono<TaskStoreAuthEnv>) {
  return makeParent(app, null, null);
}

function makeAgentParent(
  app: OpenAPIHono<TaskStoreAuthEnv>,
  agentId: string,
  repos: string[] = [],
) {
  return makeParent(app, agentId, repos);
}

function makeApp(records: FakeSessionRecord[] = FIXTURES) {
  return createSessionsRoutes(fakeSessionService(records));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /sessions (smoke)", () => {
  it("returns an OpenAPIHono instance", () => {
    expect(makeApp()).toBeInstanceOf(OpenAPIHono);
  });

  it("admin token, ?state=all returns every session from the double", async () => {
    const parent = makeAdminParent(makeApp());
    const res = await parent.request("/?state=all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    expect(body.total).toBe(FIXTURES.length);
    expect(body.sessions.map((s) => s.slug).sort()).toEqual(
      FIXTURES.map((f) => f.slug).sort(),
    );
  });

  it("default (no ?state=) excludes closed and archived sessions", async () => {
    const parent = makeAdminParent(makeApp());
    const res = await parent.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    const slugs = body.sessions.map((s) => s.slug);
    expect(slugs).not.toContain("closed-1");
    expect(slugs).not.toContain("archived-1");
    expect(slugs).toContain("waiting-old");
    expect(slugs).toContain("active-1");
  });

  it("?state=waiting returns only waiting sessions", async () => {
    const parent = makeAdminParent(makeApp());
    const res = await parent.request("/?state=waiting");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    expect(body.sessions.map((s) => s.slug).sort()).toEqual(
      ["waiting-new", "waiting-old"].sort(),
    );
  });

  it("?state=active returns only active sessions", async () => {
    const parent = makeAdminParent(makeApp());
    const res = await parent.request("/?state=active");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    // archived-1 has rollup.state==='active' too but is a separate axis —
    // state=active does not additionally filter by archived (per spec).
    expect(body.sessions.map((s) => s.slug).sort()).toEqual(
      ["active-1", "active-2", "archived-1", "no-scope"].sort(),
    );
  });

  it("?state=closed returns only closed sessions", async () => {
    const parent = makeAdminParent(makeApp());
    const res = await parent.request("/?state=closed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    expect(body.sessions.map((s) => s.slug)).toEqual(["closed-1"]);
  });

  it("?state=empty returns only empty sessions", async () => {
    const parent = makeAdminParent(makeApp());
    const res = await parent.request("/?state=empty");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    expect(body.sessions.map((s) => s.slug)).toEqual(["empty-1"]);
  });

  it("?state=archived returns only archived sessions", async () => {
    const parent = makeAdminParent(makeApp());
    const res = await parent.request("/?state=archived");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    expect(body.sessions.map((s) => s.slug)).toEqual(["archived-1"]);
  });

  it("?sort=waitingSince orders oldest-waiting-first, non-waiting sessions after", async () => {
    const parent = makeAdminParent(makeApp());
    const res = await parent.request("/?state=all&sort=waitingSince");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    const slugs = body.sessions.map((s) => s.slug);
    // Both waiting sessions come first, oldest waitingSince first.
    expect(slugs.slice(0, 2)).toEqual(["waiting-old", "waiting-new"]);
    // Non-waiting sessions follow, sorted by lastActivityAt desc (nulls last):
    // active-1 (01-10) > no-scope (01-09) > active-2 (01-08) > closed-1
    // (2025-12-01) > archived-1 (2025-11-01) > empty-1 (null, sorts last).
    const rest = slugs.slice(2);
    expect(rest.indexOf("active-1")).toBeLessThan(rest.indexOf("no-scope"));
    expect(rest.indexOf("no-scope")).toBeLessThan(rest.indexOf("active-2"));
    expect(rest.indexOf("active-2")).toBeLessThan(rest.indexOf("closed-1"));
    expect(rest.indexOf("closed-1")).toBeLessThan(rest.indexOf("archived-1"));
    expect(rest[rest.length - 1]).toBe("empty-1");
  });

  it("?agentId=agent-1 filters to sessions touching that agent", async () => {
    const parent = makeAdminParent(makeApp());
    const res = await parent.request("/?state=all&agentId=agent-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    expect(body.sessions.map((s) => s.slug).sort()).toEqual(
      ["waiting-old", "active-1", "closed-1", "archived-1"].sort(),
    );
  });

  it("?repo=org/b filters to sessions touching that repo", async () => {
    const parent = makeAdminParent(makeApp());
    const res = await parent.request("/?state=all&repo=org%2Fb");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    expect(body.sessions.map((s) => s.slug)).toEqual(["waiting-new"]);
  });

  it("?q=launch substring-matches title (case-insensitive)", async () => {
    const parent = makeAdminParent(makeApp());
    const res = await parent.request("/?q=launch");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    expect(body.sessions.map((s) => s.slug)).toEqual(["active-2"]);
  });

  it("?q= substring-matches slug", async () => {
    const parent = makeAdminParent(makeApp());
    const res = await parent.request("/?state=all&q=archived");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    expect(body.sessions.map((s) => s.slug)).toEqual(["archived-1"]);
  });

  it("agent-scoped token only sees sessions with a qualifying task", async () => {
    const parent = makeAgentParent(makeApp(), "agent-1", ["org/a"]);
    const res = await parent.request("/?state=all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    // agent-1 is assignee on waiting-old/active-1/closed-1/archived-1 (all repo org/a).
    // waiting-new (agent-2/org/b), active-2 (repo org/c, no assignee match),
    // no-scope (agent-9/org/z), and empty-1 (zero tasks) must all be excluded.
    expect(body.sessions.map((s) => s.slug).sort()).toEqual(
      ["waiting-old", "active-1", "closed-1", "archived-1"].sort(),
    );
  });

  it("a session with zero qualifying tasks is absent from the scoped list", async () => {
    const parent = makeAgentParent(makeApp(), "agent-1", ["org/a"]);
    const res = await parent.request("/?state=all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    expect(body.sessions.map((s) => s.slug)).not.toContain("empty-1");
  });

  it("agent token with an empty repo scope still sees sessions it is assigned to", async () => {
    // repos: [] is "scoped-but-unknown" (auth.ts fail-safe restrictive) — it must
    // degrade to assignee-only visibility, never to unrestricted admin visibility.
    const parent = makeAgentParent(makeApp(), "agent-2", []);
    const res = await parent.request("/?state=all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    expect(body.sessions.map((s) => s.slug)).toEqual(["waiting-new"]);
    expect(body.total).toBe(1);
  });

  it("agent token with an empty repo scope and no assigned task sees zero sessions", async () => {
    const parent = makeAgentParent(makeApp(), "agent-unknown", []);
    const res = await parent.request("/?state=all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    expect(body.sessions).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("GET /sessions returns 401-shaped auth is enforced upstream — smoke here covers 200 shape: { sessions, total, limit, offset }", async () => {
    const parent = makeAdminParent(makeApp());
    const res = await parent.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListResult;
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.limit).toBe("number");
    expect(typeof body.offset).toBe("number");
  });
});

describe("GET /sessions/:slug (smoke)", () => {
  it("returns 200 with the flattened session+rollup shape for a visible session", async () => {
    const parent = makeAdminParent(makeApp());
    const res = await parent.request("/waiting-old");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListItem;
    expect(body.slug).toBe("waiting-old");
    expect(body.state).toBe("waiting");
    expect(body.waitingSince).toBe("2026-01-01T00:00:00.000Z");
    expect(body.agentIds).toEqual(["agent-1"]);
    expect(body.repos).toEqual(["org/a"]);
    expect(body.waitingTasks).toEqual([{ id: "t-1", kind: "hitl" }]);
    expect(body.archived).toBe(false);
    // Flattened — no nested "rollup" key.
    expect((body as unknown as { rollup?: unknown }).rollup).toBeUndefined();
  });

  it("returns 404 for a nonexistent slug", async () => {
    const parent = makeAdminParent(makeApp());
    const res = await parent.request("/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns 404 for an agent-scoped token with no qualifying task in that session", async () => {
    const parent = makeAgentParent(makeApp(), "agent-1", ["org/a"]);
    const res = await parent.request("/waiting-new");
    expect(res.status).toBe(404);
  });

  it("returns 200 for an agent-scoped token with a qualifying task in that session", async () => {
    const parent = makeAgentParent(makeApp(), "agent-1", ["org/a"]);
    const res = await parent.request("/active-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListItem;
    expect(body.slug).toBe("active-1");
  });

  it("returns 200 for an agent token with an empty repo scope assigned to a task in that session", async () => {
    const parent = makeAgentParent(makeApp(), "agent-2", []);
    const res = await parent.request("/waiting-new");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListItem;
    expect(body.slug).toBe("waiting-new");
  });

  it("returns 404 for an agent token with an empty repo scope and no assigned task", async () => {
    // Would be 200 (unrestricted) if an empty repo scope skipped agentScope.
    const parent = makeAgentParent(makeApp(), "agent-unknown", []);
    const res = await parent.request("/active-1");
    expect(res.status).toBe(404);
  });
});
