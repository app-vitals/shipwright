/**
 * admin/src/coding/admin-ui-member-prs.smoke.test.ts
 *
 * MPV-1.3 — an agent member (non-admin, no account) sees /admin/prs scoped to
 * their agents' repos.
 *   - list: only in-scope PRs; the task-store receives repeated ?repo=
 *   - a user-supplied ?repo= is intersected with scope (outside → no rows)
 *   - detail: in-scope 200, out-of-scope and missing 404
 *   - zero memberships: 403
 */

import { describe, expect, it } from "bun:test";
import type { CallerScopeResolver } from "@app-vitals/agent-admin/caller-scope";
import { sign } from "hono/jwt";
import {
  type CodingMockDeps,
  createCodingTestApp,
  makeCodingMockDeps,
} from "./admin-ui-coding.fixtures.ts";
import type { PrListItem } from "./admin-ui-work-item-pages.ts";

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const MEMBER = "member@example.com";
const LONELY = "nobody@example.com";

function pr(id: string, repo: string, prNumber: number): PrListItem {
  return {
    id,
    repo,
    prNumber,
    staged: false,
    state: "open",
    reviewState: "pending",
    patchCycles: 0,
    reviewCycles: 0,
  };
}

const PRS: PrListItem[] = [
  pr("pr-in", "org/a-repo", 11),
  pr("pr-out", "org/other", 22),
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
    fetchTaskStorePrs: async (params: URLSearchParams) => {
      seenParams.push(params);
      const repos = params.getAll("repo");
      const rows = PRS.filter(
        (p) => repos.length === 0 || repos.includes(p.repo),
      );
      return { prs: rows, total: rows.length, limit: 50 };
    },
    fetchTaskStorePrById: async (id: string) =>
      PRS.find((p) => p.id === id) ?? null,
    fetchDistinctTaskValues: async () => ({
      sessions: [],
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
  return app.request(path, { headers: { Cookie: `admin_session=${cookie}` } });
}

describe("member PR view (MPV-1.3)", () => {
  it("list shows only PRs in the member's agents' repos and sends them as ?repo=", async () => {
    const seen: URLSearchParams[] = [];
    const res = await req(makeApp(seen), "/admin/prs", MEMBER);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("org/a-repo");
    expect(body).not.toContain("pr-out");
    expect(body).not.toContain("leaky-org");
    expect(seen[0]?.getAll("repo")).toEqual(["org/a-repo"]);
  });

  it("filter inside scope is honoured; filter outside scope yields no rows without calling the store", async () => {
    const seen: URLSearchParams[] = [];
    const app = makeApp(seen);
    const inside = await req(app, "/admin/prs?repo=org/a-repo", MEMBER);
    expect(inside.status).toBe(200);
    expect(seen[0]?.getAll("repo")).toEqual(["org/a-repo"]);

    seen.length = 0;
    const outside = await req(app, "/admin/prs?repo=org/other", MEMBER);
    expect(outside.status).toBe(200);
    expect(await outside.text()).not.toContain("/admin/prs/pr-out");
    expect(seen).toHaveLength(0);
  });

  it("detail: in-scope 200, out-of-scope and missing 404", async () => {
    const app = makeApp();
    expect((await req(app, "/admin/prs/pr-in", MEMBER)).status).toBe(200);
    expect((await req(app, "/admin/prs/pr-out", MEMBER)).status).toBe(404);
    expect((await req(app, "/admin/prs/pr-nope", MEMBER)).status).toBe(404);
  });

  it("a caller with zero memberships gets 403 on list and detail", async () => {
    const app = makeApp();
    expect((await req(app, "/admin/prs", LONELY)).status).toBe(403);
    expect((await req(app, "/admin/prs/pr-in", LONELY)).status).toBe(403);
  });
});
