/**
 * task-store/src/create-blocked.integration.test.ts
 *
 * PCR-1.3: tasks created with status 'blocked' (single and bulk) get blockedAt
 * stamped server-side, are absent from listReady(), and after unblock() are
 * pending, ready, and have blockedReason/blockedAt cleared.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FixedClock } from "./clock.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { TaskService } from "./task-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const NOW = new Date("2026-11-27T12:00:00.000Z");

describeOrSkip("create-as-blocked (integration, PCR-1.3)", () => {
  let prisma: PrismaClient;
  let service: TaskService;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    service = new TaskService(prisma, FixedClock(NOW));
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  const base = (id: string) => ({
    id,
    title: id,
    status: "blocked" as const,
    blockedReason: "needs review",
    repo: "app-vitals/shipwright",
    branch: `feat/${id}`,
  });

  async function readyIds(): Promise<string[]> {
    return (await service.listReady()).map((t) => t.id);
  }

  it("create() stamps blockedAt, hides from ready, and unblock restores it", async () => {
    const task = await service.create(base("PCR-T1"));
    expect(task.status).toBe("blocked");
    expect(task.blockedReason).toBe("needs review");
    expect(task.blockedAt).toBe(NOW.toISOString());
    expect(await readyIds()).not.toContain("PCR-T1");

    const unblocked = await service.unblock("PCR-T1");
    expect(unblocked.status).toBe("pending");
    expect(unblocked.blockedReason).toBeNull();
    expect(unblocked.blockedAt).toBeNull();
    expect(await readyIds()).toContain("PCR-T1");
  });

  it("create() keeps a caller-supplied blockedAt", async () => {
    const task = await service.create({
      ...base("PCR-T2"),
      blockedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(task.blockedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("create() does not stamp blockedAt for non-blocked tasks", async () => {
    const task = await service.create({
      id: "PCR-T3",
      title: "t3",
      repo: "app-vitals/shipwright",
      branch: "feat/t3",
      status: "pending",
    });
    expect(task.blockedAt).toBeNull();
  });

  it("bulk() stamps blockedAt, hides from ready, and unblock restores it", async () => {
    await service.bulk([
      base("PCR-B1"),
      { ...base("PCR-B2"), blockedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const b1 = await prisma.task.findUniqueOrThrow({ where: { id: "PCR-B1" } });
    const b2 = await prisma.task.findUniqueOrThrow({ where: { id: "PCR-B2" } });
    expect(b1.blockedAt).toBe(NOW.toISOString());
    expect(b2.blockedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(await readyIds()).not.toContain("PCR-B1");

    const unblocked = await service.unblock("PCR-B1");
    expect(unblocked.status).toBe("pending");
    expect(unblocked.blockedAt).toBeNull();
    expect(unblocked.blockedReason).toBeNull();
    expect(await readyIds()).toContain("PCR-B1");
  });
});
