/**
 * task-store/src/tasks.patch-by-pr.smoke.test.ts
 *
 * Smoke coverage for PATCH /tasks/by-pr (MPD-1.2) with a faked TaskService:
 * routing (literal path wins over /:id), request validation (400s), repo and
 * account scoping, and pass-through of the service result. The transaction and
 * TaskEvent behavior is covered by patch-by-pr.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import type { ScopeResolver } from "./auth.ts";
import type { SessionServiceLike } from "./session-service.ts";
import {
  MAX_PATCH_BY_PR_NUMBERS,
  type MarkMergedByPrResult,
  type TaskServiceLike,
} from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

const ADMIN_TOKEN = "admin-token";
const AGENT_TOKEN = "agent-token";

type Call = Parameters<TaskServiceLike["markMergedByPr"]>[0];

function fakeTokenService(): TokenServiceLike {
  return {
    async create() {
      throw new Error("not implemented");
    },
    async validate(raw: string) {
      if (raw === ADMIN_TOKEN) return { id: "tok-1", agentId: null };
      if (raw === AGENT_TOKEN) return { id: "tok-2", agentId: "agent-1" };
      return null;
    },
    async revoke() {
      return null;
    },
    async list() {
      return [];
    },
    async update() {
      return null;
    },
  };
}

function fakeSessionService(): SessionServiceLike {
  return {
    async list() {
      return { sessions: [], total: 0, limit: 50, offset: 0 };
    },
    async get() {
      return null;
    },
    async update() {
      throw new Error("not implemented");
    },
  };
}

function setup(
  opts: {
    result?: MarkMergedByPrResult;
    repos?: string[];
    accountId?: string | null;
  } = {},
) {
  const calls: Call[] = [];
  const updateCalls: string[] = [];
  const taskService = {
    async markMergedByPr(params: Call) {
      calls.push(params);
      return opts.result ?? { updated: [], unchanged: [], skipped: [] };
    },
    async get() {
      return null;
    },
    async update(id: string) {
      updateCalls.push(id);
      throw new Error("PATCH /:id must not capture /by-pr");
    },
  } as unknown as TaskServiceLike;
  const scopeResolver: ScopeResolver = async () => ({
    repos: opts.repos ?? ["org/repo"],
    accountId: opts.accountId ?? null,
  });
  const app = createTaskStoreApp({
    taskService,
    tokenService: fakeTokenService(),
    sessionService: fakeSessionService(),
    scopeResolver,
  });
  return { app, calls, updateCalls };
}

function patch(
  app: ReturnType<typeof setup>["app"],
  body: unknown,
  token = ADMIN_TOKEN,
  query = "",
) {
  return app.request(`/tasks/by-pr${query}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const VALID = { repo: "org/repo", prNumbers: [1, 2], status: "deployed" };

describe("PATCH /tasks/by-pr (smoke)", () => {
  it("returns the service result and does not fall into PATCH /tasks/:id", async () => {
    const result = {
      updated: ["t1"],
      unchanged: ["t2"],
      skipped: [{ id: "t3", status: "pr_open" }],
    };
    const { app, calls, updateCalls } = setup({ result });
    const res = await patch(app, { ...VALID, at: "2026-07-02T00:00:00.000Z" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(updateCalls).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      repo: "org/repo",
      prNumbers: [1, 2],
      status: "deployed",
      at: "2026-07-02T00:00:00.000Z",
      accountId: null,
    });
  });

  it("accepts status=released", async () => {
    const { app, calls } = setup();
    const res = await patch(app, { ...VALID, status: "released" });
    expect(res.status).toBe(200);
    expect(calls[0]?.status).toBe("released");
  });

  it("an empty result (no matching tasks) is a 200 with empty lists", async () => {
    const { app } = setup();
    const res = await patch(app, VALID);
    expect(await res.json()).toEqual({
      updated: [],
      unchanged: [],
      skipped: [],
    });
  });

  it.each([
    ["empty prNumbers", { ...VALID, prNumbers: [] }],
    [
      "over-large batch",
      {
        ...VALID,
        prNumbers: Array.from(
          { length: MAX_PATCH_BY_PR_NUMBERS + 1 },
          (_, i) => i + 1,
        ),
      },
    ],
    ["non-integer PR number", { ...VALID, prNumbers: [1.5] }],
    ["zero PR number", { ...VALID, prNumbers: [0] }],
    ["negative PR number", { ...VALID, prNumbers: [-3] }],
    ["string PR number", { ...VALID, prNumbers: ["12"] }],
    ["unknown status", { ...VALID, status: "done" }],
    ["status merged", { ...VALID, status: "merged" }],
    ["missing status", { repo: VALID.repo, prNumbers: VALID.prNumbers }],
    ["missing repo", { prNumbers: VALID.prNumbers, status: "deployed" }],
    ["malformed repo", { ...VALID, repo: "not-a-repo" }],
  ])("returns 400 for %s", async (_name, body) => {
    const { app, calls } = setup();
    const res = await patch(app, body);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("accepts exactly MAX_PATCH_BY_PR_NUMBERS entries", async () => {
    const { app } = setup();
    const res = await patch(app, {
      ...VALID,
      prNumbers: Array.from(
        { length: MAX_PATCH_BY_PR_NUMBERS },
        (_, i) => i + 1,
      ),
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 without a token", async () => {
    const { app } = setup();
    const res = await app.request("/tasks/by-pr", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID),
    });
    expect(res.status).toBe(401);
  });

  it("agent token with the repo in scope is allowed and account-scoped", async () => {
    const { app, calls } = setup({ accountId: "acct-1" });
    const res = await patch(app, VALID, AGENT_TOKEN);
    expect(res.status).toBe(200);
    expect(calls[0]?.accountId).toBe("acct-1");
  });

  it("agent token with a repo outside its scope gets 403 and nothing is called", async () => {
    const { app, calls } = setup({ repos: ["other/repo"] });
    const res = await patch(app, VALID, AGENT_TOKEN);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("agent token with no repos in scope gets 403", async () => {
    const { app, calls } = setup({ repos: [] });
    const res = await patch(app, VALID, AGENT_TOKEN);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("admin token narrows to ?accountId=", async () => {
    const { app, calls } = setup();
    const res = await patch(app, VALID, ADMIN_TOKEN, "?accountId=acct-9");
    expect(res.status).toBe(200);
    expect(calls[0]?.accountId).toBe("acct-9");
  });
});
