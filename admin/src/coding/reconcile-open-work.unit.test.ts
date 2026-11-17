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

  it("pages until a short page is returned", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: `x${i}`,
      repo: "o/removed",
      title: "t",
    }));
    let taskCalls = 0;
    const { port, calls } = make((c) => {
      if (c.url.pathname === "/prs") return json({ prs: [] });
      taskCalls++;
      return json({
        tasks:
          c.url.searchParams.get("offset") === "0" && taskCalls === 1
            ? full
            : [],
      });
    });
    const items = await port.listOpenWork("a1", ["o/removed"]);
    expect(items).toHaveLength(100);
    expect(
      calls.filter((c) => c.url.searchParams.get("offset") === "100").length,
    ).toBeGreaterThan(0);
  });
});
