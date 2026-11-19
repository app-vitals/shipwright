/**
 * admin/src/coding/reconcile-open-work.unit.test.ts
 *
 * GHE-3.6 — the task-store OpenWorkPort lists and blocks an agent's open work
 * on removed repos. Driven through an injected fetch double; no globals touched.
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreOpenWorkPort } from "./reconcile-open-work.ts";

interface Call {
  url: URL;
  method: string;
  auth: string | null;
  body?: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function make(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const port = createTaskStoreOpenWorkPort({
    url: "http://ts.test",
    adminToken: "tok",
    fetch: async (input, init) => {
      const call: Call = {
        url: new URL(input),
        method: init?.method ?? "GET",
        auth: new Headers(init?.headers).get("Authorization"),
        ...(typeof init?.body === "string"
          ? { body: JSON.parse(init.body) }
          : {}),
      };
      calls.push(call);
      return respond(call);
    },
  });
  return { port, calls };
}

const handler = (call: Call): Response => {
  if (call.method === "PATCH") return json({});
  if (call.url.pathname === "/tasks") {
    return json({
      tasks: [
        { id: "t1", repo: "o/removed", title: "Task one" },
        { id: "t2", repo: "o/kept", title: "Wrong repo" },
        { id: "t3", repo: null, title: "No repo" },
      ],
    });
  }
  return json({
    prs: [
      {
        id: "p1",
        repo: "o/removed",
        prNumber: 7,
        title: null,
        agentId: "a1",
        claimedBy: null,
        blocked: false,
      },
      {
        id: "p2",
        repo: "o/removed",
        prNumber: 8,
        title: "Titled",
        agentId: null,
        claimedBy: "a1",
        blocked: true,
      },
      {
        id: "p3",
        repo: "o/removed",
        prNumber: 9,
        title: "Other agent",
        agentId: "a2",
        claimedBy: null,
        blocked: false,
      },
    ],
  });
};

describe("createTaskStoreOpenWorkPort", () => {
  it("lists nothing and makes no requests when no repos were removed", async () => {
    const { port, calls } = make(handler);
    expect(await port.listOpenWork("a1", [])).toEqual([]);
    await port.blockOpenWork("a1", [], "reason");
    expect(calls).toHaveLength(0);
  });

  it("lists deduped open tasks and unblocked owned PRs on the removed repos", async () => {
    const { port, calls } = make(handler);
    const items = await port.listOpenWork("a1", ["o/removed"]);
    expect(items).toEqual([
      { id: "t1", repo: "o/removed", title: "Task one" },
      { id: "p1", repo: "o/removed", title: "o/removed#7" },
    ]);
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
    const taskCalls = calls.filter((c) => c.url.pathname === "/tasks");
    // 4 open statuses x (assignee, claimedBy)
    expect(taskCalls).toHaveLength(8);
    expect(taskCalls[0]?.url.searchParams.getAll("repo")).toEqual([
      "o/removed",
    ]);
  });

  it("blocks each open task and PR with the reason", async () => {
    const { port, calls } = make(handler);
    await port.blockOpenWork("a1", ["o/removed"], "repo removed");
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((p) => p.url.pathname)).toEqual([
      "/tasks/t1",
      "/prs/p1",
    ]);
    expect(patches[0]?.body).toEqual({
      status: "blocked",
      blockedReason: "repo removed",
    });
    expect(patches[1]?.body).toEqual({
      blocked: true,
      blockedReason: "repo removed",
    });
  });

  it("throws on a non-ok GET", async () => {
    const { port } = make(() => json({}, 500));
    await expect(port.listOpenWork("a1", ["o/removed"])).rejects.toThrow(
      /GET \/tasks → 500/,
    );
  });

  it("throws on a non-ok PATCH", async () => {
    const { port } = make((c) =>
      c.method === "PATCH" ? json({}, 403) : handler(c),
    );
    await expect(port.blockOpenWork("a1", ["o/removed"], "r")).rejects.toThrow(
      /PATCH \/tasks\/t1 → 403/,
    );
  });

  it("follows nextCursor until it is null, never sending offset", async () => {
    const page = (n: number) =>
      Array.from({ length: 2 }, (_, i) => ({
        id: `x${n}-${i}`,
        repo: "o/removed",
        title: "t",
      }));
    const { port, calls } = make((c) => {
      if (c.url.pathname === "/prs") return json({ prs: [], nextCursor: null });
      const cursor = c.url.searchParams.get("cursor");
      if (!cursor) return json({ tasks: page(1), nextCursor: "c2" });
      if (cursor === "c2") return json({ tasks: page(2), nextCursor: "c3" });
      return json({ tasks: page(3), nextCursor: null });
    });
    const items = await port.listOpenWork("a1", ["o/removed"]);
    // 3 pages of 2 rows (deduped by id across the repeated status/who scans).
    expect(items).toHaveLength(6);
    expect(
      calls.filter((c) => c.url.searchParams.get("cursor") === "c3").length,
    ).toBeGreaterThan(0);
    expect(calls.every((c) => !c.url.searchParams.has("offset"))).toBe(true);
  });
});
