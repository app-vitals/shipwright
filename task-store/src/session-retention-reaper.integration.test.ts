/**
 * task-store/src/session-retention-reaper.integration.test.ts
 *
 * Integration tests for SessionRetentionReaper against a real Postgres DB
 * (SESH-8.1). Archive is a multi-row scan (one Session.findMany + one
 * Task.findMany per candidate) plus a conditional update — no meaningful
 * pure-logic unit-test surface separate from the DB, so this is the only
 * test file for this reaper (mirrors the "Test decision" in the SESH-8.1
 * brief).
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { FixedClock } from "./clock.ts";
import { SessionRetentionReaper } from "./session-retention-reaper.ts";
import { SessionService } from "./session-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: TEST_DB as string } },
  });
}

/**
 * Wraps a real PrismaClient so that `session.update()` rejects whenever it's
 * called for `failSlug`, while every other call (including updates for other
 * slugs) passes through to the real client untouched. Used by the AC5 "one
 * failing session must not abort the sweep" test below to simulate a bad
 * row — sweep() loops over candidate sessions and issues one
 * `session.update()` per session, so injecting a fault at that exact call
 * site (rather than e.g. a real DB constraint violation, which would be
 * awkward to provoke on a schema this permissive) is the most direct way to
 * prove one session's failure doesn't abort the others in the same sweep().
 */
