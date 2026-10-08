/**
 * task-store/src/tasks-account-scope.integration.test.ts
 *
 * SSP-6.5 — account (tenant) isolation for Task reads and writes, against a
 * real Postgres DB. Covers both the TaskService layer (accountId-scoped
 * list/listReady/listBlocked/distinct/get, per-account dependency
 * resolution) and the HTTP layer driven through `app.request()` with real
 * agent tokens for accounts A, B and the default account plus an admin
 * token.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; the suite skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DEFAULT_ACCOUNT_ID } from "@shipwright/lib/default-account";
import { createTaskStoreApp } from "./app.ts";
import type { ScopeResolver } from "./auth.ts";
import type { Task } from "./index.ts";
import { type PrismaClient, createPrismaClient } from "./prisma-client.ts";
import { SessionService } from "./session-service.ts";
import { TaskService, type TaskWithBlockedBy } from "./task-service.ts";
import { TaskTokenService } from "./token-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createPrismaClient(TEST_DB as string);
}

const ACCT_A = "acct-a";
const ACCT_B = "acct-b";
// Both tenants' agents are scoped to the SAME repo string — repo scoping
// alone must not leak tasks across accounts.
const SHARED_REPO = "org/shared";

async function seed(
  prisma: PrismaClient,
  data: {
    id: string;
    accountId: string;
    status?: Task["status"];
    dependencies?: string[];
    branch?: string | null;
    session?: string | null;
    assignee?: string | null;
    claimedBy?: string | null;
    heartbeatAt?: string | null;
    createdAt?: Date;
  },
): Promise<Task> {
  return prisma.task.create({
    data: {
      title: data.id,
      status: data.status ?? "pending",
      repo: SHARED_REPO,
      ...data,
    },
  });
}

describeOrSkip("Task account scope — TaskService (integration)", () => {
  let prisma: PrismaClient;
  let service: TaskService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    service = new TaskService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("listReady(accountId) never resolves a dependency against another account's task", async () => {
    // DEP-1 exists (done) only in account B. A's task depends on it.
    await seed(prisma, { id: "B-DEP-1", accountId: ACCT_B, status: "done" });
    await seed(prisma, {
      id: "A-1",
      accountId: ACCT_A,
      dependencies: ["B-DEP-1"],
    });
    await seed(prisma, { id: "A-2", accountId: ACCT_A });
    await seed(prisma, { id: "B-1", accountId: ACCT_B });

    const ready = await service.listReady(
      undefined,
      undefined,
      undefined,
      ACCT_A,
    );
    expect(ready.map((t) => t.id)).toEqual(["A-2"]);
  });

  it("listReady(accountId) for A is unaffected by B's fresh same-branch in_progress sibling", async () => {
    await seed(prisma, {
      id: "B-WIP",
      accountId: ACCT_B,
      status: "in_progress",
      branch: "feat/shared",
      claimedBy: "agent-b",
      heartbeatAt: new Date().toISOString(),
    });
    await seed(prisma, { id: "A-1", accountId: ACCT_A, branch: "feat/shared" });

    const ready = await service.listReady(
      undefined,
      undefined,
      undefined,
      ACCT_A,
    );
    expect(ready.map((t) => t.id)).toEqual(["A-1"]);
  });

  it("listReady() unrestricted (admin) still resolves dependencies per account", async () => {
    await seed(prisma, { id: "B-DEP-1", accountId: ACCT_B, status: "done" });
    await seed(prisma, {
      id: "A-1",
      accountId: ACCT_A,
      dependencies: ["B-DEP-1"],
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await seed(prisma, {
      id: "B-1",
      accountId: ACCT_B,
      dependencies: ["B-DEP-1"],
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    await seed(prisma, {
      id: "D-1",
      accountId: DEFAULT_ACCOUNT_ID,
      createdAt: new Date("2026-01-03T00:00:00Z"),
    });

    const ready = await service.listReady();
    // A-1's only dependency lives in B → not satisfied; B-1's resolves in B.
    expect(ready.map((t) => t.id)).toEqual(["B-1", "D-1"]);
  });

  it("listBlocked(accountId) only returns the account's tasks and reports cross-account deps as unresolved", async () => {
    await seed(prisma, { id: "B-DEP-1", accountId: ACCT_B, status: "done" });
    await seed(prisma, {
      id: "A-1",
      accountId: ACCT_A,
      dependencies: ["B-DEP-1"],
    });
    await seed(prisma, { id: "B-BLK", accountId: ACCT_B, status: "blocked" });

    const blocked = await service.listBlocked(
      undefined,
      undefined,
      undefined,
      undefined,
      ACCT_A,
    );
    expect(blocked.map((t) => t.id)).toEqual(["A-1"]);
    expect(blocked[0]?.blockedBy.length).toBeGreaterThan(0);
  });

  it("listBlocked() unrestricted (admin) computes blockedBy within each task's own account", async () => {
    await seed(prisma, { id: "B-DEP-1", accountId: ACCT_B, status: "done" });
    await seed(prisma, {
      id: "A-1",
      accountId: ACCT_A,
      dependencies: ["B-DEP-1"],
    });
    await seed(prisma, {
      id: "B-1",
      accountId: ACCT_B,
      dependencies: ["B-DEP-1"],
    });

    const blocked = await service.listBlocked();
    expect(blocked.map((t) => t.id)).toEqual(["A-1"]);
  });

  it("list({ accountId }) returns only that account's rows and resolves blockedBy within it", async () => {
    await seed(prisma, { id: "B-DEP-1", accountId: ACCT_B, status: "done" });
    await seed(prisma, {
      id: "A-1",
      accountId: ACCT_A,
      dependencies: ["B-DEP-1"],
    });
    await seed(prisma, { id: "B-1", accountId: ACCT_B });

    const result = await service.list({ accountId: ACCT_A });
    expect(result.tasks.map((t) => t.id)).toEqual(["A-1"]);
    expect(result.total).toBe(1);
    expect(result.tasks[0]?.blockedBy.length).toBeGreaterThan(0);

    // Admin (unrestricted) view: the cross-account dep still doesn't resolve.
    const all = await service.list();
    const a1 = all.tasks.find((t) => t.id === "A-1") as TaskWithBlockedBy;
    expect(a1.blockedBy.length).toBeGreaterThan(0);
    expect(all.total).toBe(3);
  });

  it("get(id, accountId) returns null for another account's task", async () => {
    await seed(prisma, { id: "B-1", accountId: ACCT_B });
    expect(await service.get("B-1", ACCT_A)).toBeNull();
    expect((await service.get("B-1", ACCT_B))?.id).toBe("B-1");
    expect((await service.get("B-1"))?.id).toBe("B-1");
  });

  it("distinct(…, accountId) only surfaces the account's sessions", async () => {
    await seed(prisma, { id: "A-1", accountId: ACCT_A, session: "SESS-A" });
    await seed(prisma, { id: "B-1", accountId: ACCT_B, session: "SESS-B" });

    const a = await service.distinct(undefined, undefined, ACCT_A);
    expect(a.sessions).toEqual(["SESS-A"]);
    const all = await service.distinct();
    expect(all.sessions).toEqual(["SESS-A", "SESS-B"]);
  });
});

describeOrSkip("Task account scope — HTTP (integration)", () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof createTaskStoreApp>;
  const tokens: Record<"admin" | "a" | "b" | "def", string> = {
    admin: "",
    a: "",
    b: "",
    def: "",
  };

  // Fixture resolver: every agent is scoped to the same repo string; only
  // the account differs. agent-def is an unassigned agent (null → default).
  const scopeResolver: ScopeResolver = async (agentId) => ({
    repos: [SHARED_REPO],
    accountId:
      agentId === "agent-a" ? ACCT_A : agentId === "agent-b" ? ACCT_B : null,
  });

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.taskToken.deleteMany();
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();

    const tokenService = new TaskTokenService(prisma);
    tokens.admin = (await tokenService.create("admin")).rawToken;
    tokens.a = (await tokenService.create("a", "agent-a")).rawToken;
    tokens.b = (await tokenService.create("b", "agent-b")).rawToken;
    tokens.def = (await tokenService.create("def", "agent-def")).rawToken;

    app = createTaskStoreApp({
      taskService: new TaskService(prisma),
      tokenService,
      sessionService: new SessionService(prisma),
      scopeResolver,
    });

    await seed(prisma, { id: "A-1", accountId: ACCT_A });
    await seed(prisma, { id: "B-1", accountId: ACCT_B });
    await seed(prisma, { id: "D-1", accountId: DEFAULT_ACCOUNT_ID });
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  function auth(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
  }

  async function listIds(token: string, query = ""): Promise<string[]> {
    const res = await app.request(`/tasks${query}`, { headers: auth(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { id: string }[] };
    return body.tasks.map((t) => t.id).sort();
  }

  it("two accounts on the same repo string each list only their own tasks", async () => {
    expect(await listIds(tokens.a)).toEqual(["A-1"]);
    expect(await listIds(tokens.b)).toEqual(["B-1"]);
    expect(await listIds(tokens.a, "?ready=true")).toEqual(["A-1"]);
    expect(await listIds(tokens.b, "?state=ready")).toEqual(["B-1"]);
  });

  it("an agent token ignores ?accountId= (cannot widen to another account)", async () => {
    expect(await listIds(tokens.a, `?accountId=${ACCT_B}`)).toEqual(["A-1"]);
  });

  it("default-account agent tokens see only 'default' rows (regression)", async () => {
    expect(await listIds(tokens.def)).toEqual(["D-1"]);
    expect(await listIds(tokens.def, "?ready=true")).toEqual(["D-1"]);
  });

  it("admin token without ?accountId sees all rows; with ?accountId narrows to one", async () => {
    expect(await listIds(tokens.admin)).toEqual(["A-1", "B-1", "D-1"]);
    expect(await listIds(tokens.admin, "?ready=true")).toEqual([
      "A-1",
      "B-1",
      "D-1",
    ]);
    expect(await listIds(tokens.admin, `?accountId=${ACCT_B}`)).toEqual([
      "B-1",
    ]);
  });

  it("?state=blocked is scoped to the caller's account", async () => {
    await prisma.task.update({
      where: { id: "B-1" },
      data: { status: "blocked" },
    });
    await seed(prisma, { id: "A-BLK", accountId: ACCT_A, status: "blocked" });
    expect(await listIds(tokens.a, "?state=blocked")).toEqual(["A-BLK"]);
    expect(await listIds(tokens.b, "?state=blocked")).toEqual(["B-1"]);
  });

  it("GET /tasks/distinct is scoped to the caller's account", async () => {
    await prisma.task.update({
      where: { id: "B-1" },
      data: { session: "SESS-B" },
    });
    const res = await app.request("/tasks/distinct", {
      headers: auth(tokens.a),
    });
    const body = (await res.json()) as { sessions: string[] };
    expect(body.sessions).toEqual([]);
  });

  it("GET /tasks/:id for another account's task returns 404 (not 403)", async () => {
    const res = await app.request("/tasks/B-1", { headers: auth(tokens.a) });
    expect(res.status).toBe(404);
    const own = await app.request("/tasks/A-1", { headers: auth(tokens.a) });
    expect(own.status).toBe(200);
  });

  it("every /:id mutation on another account's task returns 404 and leaves it untouched", async () => {
    const calls: [string, string, unknown?][] = [
      ["PATCH", "/tasks/B-1", { note: "x" }],
      ["DELETE", "/tasks/B-1"],
      ["POST", "/tasks/B-1/claim"],
      ["POST", "/tasks/B-1/heartbeat"],
      ["POST", "/tasks/B-1/complete"],
      ["POST", "/tasks/B-1/fail", { reason: "x" }],
      ["POST", "/tasks/B-1/release"],
      ["POST", "/tasks/B-1/skip", { reason: "x" }],
      ["POST", "/tasks/B-1/skip/reset"],
      ["POST", "/tasks/B-1/unblock"],
      ["GET", "/tasks/B-1/events"],
    ];
    for (const [method, path, body] of calls) {
      const res = await app.request(path, {
        method,
        ...(body !== undefined
          ? { headers: auth(tokens.a), body: JSON.stringify(body) }
          : { headers: { Authorization: `Bearer ${tokens.a}` } }),
      });
      expect({ path, method, status: res.status }).toEqual({
        path,
        method,
        status: 404,
      });
    }
    const b1 = await prisma.task.findUnique({ where: { id: "B-1" } });
    expect(b1?.status).toBe("pending");
    expect(b1?.note).toBeNull();
  });

  it("POST /tasks stamps accountId from the caller (agent: resolved; admin: ?accountId or default)", async () => {
    const create = async (token: string, id: string, query = "") => {
      const res = await app.request(`/tasks${query}`, {
        method: "POST",
        headers: auth(token),
        // A body-supplied accountId must never override the caller's scope.
        body: JSON.stringify({
          id,
          title: id,
          status: "pending",
          repo: SHARED_REPO,
          accountId: ACCT_B,
        }),
      });
      expect(res.status).toBe(201);
      return (await prisma.task.findUnique({ where: { id } }))?.accountId;
    };
    expect(await create(tokens.a, "NEW-A")).toBe(ACCT_A);
    expect(await create(tokens.def, "NEW-D")).toBe(DEFAULT_ACCOUNT_ID);
    expect(await create(tokens.admin, "NEW-ADM")).toBe(DEFAULT_ACCOUNT_ID);
    expect(
      await create(tokens.admin, "NEW-ADM-A", `?accountId=${ACCT_A}`),
    ).toBe(ACCT_A);
  });

  it("POST /tasks/bulk stamps accountId from the caller", async () => {
    const res = await app.request("/tasks/bulk", {
      method: "POST",
      headers: auth(tokens.b),
      body: JSON.stringify([
        { id: "BULK-1", title: "1", status: "pending", repo: SHARED_REPO },
        { id: "BULK-2", title: "2", status: "pending", repo: SHARED_REPO },
      ]),
    });
    expect(res.status).toBe(200);
    const rows = await prisma.task.findMany({
      where: { id: { in: ["BULK-1", "BULK-2"] } },
    });
    expect(rows.map((r) => r.accountId)).toEqual([ACCT_B, ACCT_B]);
  });

  it("a task id collision returns the same generic 409 whether the id is in the caller's account or another", async () => {
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: auth(tokens.a),
        body: JSON.stringify(body),
      });
    const task = (id: string) => ({
      id,
      title: id,
      status: "pending",
      repo: SHARED_REPO,
    });

    const responses = [
      await post("/tasks", task("A-1")), // own account
      await post("/tasks", task("B-1")), // other account
      await post("/tasks/bulk", [task("A-1")]),
      await post("/tasks/bulk", [task("FRESH"), task("B-1")]),
    ];
    for (const res of responses) {
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "task id unavailable" });
    }
    // Bulk stays all-or-nothing.
    expect(await prisma.task.findUnique({ where: { id: "FRESH" } })).toBeNull();
  });

  it("an agent token cannot move a task to another account via PATCH", async () => {
    const res = await app.request("/tasks/A-1", {
      method: "PATCH",
      headers: auth(tokens.a),
      body: JSON.stringify({ accountId: ACCT_B }),
    });
    expect(res.status).toBe(400);
    const a1 = await prisma.task.findUnique({ where: { id: "A-1" } });
    expect(a1?.accountId).toBe(ACCT_A);
  });
});
