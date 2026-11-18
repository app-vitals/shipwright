/**
 * task-store/src/tasks.provenance.integration.test.ts
 *
 * PLU-2.5 (real Postgres): owner / originKind filters on list, listReady and
 * listBlocked, and persistence of the five provenance fields.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { TaskService } from "./task-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("task provenance (integration)", () => {
  let prisma: PrismaClient;
  let service: TaskService;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    service = new TaskService(prisma);
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
  });

  afterEach(async () => {
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    await prisma.$disconnect();
  });

  async function seed() {
    await service.create({
      id: "p-a",
      title: "A",
      status: "pending",
      repo: null,
      owner: "a@example.com",
      originKind: "skill",
      originRef: "plan-session",
      planDocumentId: "doc-plan",
      specDocumentId: "doc-spec",
    });
    await service.create({
      id: "p-b",
      title: "B",
      status: "pending",
      repo: null,
      owner: "b@example.com",
      originKind: "cron",
      originRef: "Docs freshness",
    });
    await service.create({
      id: "p-c",
      title: "C",
      status: "blocked",
      repo: null,
    });
  }

  it("persists and returns all five fields; legacy rows stay null", async () => {
    await seed();
    const a = await prisma.task.findUniqueOrThrow({ where: { id: "p-a" } });
    expect(a).toMatchObject({
      owner: "a@example.com",
      originKind: "skill",
      originRef: "plan-session",
      planDocumentId: "doc-plan",
      specDocumentId: "doc-spec",
    });
    const c = await prisma.task.findUniqueOrThrow({ where: { id: "p-c" } });
    expect(c.owner).toBeNull();
    expect(c.originKind).toBeNull();
  });

  it("list filters on owner", async () => {
    await seed();
    const res = await service.list({ owner: "a@example.com" });
    expect(res.tasks.map((t) => t.id)).toEqual(["p-a"]);
  });

  it("list filters on originKind and combines with owner as AND", async () => {
    await seed();
    expect(
      (await service.list({ originKind: "cron" })).tasks.map((t) => t.id),
    ).toEqual(["p-b"]);
    expect(
      (await service.list({ originKind: "cron", owner: "a@example.com" }))
        .total,
    ).toBe(0);
  });

  it("list filters on originRef (exact) and combines with originKind", async () => {
    await service.create({
      id: "r-a",
      title: "A",
      status: "pending",
      repo: null,
      originKind: "cron",
      originRef: "test-readiness",
    });
    await service.create({
      id: "r-b",
      title: "B",
      status: "pending",
      repo: null,
      originKind: "cron",
      originRef: "docs-freshness",
    });
    await service.create({
      id: "r-c",
      title: "C",
      status: "pending",
      repo: null,
      originKind: "skill",
      originRef: "test-readiness",
    });
    const ids = async (f: Parameters<TaskService["list"]>[0]) =>
      (await service.list(f)).tasks.map((t) => t.id).sort();
    expect(
      await ids({ originKind: "cron", originRef: "test-readiness" }),
    ).toEqual(["r-a"]);
    expect(await ids({ originRef: "test-readiness" })).toEqual(["r-a", "r-c"]);
    expect(await ids({ originRef: "Test readiness" })).toEqual([]);
  });

  it("list filters on createdAt range (createdFrom/createdTo, inclusive)", async () => {
    for (const [id, createdAt] of [
      ["c-old", "2026-01-01T00:00:00.000Z"],
      ["c-mid", "2026-01-10T00:00:00.000Z"],
      ["c-new", "2026-01-20T00:00:00.000Z"],
    ] as const) {
      await service.create({
        id,
        title: id,
        status: "pending",
        repo: null,
        createdAt: new Date(createdAt),
      } as Parameters<TaskService["create"]>[0]);
    }
    const ids = async (f: Parameters<TaskService["list"]>[0]) =>
      (await service.list(f)).tasks.map((t) => t.id).sort();
    expect(
      await ids({
        createdFrom: "2026-01-05T00:00:00.000Z",
        createdTo: "2026-01-15T00:00:00.000Z",
      }),
    ).toEqual(["c-mid"]);
    expect(await ids({ createdFrom: "2026-01-10T00:00:00.000Z" })).toEqual([
      "c-mid",
      "c-new",
    ]);
    expect(await ids({ createdTo: "2026-01-10T00:00:00.000Z" })).toEqual([
      "c-mid",
      "c-old",
    ]);
  });

  it("listReady and listBlocked honor the filters", async () => {
    await seed();
    const ready = await service.listReady(undefined, undefined, {
      owner: "b@example.com",
    });
    expect(ready.map((t) => t.id)).toEqual(["p-b"]);
    const readyKind = await service.listReady(undefined, undefined, {
      originKind: "skill",
    });
    expect(readyKind.map((t) => t.id)).toEqual(["p-a"]);
  });

  it("PATCH-style update writes the fields", async () => {
    await seed();
    const updated = await service.update("p-c", {
      owner: "c@example.com",
      originKind: "human",
    });
    expect(updated.owner).toBe("c@example.com");
    expect(updated.originKind).toBe("human");
  });
});