function withFaultyUpdate(real: PrismaClient, failSlug: string): PrismaClient {
  const originalUpdate = real.session.update.bind(real.session);
  const faultySession = new Proxy(real.session, {
    get(target, prop, receiver) {
      if (prop === "update") {
        return (args: Parameters<typeof real.session.update>[0]) => {
          if (args.where.slug === failSlug) {
            return Promise.reject(
              new Error(`simulated DB fault archiving "${failSlug}"`),
            );
          }
          return originalUpdate(args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "session") return faultySession;
      return Reflect.get(target, prop, receiver);
    },
  }) as PrismaClient;
}

describeOrSkip("SessionRetentionReaper.sweep() (integration)", () => {
  const NOW = new Date("2026-09-01T12:00:00.000Z");
  const DAY_MS = 24 * 60 * 60 * 1000;
  const ARCHIVE_AFTER_DAYS = 30;

  const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

  let prisma: PrismaClient;
  let sessionService: SessionService;

  beforeEach(async () => {
    prisma = makePrisma();
    sessionService = new SessionService(prisma);
    // TaskEvent's FK is ON DELETE RESTRICT — clear it before Task rows.
    // Session has no FK relations pointing at it, so it can be cleared
    // independently.
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    await prisma.session.deleteMany();
  });

  function makeReaper(
    prismaClient: PrismaClient = prisma,
  ): SessionRetentionReaper {
    return new SessionRetentionReaper(
      prismaClient,
      sessionService,
      FixedClock(NOW),
      { archiveAfterDays: ARCHIVE_AFTER_DAYS },
    );
  }

  // ─── AC1 ────────────────────────────────────────────────────────────────────

  it("(AC1) archives a session whose tasks are all terminal with last activity 31 days ago", async () => {
    await prisma.session.create({ data: { slug: "sess-31-days" } });
    await prisma.task.create({
      data: {
        title: "old terminal task",
        status: "done",
        session: "sess-31-days",
        updatedAt: daysAgo(31),
      },
    });

    const reaper = makeReaper();
    const archived = await reaper.sweep();

    expect(archived).toBe(1);
    const row = await prisma.session.findUniqueOrThrow({
      where: { slug: "sess-31-days" },
    });
    expect(row.archivedAt).not.toBeNull();
    expect(row.archivedBy).toBe("system");
  });

  it("(AC1) does not archive a session whose last activity is only 29 days ago", async () => {
    await prisma.session.create({ data: { slug: "sess-29-days" } });
    await prisma.task.create({
      data: {
        title: "recent-ish terminal task",
        status: "done",
        session: "sess-29-days",
        updatedAt: daysAgo(29),
      },
    });

    const reaper = makeReaper();
    const archived = await reaper.sweep();

    expect(archived).toBe(0);
    const row = await prisma.session.findUniqueOrThrow({
      where: { slug: "sess-29-days" },
    });
    expect(row.archivedAt).toBeNull();
    expect(row.archivedBy).toBeNull();
  });

  it("(AC1) never archives a session with an open task, regardless of age", async () => {
    await prisma.session.create({ data: { slug: "sess-open-task" } });
    await prisma.task.create({
      data: {
        title: "ancient open task",
        status: "pending",
        session: "sess-open-task",
        updatedAt: daysAgo(400),
      },
    });
    await prisma.task.create({
      data: {
        title: "ancient terminal sibling",
        status: "done",
        session: "sess-open-task",
        updatedAt: daysAgo(400),
      },
    });

    const reaper = makeReaper();
    const archived = await reaper.sweep();

    expect(archived).toBe(0);
    const row = await prisma.session.findUniqueOrThrow({
      where: { slug: "sess-open-task" },
    });
    expect(row.archivedAt).toBeNull();
  });

  it("(AC1) never archives a session with zero tasks (counts.total === 0)", async () => {
    await prisma.session.create({ data: { slug: "sess-phantom" } });

    const reaper = makeReaper();
    const archived = await reaper.sweep();

    expect(archived).toBe(0);
    const row = await prisma.session.findUniqueOrThrow({
      where: { slug: "sess-phantom" },
    });
    expect(row.archivedAt).toBeNull();
  });

  // ─── AC2 ────────────────────────────────────────────────────────────────────

  it("(AC2) a perpetual cron-owned session stays un-archived while its cadence keeps lastActivityAt recent", async () => {
    await prisma.session.create({ data: { slug: "sess-cron-owned" } });
    // A long tail of old, terminal tasks the session has accumulated...
    await prisma.task.create({
      data: {
        title: "cron run 1",
        status: "done",
        session: "sess-cron-owned",
        updatedAt: daysAgo(90),
      },
    });
    await prisma.task.create({
      data: {
        title: "cron run 2",
        status: "done",
        session: "sess-cron-owned",
        updatedAt: daysAgo(60),
      },
    });
    // ...but the cadence continues: yesterday's run is also already terminal
    // (cron tasks complete same-day) and keeps lastActivityAt recent.
    await prisma.task.create({
      data: {
        title: "cron run today",
        status: "done",
        session: "sess-cron-owned",
        updatedAt: daysAgo(1),
      },
    });

    const reaper = makeReaper();
    const archived = await reaper.sweep();

    expect(archived).toBe(0);
    const row = await prisma.session.findUniqueOrThrow({
      where: { slug: "sess-cron-owned" },
    });
    expect(row.archivedAt).toBeNull();
  });

  // ─── AC3 ────────────────────────────────────────────────────────────────────

  it("(AC3, SES-1.2) a task write un-archives a session, and the next sweep does not re-archive it while that task is open", async () => {
    // Simulate a session that was archived by a prior sweep.
    await prisma.session.create({
      data: {
        slug: "sess-reactivated",
        archivedAt: daysAgo(5),
        archivedBy: "system",
      },
    });
    await prisma.task.create({
      data: {
        title: "old terminal task from before archival",
        status: "done",
        session: "sess-reactivated",
        updatedAt: daysAgo(40),
      },
    });

    // A new task write into the session un-archives it (mirrors what
    // TaskService.create() does inside its transaction).
    await sessionService.upsert(prisma, "sess-reactivated");
    await prisma.task.create({
      data: {
        title: "brand new open task",
        status: "in_progress",
        session: "sess-reactivated",
        updatedAt: daysAgo(0),
      },
    });

    const reactivated = await prisma.session.findUniqueOrThrow({
      where: { slug: "sess-reactivated" },
    });
    expect(reactivated.archivedAt).toBeNull();

    const reaper = makeReaper();
    const archived = await reaper.sweep();

    expect(archived).toBe(0);
    const row = await prisma.session.findUniqueOrThrow({
      where: { slug: "sess-reactivated" },
    });
    expect(row.archivedAt).toBeNull();
  });

  // ─── AC5 ────────────────────────────────────────────────────────────────────

  it("(AC5) one failing session does not abort the sweep — other candidates still archive in the same call", async () => {
    await prisma.session.create({ data: { slug: "sess-good" } });
    await prisma.task.create({
      data: {
        title: "good terminal task",
        status: "done",
        session: "sess-good",
        updatedAt: daysAgo(31),
      },
    });

    await prisma.session.create({ data: { slug: "sess-bad" } });
    await prisma.task.create({
      data: {
        title: "bad terminal task",
        status: "done",
        session: "sess-bad",
        updatedAt: daysAgo(31),
      },
    });

    const faultyPrisma = withFaultyUpdate(prisma, "sess-bad");
    const reaper = makeReaper(faultyPrisma);

    const archived = await reaper.sweep();

    // Only the good session archived; the bad one's update failed and was
    // caught, but sweep() itself did not throw and did not stop early.
    expect(archived).toBe(1);

    const good = await prisma.session.findUniqueOrThrow({
      where: { slug: "sess-good" },
    });
    expect(good.archivedAt).not.toBeNull();
    expect(good.archivedBy).toBe("system");

    const bad = await prisma.session.findUniqueOrThrow({
      where: { slug: "sess-bad" },
    });
    expect(bad.archivedAt).toBeNull();
  });

  // ─── Disabled via env var = 0 ────────────────────────────────────────────────

  it("archiveAfterDays === 0 disables the sweep entirely", async () => {
    await prisma.session.create({ data: { slug: "sess-would-archive" } });
    await prisma.task.create({
      data: {
        title: "very old terminal task",
        status: "done",
        session: "sess-would-archive",
        updatedAt: daysAgo(400),
      },
    });

    const reaper = new SessionRetentionReaper(
      prisma,
      sessionService,
      FixedClock(NOW),
      { archiveAfterDays: 0 },
    );
    const archived = await reaper.sweep();

    expect(archived).toBe(0);
    const row = await prisma.session.findUniqueOrThrow({
      where: { slug: "sess-would-archive" },
    });
    expect(row.archivedAt).toBeNull();
  });
});
