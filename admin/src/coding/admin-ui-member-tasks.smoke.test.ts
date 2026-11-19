/**
 * admin/src/coding/admin-ui-member-tasks.smoke.test.ts
 *
 * MPV-1.2 — an agent member (non-admin, no account) sees /admin/tasks scoped
 * to their agents (assignee in agentIds OR repo in the agents' repos).
 *   - list: only in-scope tasks; the task-store receives scopeAgentIds/scopeRepos
 *   - detail: in-scope 200, out-of-scope 404 (no existence leak)
 *   - zero memberships: 403
 *   - quick-add / promote / release stay 403 for members
 */

import { describe, expect, it } from "bun:test";
import type { CallerScopeResolver } from "@app-vitals/agent-admin/caller-scope";
import { sign } from "hono/jwt";
import {
  type CodingMockDeps,
  createCodingTestApp,
  makeCodingMockDeps,
} from "./admin-ui-coding.fixtures.ts";
import type { TaskItem } from "./admin-ui-work-item-pages.ts";

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const MEMBER = "member@example.com";
const LONELY = "nobody@example.com";

const TASKS: TaskItem[] = [
  { id: "T-own", title: "Assigned to A", status: "pending", assignee: "agt-a" },
  {
    id: "T-repo",
    title: "Inside repo of A",
    status: "pending",
    assignee: "agt-b",
    repo: "org/a-repo",
  },
  {
    id: "T-other",
    title: "Unrelated other work",
    status: "pending",
    assignee: "agt-b",
    repo: "org/other",
  },
];

const callerScopeResolver: CallerScopeResolver = async (email, isAdmin) => {
  if (isAdmin) return { kind: "all" };
  if (email === MEMBER)
    return { kind: "scoped", accountId: null, agentIds: ["agt-a"] };
  return { kind: "scoped", accountId: null, agentIds: [] };
};

function makeApp(seenParams: URLSearchParams[] = []) {
  const deps: CodingMockDeps = makeCodingMockDeps({
    sessionSecret: SESSION_SECRET,
    callerScopeResolver,
    agentService: {
      listByIds: async (ids: string[]) =>
        ids.includes("agt-a")
          ? [{ id: "agt-a", name: "Agent A", repos: ["org/a-repo"] }]
          : [],
      listOptions: async () => [],
      searchByName: async () => [],
    },
    fetchTaskStoreTasks: async (params: URLSearchParams) => {
      seenParams.push(params);
      const agents = (params.get("scopeAgentIds") ?? "").split(",");
      const repos = (params.get("scopeRepos") ?? "").split(",");
      const rows = TASKS.filter(
        (t) =>
          (t.assignee && agents.includes(t.assignee)) ||
          (t.repo && repos.includes(t.repo)),
      );
      return { tasks: rows, total: rows.length, limit: 50 };
    },
    fetchTaskStoreTask: async (id: string) =>
      TASKS.find((t) => t.id === id) ?? null,
    fetchDistinctTaskValues: async () => ({
      sessions: ["leaky-session"],
      repos: ["org/other"],
      orgs: ["leaky-org"],
    }),
  } as unknown as Partial<CodingMockDeps>);
  return createCodingTestApp(deps);
}

async function req(
  app: ReturnType<typeof createCodingTestApp>,
  path: string,
  email: string,
  method = "GET",
): Promise<Response> {
  const cookie = await sign(
    {
      userId: "sub",
      email,
      isAdmin: false,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SESSION_SECRET,
    "HS256",
  );
  return app.request(path, {
    method,
    headers: {
      Cookie: `admin_session=${cookie}`,
      ...(method === "POST"
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
    },
    ...(method === "POST" ? { body: "title=x&kind=feature" } : {}),
  });
}

describe("member task view (MPV-1.2)", () => {
  it("list shows only tasks assigned to the member's agents or in their repos", async () => {
    const seen: URLSearchParams[] = [];
    const res = await req(makeApp(seen), "/admin/tasks?view=table", MEMBER);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Assigned to A");
    expect(body).toContain("Inside repo of A");
    expect(body).not.toContain("Unrelated other work");
    expect(seen[0]?.get("scopeAgentIds")).toBe("agt-a");
    expect(seen[0]?.get("scopeRepos")).toBe("org/a-repo");
  });

  it("board view is scoped too, and suggestions don't leak out-of-scope values", async () => {
    const res = await req(makeApp(), "/admin/tasks", MEMBER);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("Unrelated other work");
    expect(body).not.toContain("leaky-session");
    expect(body).not.toContain("leaky-org");
    expect(body).not.toContain("org/other");
  });

  it("detail: in-scope task 200, out-of-scope task and missing task 404", async () => {
    const app = makeApp();
    expect((await req(app, "/admin/tasks/T-own", MEMBER)).status).toBe(200);
    expect((await req(app, "/admin/tasks/T-repo", MEMBER)).status).toBe(200);
    expect((await req(app, "/admin/tasks/T-other", MEMBER)).status).toBe(404);
    expect((await req(app, "/admin/tasks/T-nope", MEMBER)).status).toBe(404);
  });

  it("a caller with zero memberships gets 403 on list and detail", async () => {
    const app = makeApp();
    expect((await req(app, "/admin/tasks", LONELY)).status).toBe(403);
    expect((await req(app, "/admin/tasks/T-own", LONELY)).status).toBe(403);
  });

  it("quick-add, promote and release stay 403 for members", async () => {
    const app = makeApp();
    for (const path of [
      "/admin/tasks/quick-add",
      "/admin/tasks/T-own/promote",
      "/admin/tasks/T-own/release",
    ]) {
      expect((await req(app, path, MEMBER, "POST")).status).toBe(403);
    }
  });
});
