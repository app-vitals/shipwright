/**
 * task-store/src/tasks.case-insensitive.integration.test.ts
 *
 * STI-1.3: GET/PATCH /tasks/:id resolve ids case-insensitively, and create /
 * bulk writes return 409 (naming the existing id) when a new id differs from
 * an existing one only by case. Backed by STI-1.1's lower(id) unique index.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import { ConflictError } from "./errors.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import type { SessionServiceLike } from "./session-service.ts";
import { TaskService } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;
const TOKEN = "valid-token";

const tokenService: TokenServiceLike = {
  async create() {
    throw new Error("unused");
  },
  async validate(raw: string) {
    return raw === TOKEN ? { id: "tok-1", agentId: null } : null;
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

describeOrSkip("task id case-insensitivity (integration)", () => {
  let prisma: PrismaClient;
  let service: TaskService;
  let app: ReturnType<typeof createTaskStoreApp>;

  const send = (path: string, method: string, payload?: unknown) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    service = new TaskService(prisma);
    app = createTaskStoreApp({
      taskService: service,
      tokenService,
      sessionService: {} as SessionServiceLike,
    });
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    await prisma.task.create({
      data: { id: "SWI-10", title: "legacy", status: "pending", repo: null },
    });
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("GET /tasks/:id matches regardless of case and returns the stored id", async () => {
    const res = await send("/tasks/swi-10", "GET");
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("SWI-10");
  });

  it("PATCH /tasks/:id matches regardless of case and updates the stored row", async () => {
    const res = await send("/tasks/swi-10", "PATCH", { title: "renamed" });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("SWI-10");
    expect(
      (await prisma.task.findUnique({ where: { id: "SWI-10" } }))?.title,
    ).toBe("renamed");
  });

  it("claim and heartbeat resolve ids case-insensitively", async () => {
    const claim = await send("/tasks/swi-10/claim", "POST", {
      claimedBy: "agent-1",
    });
    expect(claim.status).toBe(200);
    expect((await claim.json()).id).toBe("SWI-10");
    const hb = await send("/tasks/Swi-10/heartbeat", "POST");
    expect(hb.status).toBe(200);
  });

  it("lifecycle endpoints write to the stored row on mixed-case ids", async () => {
    await send("/tasks/swi-10/claim", "POST", { claimedBy: "agent-1" });
    const rel = await send("/tasks/sWi-10/release", "POST");
    expect(rel.status).toBe(200);
    expect((await rel.json()).id).toBe("SWI-10");
  });

  it("unknown ids are still 404", async () => {
    expect((await send("/tasks/nope-1", "GET")).status).toBe(404);
  });

  it("bulk rejects a case-only collision with 409 naming the existing id and rolls back the batch", async () => {
    const res = await send("/tasks/bulk", "POST", [
      { id: "NEW-1", title: "ok", status: "pending", repo: null },
      { id: "swi-10", title: "dup", status: "pending", repo: null },
    ]);
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("SWI-10");
    expect(await prisma.task.findUnique({ where: { id: "NEW-1" } })).toBeNull();
    expect(await prisma.task.count()).toBe(1);
  });

  it("service.bulk and service.create throw ConflictError naming the existing id", async () => {
    await expect(
      service.bulk([{ id: "swi-10", title: "dup", status: "pending" }]),
    ).rejects.toThrow(/SWI-10/);
    await expect(
      service.create({ id: "Swi-10", title: "dup", status: "pending" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("exact-id collisions keep returning 409", async () => {
    const res = await send("/tasks/bulk", "POST", [
      { id: "SWI-10", title: "dup", status: "pending", repo: null },
    ]);
    expect(res.status).toBe(409);
  });
});
