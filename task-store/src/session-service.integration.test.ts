/**
 * task-store/src/session-service.integration.test.ts
 *
 * Integration tests for SessionService.upsert() and its wiring into
 * TaskService.create()/bulk() (SESH-1.2), against a real Postgres DB.
 *
 * Covers:
 *   - a task write with a non-blank session creates the Session row
 *   - a second write to the same session does not change createdAt or
 *     overwrite an existing title
 *   - bulk() upserts the Session row the same way as create()
 *   - writing into an archived session clears archivedAt (un-archive)
 *   - session: null / "" / "   " create no Session row at all, and
 *     create()/bulk() still work unchanged for those tasks
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { TaskService } from "./task-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    // TEST_DB is guaranteed set — the describe block is skipped otherwise.
    datasources: { db: { url: TEST_DB as string } },
  });
}

describeOrSkip(
  "SessionService upsert via TaskService.create()/bulk() (integration)",
  () => {
    let prisma: PrismaClient;
    let service: TaskService;

    beforeEach(async () => {
      prisma = makePrisma();
      service = new TaskService(prisma);
      // TaskEvent's FK is ON DELETE RESTRICT (TCS-1.1) — clear event rows
      // before their parent Task rows.
      await prisma.taskEvent.deleteMany();
      await prisma.task.deleteMany();
      await prisma.session.deleteMany();
    });

    afterEach(async () => {
      await prisma.$disconnect();
    });

    // ─── create() ────────────────────────────────────────────────────────────

    it("create() with session: 'x' creates a Session row with slug 'x'", async () => {
      const task = await service.create({
        title: "task with session",
        status: "pending",
        session: "x",
      });
      expect(task.session).toBe("x");

      const row = await prisma.session.findUnique({ where: { slug: "x" } });
      expect(row).not.toBeNull();
      expect(row?.slug).toBe("x");
      expect(row?.title).toBeNull();
      expect(row?.archivedAt).toBeNull();
    });

    it("a second create() into the same session does not change createdAt or overwrite an existing title", async () => {
      // Seed a Session with a title directly — create() has no way to set a
      // title itself, so this simulates a row that was titled some other way.
      const seeded = await prisma.session.create({
        data: { slug: "x", title: "My Session Title" },
      });

      await service.create({
        title: "first task",
        status: "pending",
        session: "x",
      });
      const afterFirst = await prisma.session.findUnique({
        where: { slug: "x" },
      });
      expect(afterFirst?.title).toBe("My Session Title");
      expect(afterFirst?.createdAt.getTime()).toBe(seeded.createdAt.getTime());

      // A second write to the same session must not change createdAt or wipe
      // the title.
      await service.create({
        title: "second task",
        status: "pending",
        session: "x",
      });
      const afterSecond = await prisma.session.findUnique({
        where: { slug: "x" },
      });
      expect(afterSecond?.title).toBe("My Session Title");
      expect(afterSecond?.createdAt.getTime()).toBe(seeded.createdAt.getTime());

      // Exactly one Session row exists for the slug — no duplicate created.
      const count = await prisma.session.count({ where: { slug: "x" } });
      expect(count).toBe(1);
    });

    it("writing a task into an archived session clears archivedAt (un-archive)", async () => {
      const archivedAt = new Date("2026-01-01T00:00:00.000Z");
      await prisma.session.create({
        data: {
          slug: "archived-session",
          archivedAt,
          archivedBy: "someone",
        },
      });

      await service.create({
        title: "revives the session",
        status: "pending",
        session: "archived-session",
      });

      const row = await prisma.session.findUnique({
        where: { slug: "archived-session" },
      });
      expect(row?.archivedAt).toBeNull();
      // archivedBy is untouched by the upsert hook — out of scope for v1.
      expect(row?.archivedBy).toBe("someone");
    });

    // ─── bulk() ───────────────────────────────────────────────────────────────

    it("bulk() with session: 'x' on one or more tasks upserts the Session row", async () => {
      const result = await service.bulk([
        { title: "bulk task 1", status: "pending", session: "bulk-x" },
        { title: "bulk task 2", status: "pending", session: "bulk-x" },
        { title: "bulk task 3", status: "pending", session: "bulk-y" },
      ]);
      expect(result.inserted).toBe(3);
      expect(result.skipped).toEqual([]);

      const rowX = await prisma.session.findUnique({
        where: { slug: "bulk-x" },
      });
      expect(rowX).not.toBeNull();
      const rowY = await prisma.session.findUnique({
        where: { slug: "bulk-y" },
      });
      expect(rowY).not.toBeNull();

      // Only one Session row for "bulk-x" despite two tasks writing into it.
      const countX = await prisma.session.count({
        where: { slug: "bulk-x" },
      });
      expect(countX).toBe(1);
    });

    it("bulk() writing into an archived session clears archivedAt", async () => {
      await prisma.session.create({
        data: { slug: "bulk-archived", archivedAt: new Date() },
      });

      const result = await service.bulk([
        { title: "bulk revive", status: "pending", session: "bulk-archived" },
      ]);
      expect(result.inserted).toBe(1);

      const row = await prisma.session.findUnique({
        where: { slug: "bulk-archived" },
      });
      expect(row?.archivedAt).toBeNull();
    });

    it("bulk()'s per-item P2002 skip semantics are preserved alongside the session upsert", async () => {
      const existing = await service.create({
        id: "dup-id",
        title: "existing task",
        status: "pending",
      });
      expect(existing.id).toBe("dup-id");

      const result = await service.bulk([
        {
          id: "dup-id",
          title: "colliding task",
          status: "pending",
          session: "should-not-exist",
        },
        { title: "fine task", status: "pending", session: "bulk-ok" },
      ]);
      expect(result.inserted).toBe(1);
      expect(result.skipped).toEqual(["dup-id"]);

      // The colliding task's session upsert must not have run (its create()
      // never committed — same transaction as the failed task create()).
      const shouldNotExist = await prisma.session.findUnique({
        where: { slug: "should-not-exist" },
      });
      expect(shouldNotExist).toBeNull();

      // The non-colliding task's session upsert still landed.
      const fine = await prisma.session.findUnique({
        where: { slug: "bulk-ok" },
      });
      expect(fine).not.toBeNull();
    });

    // ─── no-op for blank session ───────────────────────────────────────────────

    it("create() with session: null creates no Session row", async () => {
      const task = await service.create({
        title: "no session",
        status: "pending",
        session: null,
      });
      expect(task.session).toBeNull();
      const count = await prisma.session.count();
      expect(count).toBe(0);
    });

    it("create() with session: '' creates no Session row", async () => {
      const task = await service.create({
        title: "empty session",
        status: "pending",
        session: "",
      });
      expect(task.session).toBe("");
      const count = await prisma.session.count();
      expect(count).toBe(0);
    });

    it("create() with session: '   ' (whitespace-only) creates no Session row", async () => {
      const task = await service.create({
        title: "whitespace session",
        status: "pending",
        session: "   ",
      });
      expect(task.session).toBe("   ");
      const count = await prisma.session.count();
      expect(count).toBe(0);
    });

    it("bulk() with session: null/''/'   ' creates no Session rows and tasks still insert", async () => {
      const result = await service.bulk([
        { title: "bulk null", status: "pending", session: null },
        { title: "bulk empty", status: "pending", session: "" },
        { title: "bulk whitespace", status: "pending", session: "   " },
      ]);
      expect(result.inserted).toBe(3);
      expect(result.skipped).toEqual([]);
      const count = await prisma.session.count();
      expect(count).toBe(0);
    });
  },
);
