/**
 * task-store/src/session-planning-lock.integration.test.ts
 *
 * Integration tests (real Postgres) for PLU-2.4 planning-lock semantics, using
 * an injected clock. Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; skips
 * otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Clock } from "./clock.ts";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { PLANNING_LOCK_TTL_MS, SessionService } from "./session-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("session planning lock (integration)", () => {
  let prisma: PrismaClient;
  let sessions: SessionService;
  let nowMs: number;
  const clock: Clock = { now: () => new Date(nowMs) };

  beforeEach(async () => {
    nowMs = Date.parse("2026-11-17T10:00:00.000Z");
    prisma = createPrismaClient(TEST_DB as string);
    sessions = new SessionService(prisma, clock);
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    await prisma.planDocument.deleteMany();
    await prisma.session.deleteMany();
    await prisma.session.create({ data: { slug: "s1", accountId: "default" } });
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("a second acquire on a held lock is refused with the holder and time taken", async () => {
    const first = await sessions.acquirePlanningLock("s1", "pass-a");
    expect(first.acquiredAt.toISOString()).toBe("2026-11-17T10:00:00.000Z");

    nowMs += 60_000;
    const err = await sessions
      .acquirePlanningLock("s1", "pass-b")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    const details = (err as ConflictError).details;
    expect(details?.holder).toBe("pass-a");
    expect(details?.acquiredAt).toBe("2026-11-17T10:00:00.000Z");
    expect((err as ConflictError).message).toContain("pass-a");
  });

  it("an expired lock can be re-acquired", async () => {
    await sessions.acquirePlanningLock("s1", "pass-a");
    nowMs += PLANNING_LOCK_TTL_MS; // expiry is inclusive: now >= expiresAt
    const second = await sessions.acquirePlanningLock("s1", "pass-b");
    expect(second.holder).toBe("pass-b");
    const row = await prisma.session.findFirst({ where: { slug: "s1" } });
    expect(row?.planningLockHolder).toBe("pass-b");
  });

  it("the holder re-acquiring extends its own lock", async () => {
    await sessions.acquirePlanningLock("s1", "pass-a");
    nowMs += 60_000;
    const again = await sessions.acquirePlanningLock("s1", "pass-a");
    expect(again.expiresAt.getTime()).toBe(nowMs + PLANNING_LOCK_TTL_MS);
  });

  it("release by the holder clears the lock; by someone else is refused", async () => {
    await sessions.acquirePlanningLock("s1", "pass-a");
    await expect(
      sessions.releasePlanningLock("s1", "pass-b"),
    ).rejects.toBeInstanceOf(ForbiddenError);
    let row = await prisma.session.findFirst({ where: { slug: "s1" } });
    expect(row?.planningLockHolder).toBe("pass-a");

    await sessions.releasePlanningLock("s1", "pass-a");
    row = await prisma.session.findFirst({ where: { slug: "s1" } });
    expect(row?.planningLockHolder).toBeNull();
    expect(row?.planningLockExpiresAt).toBeNull();
    await sessions.acquirePlanningLock("s1", "pass-b");
  });

  it("releasing a free or expired lock is a no-op", async () => {
    await sessions.releasePlanningLock("s1", "anyone");
    await sessions.acquirePlanningLock("s1", "pass-a");
    nowMs += PLANNING_LOCK_TTL_MS + 1;
    await sessions.releasePlanningLock("s1", "pass-b");
  });

  it("an unknown session is NotFound; locks are account-scoped", async () => {
    await expect(
      sessions.acquirePlanningLock("nope", "pass-a"),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      sessions.releasePlanningLock("nope", "pass-a"),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      sessions.acquirePlanningLock("s1", "pass-a", "other-account"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
