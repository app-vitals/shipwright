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
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    // TEST_DB is guaranteed set — the describe block is skipped otherwise.
    datasources: { db: { url: TEST_DB as string } },
  });
}

describeOrSkip("Task pending/claimedBy DB invariant (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    // PullRequestEvent's FK is ON DELETE RESTRICT (PSA-1.2) — clear event
    // rows before their parent PullRequest rows, in case another test file
    // sharing TEST_DB left rows behind.
    await prisma.pullRequestEvent.deleteMany();
    await prisma.pullRequest.deleteMany();
    await prisma.task.deleteMany();
  });

  afterEach(async () => {
    await prisma.task.deleteMany();
    await prisma.$disconnect();
  });

  it("rejects an UPDATE that simulates AGH-3.4 (status=pending, claimedBy set on a previously-clean row)", async () => {
    await prisma.task.create({
      data: { id: "t-agh34", title: "stuck pending claim", status: "pending" },
    });

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Task" SET "claimedBy" = 'some-agent' WHERE "id" = 't-agh34';`,
      ),
    ).rejects.toThrow(/task_pending_claimed_by_invariant/);
  });

  it("rejects an INSERT with status=pending and a non-null claimedBy", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Task" ("id","title","status","claimedBy","updatedAt")
         VALUES ('t-bad-insert', 'bad insert', 'pending', 'some-agent', now());`,
      ),
    ).rejects.toThrow(/task_pending_claimed_by_invariant/);
  });

  it("allows a normal pending row with claimedBy null", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Task" ("id","title","status","claimedBy","updatedAt")
         VALUES ('t-ok-pending', 'ok pending', 'pending', NULL, now());`,
      ),
    ).resolves.not.toThrow();

    const task = await prisma.task.findUniqueOrThrow({
      where: { id: "t-ok-pending" },
    });
    expect(task.status).toBe("pending");
    expect(task.claimedBy).toBeNull();
  });

  it("allows a normal in_progress row with claimedBy set", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Task" ("id","title","status","claimedBy","updatedAt")
         VALUES ('t-ok-claimed', 'ok claimed', 'in_progress', 'some-agent', now());`,
      ),
    ).resolves.not.toThrow();

    const task = await prisma.task.findUniqueOrThrow({
      where: { id: "t-ok-claimed" },
    });
    expect(task.status).toBe("in_progress");
    expect(task.claimedBy).toBe("some-agent");
  });
});
