/**
 * task-store/src/task-claim-status-invariant.integration.test.ts
 *
 * Integration tests for the DB-level CHECK constraint added by migration
 * 20260831000000_add_task_pending_claimed_by_invariant, which enforces:
 *
 *   status = 'pending' iff claimedBy IS NULL
 *
 * A prior bug (AGH-3.4) left a Task stuck with status='pending' but a
 * non-null claimedBy. An app-level guard already tightened
 * TaskService.claim()'s WHERE clause (PR #2528, commit 0c2f7a7c) to also
 * require claimedBy IS NULL, but that does not prevent every write path
 * (e.g. a manual admin PATCH, or a different future code path) from writing
 * the invalid shape. These tests bypass the Prisma client / TaskService
 * entirely and issue raw SQL directly, to prove the DB-level constraint
 * independently blocks the invariant-violating shape even if application
 * code is buggy or bypassed.
 *
 * Also exercises TaskService.unblock() (UNB-1.1) against a real DB: its
 * atomic conditional UPDATE (WHERE status='blocked') clears claimedBy back
 * to NULL in the same statement that flips status to 'pending', so the
 * resulting row must satisfy this same CHECK constraint — proving the new
 * write path composes correctly with the pre-existing invariant rather than
 * relying on the app-level guard alone.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { TaskService } from "./task-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createPrismaClient(TEST_DB as string);
}

describeOrSkip("Task pending/claimedBy DB invariant (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    // PullRequestEvent's FK is ON DELETE RESTRICT (PSA-1.2) — clear event
    // rows before their parent PullRequest rows, in case another test file
    // sharing TEST_DB left rows behind. TaskEvent's FK is ON DELETE RESTRICT
    // too (TCS-1.1) — same reasoning applies to Task rows (TCS-1.2).
    await prisma.pullRequestEvent.deleteMany();
    await prisma.pullRequest.deleteMany();
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
  });

  afterEach(async () => {
    // TaskEvent's FK is ON DELETE RESTRICT (TCS-1.1) — the UNB-1.1 unblock()
    // case below goes through the real TaskService (not raw SQL like the
    // other cases in this file), so it writes TaskEvent audit rows that must
    // be cleared before their parent Task row, same ordering as beforeEach.
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    await prisma.$disconnect();
  });

  it("rejects an UPDATE that simulates AGH-3.4 (status=pending, claimedBy set on a previously-clean row)", async () => {
    await prisma.task.create({
      data: { id: "t-agh34", title: "stuck pending claim", status: "pending" },
    });

    let error: unknown;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "Task" SET "claimedBy" = 'some-agent' WHERE "id" = 't-agh34';`,
      );
    } catch (e) {
      error = e;
    }
    expect(String(error)).toContain("task_pending_claimed_by_invariant");
  });

  it("rejects an INSERT with status=pending and a non-null claimedBy", async () => {
    let error: unknown;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Task" ("id","title","status","claimedBy","updatedAt")
         VALUES ('t-bad-insert', 'bad insert', 'pending', 'some-agent', now());`,
      );
    } catch (e) {
      error = e;
    }
    expect(String(error)).toContain("task_pending_claimed_by_invariant");
  });

  it("allows a normal pending row with claimedBy null", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Task" ("id","title","status","claimedBy","updatedAt")
       VALUES ('t-ok-pending', 'ok pending', 'pending', NULL, now());`,
    );

    const task = await prisma.task.findUniqueOrThrow({
      where: { id: "t-ok-pending" },
    });
    expect(task.status).toBe("pending");
    expect(task.claimedBy).toBeNull();
  });

  it("allows a normal in_progress row with claimedBy set", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Task" ("id","title","status","claimedBy","updatedAt")
       VALUES ('t-ok-claimed', 'ok claimed', 'in_progress', 'some-agent', now());`,
    );

    const task = await prisma.task.findUniqueOrThrow({
      where: { id: "t-ok-claimed" },
    });
    expect(task.status).toBe("in_progress");
    expect(task.claimedBy).toBe("some-agent");
  });

  it("TaskService.unblock()'s atomic UPDATE (status=blocked -> pending, claimedBy cleared) satisfies the invariant against a real DB (UNB-1.1)", async () => {
    await prisma.task.create({
      data: {
        id: "t-unb11-real-db",
        title: "blocked task, real claim",
        status: "blocked",
        claimedBy: "some-agent",
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        blockedAt: new Date().toISOString(),
        blockedReason: "spun out",
        skipCount: 3,
        lastSkippedAt: new Date().toISOString(),
      },
    });

    const service = new TaskService(prisma);
    const result = await service.unblock("t-unb11-real-db");

    expect(result.status).toBe("pending");
    expect(result.claimedBy).toBeNull();
    expect(result.blockedReason).toBeNull();
    expect(result.blockedAt).toBeNull();
    expect(result.skipCount).toBe(0);
    expect(result.lastSkippedAt).toBeNull();

    // Re-read from the DB directly to confirm the row genuinely satisfies
    // the CHECK constraint (status='pending' iff claimedBy IS NULL) —
    // TaskService.unblock()'s single UPDATE statement did not need two
    // round-trips to land in a constraint-satisfying state.
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: "t-unb11-real-db" },
    });
    expect(task.status).toBe("pending");
    expect(task.claimedBy).toBeNull();
  });
});
