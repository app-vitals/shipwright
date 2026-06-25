/**
 * task-store/src/api.integration.test.ts
 *
 * Integration tests for the task-store HTTP service against a real Postgres DB.
 * Drives the Hono app via `app.request()` with real TaskService / TaskTokenService
 * wired to a real PrismaClient.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; the suite skips otherwise.
 *
 * Covers:
 *   - Full lifecycle: claim → heartbeat → complete
 *   - Full lifecycle: claim → fail
 *   - Full lifecycle: claim → release (verifies claim fields reset to null)
 *   - Concurrent claim: exactly one 200, one 409
 *   - GET /tasks?ready=true returns only eligible (pending + deps satisfied) tasks
 *   - Auth rejection (missing / invalid / revoked tokens)
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import { PrismaClient } from "./index.ts";
import { TaskService } from "./task-service.ts";
import { TaskTokenService } from "./token-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: TEST_DB as string } },
  });
}

describeOrSkip("task-store API (integration)", () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof createTaskStoreApp>;
  let rawToken: string;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.taskToken.deleteMany();
    await prisma.task.deleteMany();

    const taskService = new TaskService(prisma);
    const tokenService = new TaskTokenService(prisma);
    const created = await tokenService.create("integration");
    rawToken = created.rawToken;

    app = createTaskStoreApp({ taskService, tokenService });
  });

  function auth(token = rawToken): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
  }

  async function createPendingTask(title = "T"): Promise<string> {
    const res = await app.request("/tasks", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ title, status: "pending" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  it("rejects requests with no token (401)", async () => {
    const res = await app.request("/tasks");
    expect(res.status).toBe(401);
  });

  it("rejects requests with an invalid token (401)", async () => {
    const res = await app.request("/tasks", {
      headers: { Authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with a revoked token (401)", async () => {
    const tokenService = new TaskTokenService(prisma);
    const { token, rawToken: revokedRaw } = await tokenService.create("temp");
    await tokenService.revoke(token.id);
    const res = await app.request("/tasks", {
      headers: { Authorization: `Bearer ${revokedRaw}` },
    });
    expect(res.status).toBe(401);
  });

  // ─── Lifecycle: claim → heartbeat → complete ───────────────────────────────

  it("supports claim → heartbeat → complete", async () => {
    const id = await createPendingTask();

    const claim = await app.request(`/tasks/${id}/claim`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ claimedBy: "agent-a" }),
    });
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()) as {
      status: string;
      claimedBy: string;
      claimedAt: string;
      heartbeatAt: string;
    };
    expect(claimed.status).toBe("in_progress");
    expect(claimed.claimedBy).toBe("agent-a");
    expect(claimed.claimedAt).not.toBeNull();
    expect(claimed.heartbeatAt).not.toBeNull();

    const heartbeat = await app.request(`/tasks/${id}/heartbeat`, {
      method: "POST",
      headers: auth(),
    });
    expect(heartbeat.status).toBe(200);
    const beat = (await heartbeat.json()) as { heartbeatAt: string };
    expect(beat.heartbeatAt).not.toBeNull();

    const complete = await app.request(`/tasks/${id}/complete`, {
      method: "POST",
      headers: auth(),
    });
    expect(complete.status).toBe(200);
    const done = (await complete.json()) as {
      status: string;
      completedAt: string;
    };
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
  });

  // ─── Lifecycle: claim → fail ───────────────────────────────────────────────

  it("supports claim → fail", async () => {
    const id = await createPendingTask();
    await app.request(`/tasks/${id}/claim`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ claimedBy: "agent-a" }),
    });

    const fail = await app.request(`/tasks/${id}/fail`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ reason: "boom" }),
    });
    expect(fail.status).toBe(200);
    const failed = (await fail.json()) as {
      status: string;
      blockedReason: string | null;
    };
    expect(failed.status).toBe("blocked");
  });

  // ─── Lifecycle: claim → release ────────────────────────────────────────────

  it("supports claim → release and resets claim fields to null", async () => {
    const id = await createPendingTask();
    await app.request(`/tasks/${id}/claim`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ claimedBy: "agent-a" }),
    });

    const release = await app.request(`/tasks/${id}/release`, {
      method: "POST",
      headers: auth(),
    });
    expect(release.status).toBe(200);
    const released = (await release.json()) as {
      status: string;
      claimedBy: string | null;
      claimedAt: string | null;
      heartbeatAt: string | null;
    };
    expect(released.status).toBe("pending");
    expect(released.claimedBy).toBeNull();
    expect(released.claimedAt).toBeNull();
    expect(released.heartbeatAt).toBeNull();
  });

  // ─── Concurrent claim ──────────────────────────────────────────────────────

  it("allows exactly one of two concurrent claims (one 200, one 409)", async () => {
    const id = await createPendingTask();

    const [a, b] = await Promise.all([
      app.request(`/tasks/${id}/claim`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ claimedBy: "agent-a" }),
      }),
      app.request(`/tasks/${id}/claim`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ claimedBy: "agent-b" }),
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("returns 409 when claiming an already-claimed task", async () => {
    const id = await createPendingTask();
    await app.request(`/tasks/${id}/claim`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ claimedBy: "agent-a" }),
    });
    const second = await app.request(`/tasks/${id}/claim`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ claimedBy: "agent-b" }),
    });
    expect(second.status).toBe(409);
  });

  it("returns 404 when claiming a task that does not exist", async () => {
    const res = await app.request("/tasks/does-not-exist/claim", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ claimedBy: "agent-a" }),
    });
    expect(res.status).toBe(404);
  });

  // ─── List response shape ───────────────────────────────────────────────────

  it("GET /tasks returns { tasks, total, limit, offset }", async () => {
    await createPendingTask("A");
    await createPendingTask("B");
    const res = await app.request("/tasks", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.total).toBe(2);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  // ─── ?state filter ─────────────────────────────────────────────────────────

  it("GET /tasks?state=open returns only active statuses", async () => {
    await createPendingTask("open-task");
    await prisma.task.create({ data: { title: "done-task", status: "done" } });
    await prisma.task.create({
      data: { title: "cancelled-task", status: "cancelled" },
    });

    const res = await app.request("/tasks?state=open", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: Array<{ title: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.tasks.map((t) => t.title)).toContain("open-task");
    expect(body.tasks.map((t) => t.title)).not.toContain("done-task");
  });

  it("GET /tasks?state=closed returns only terminal statuses", async () => {
    await createPendingTask("open-task");
    await prisma.task.create({
      data: { title: "merged-task", status: "merged" },
    });
    await prisma.task.create({
      data: { title: "deployed-task", status: "deployed" },
    });

    const res = await app.request("/tasks?state=closed", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: Array<{ title: string }>;
      total: number;
    };
    expect(body.total).toBe(2);
    const titles = body.tasks.map((t) => t.title);
    expect(titles).toContain("merged-task");
    expect(titles).toContain("deployed-task");
    expect(titles).not.toContain("open-task");
  });

  // ─── Pagination ────────────────────────────────────────────────────────────

  it("GET /tasks?limit=2&offset=0 returns first page", async () => {
    await createPendingTask("T1");
    await createPendingTask("T2");
    await createPendingTask("T3");

    const res = await app.request("/tasks?limit=2&offset=0", {
      headers: auth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.total).toBe(3);
    expect(body.tasks.length).toBe(2);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
  });

  it("GET /tasks?limit=2&offset=2 returns second page", async () => {
    await createPendingTask("T1");
    await createPendingTask("T2");
    await createPendingTask("T3");

    const res = await app.request("/tasks?limit=2&offset=2", {
      headers: auth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.total).toBe(3);
    expect(body.tasks.length).toBe(1);
    expect(body.offset).toBe(2);
  });

  // ─── ready=true filter ─────────────────────────────────────────────────────

  it("GET /tasks?ready=true returns only pending tasks with satisfied deps", async () => {
    // dep is merged → satisfied
    const dep = await prisma.task.create({
      data: { title: "dep", status: "merged" },
    });
    // ready: pending + dep satisfied
    const ready = await prisma.task.create({
      data: { title: "ready", status: "pending", dependencies: [dep.id] },
    });
    // blocked: pending but dep is still pending (not satisfied)
    const blockingDep = await prisma.task.create({
      data: { title: "blockingDep", status: "pending" },
    });
    await prisma.task.create({
      data: {
        title: "blocked",
        status: "pending",
        dependencies: [blockingDep.id],
      },
    });
    // not pending → excluded
    await prisma.task.create({
      data: { title: "inprog", status: "in_progress" },
    });

    const res = await app.request("/tasks?ready=true", { headers: auth() });
    expect(res.status).toBe(200);
    const tasks = (await res.json()) as Array<{ id: string; title: string }>;
    const ids = tasks.map((t) => t.id);
    // ready task qualifies; blockingDep is pending with no deps → also ready.
    expect(ids).toContain(ready.id);
    expect(ids).toContain(blockingDep.id);
    // the "blocked" task must NOT appear
    const titles = tasks.map((t) => t.title);
    expect(titles).not.toContain("blocked");
    expect(titles).not.toContain("inprog");
  });

  // ─── Token update route ────────────────────────────────────────────────────

  it("PATCH /tokens/:id updates label and agentId", async () => {
    const create = await app.request("/tokens", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ label: "original", agentId: "agent-old" }),
    });
    const { id } = (await create.json()) as { id: string };

    const patch = await app.request(`/tokens/${id}`, {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ label: "updated", agentId: "agent-new" }),
    });
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as {
      id: string;
      label: string | null;
      agentId: string | null;
      rawToken?: string;
    };
    expect(body.id).toBe(id);
    expect(body.label).toBe("updated");
    expect(body.agentId).toBe("agent-new");
    expect(body.rawToken).toBeUndefined();
  });

  // ─── Token revoke route ────────────────────────────────────────────────────

  it("DELETE /tokens/:id revokes a token", async () => {
    const create = await app.request("/tokens", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ label: "to-revoke" }),
    });
    const { id, rawToken: newRaw } = (await create.json()) as {
      id: string;
      rawToken: string;
    };

    const del = await app.request(`/tokens/${id}`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(del.status).toBe(200);

    // The revoked token can no longer authenticate.
    const after = await app.request("/tasks", {
      headers: { Authorization: `Bearer ${newRaw}` },
    });
    expect(after.status).toBe(401);
  });
});
