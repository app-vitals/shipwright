/**
 * task-store/src/hitl-blocked-migration.integration.test.ts
 *
 * Integration tests for the split-hitl/blocked-signals data migration
 * (20260731000000_split_hitl_blocked_signals). Verifies the three
 * data-migration UPDATE statements preserve the right state when the old
 * hitl signal is split into the task status='blocked' signal and
 * PullRequest.blocked.
 *
 * The migration DROPs Task.hitlNotifiedAt, PullRequest.hitl and
 * PullRequest.hitlNotifiedAt, so those columns no longer exist in the
 * post-migration schema the Prisma client is generated against. To exercise
 * the pre-migration → post-migration transition, this test re-creates the
 * dropped columns via raw SQL, seeds pre-migration-shape rows, runs the exact
 * three UPDATE statements from migration.sql, then asserts the resulting state
 * via the Prisma client (new schema) before dropping the temporary columns.
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

/**
 * Re-create the columns the migration drops so we can seed pre-migration-shape
 * rows. Idempotent (IF NOT EXISTS) so it's safe to call in beforeEach.
 */
async function addOldColumns(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "hitlNotifiedAt" TEXT;',
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PullRequest" ADD COLUMN IF NOT EXISTS "hitl" BOOLEAN NOT NULL DEFAULT false;',
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PullRequest" ADD COLUMN IF NOT EXISTS "hitlNotifiedAt" TEXT;',
  );
}

/** Drop the temporary pre-migration columns again to restore the post-migration shape. */
async function dropOldColumns(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "Task" DROP COLUMN IF EXISTS "hitlNotifiedAt";',
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PullRequest" DROP COLUMN IF EXISTS "hitl";',
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PullRequest" DROP COLUMN IF EXISTS "hitlNotifiedAt";',
  );
}

/** Run the exact three data-migration UPDATE statements from migration.sql. */
async function runDataMigration(prisma: PrismaClient): Promise<void> {
  // 1. Clear hitl on records that were pipeline-escalation/spin-detection.
  await prisma.$executeRawUnsafe(
    'UPDATE "Task" SET "hitl" = false WHERE "hitl" = true AND "blockedReason" IS NOT NULL;',
  );
  // 2. Move any still-open ones onto the new blocked-status signal.
  await prisma.$executeRawUnsafe(
    `UPDATE "Task" SET "status" = 'blocked'
     WHERE "hitl" = false AND "blockedReason" IS NOT NULL
       AND "status" NOT IN ('merged','done','deploying','deployed','cancelled');`,
  );
  // 3. Carry forward only still-open PRs.
  await prisma.$executeRawUnsafe(
    `UPDATE "PullRequest" SET "blocked" = true WHERE "hitl" = true AND "state" = 'open';`,
  );
}

describeOrSkip("split-hitl/blocked data migration (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.pullRequest.deleteMany();
    await prisma.task.deleteMany();
    await addOldColumns(prisma);
  });

  afterEach(async () => {
    await dropOldColumns(prisma);
    await prisma.$disconnect();
  });

  it("a hitl:true + non-null blockedReason task with non-terminal status ends up status:blocked, hitl:false", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Task" ("id","title","status","hitl","blockedReason","hitlNotifiedAt","updatedAt")
       VALUES ('t-open', 'open escalated', 'in_progress', true, 'spin detected', NULL, now());`,
    );

    await runDataMigration(prisma);

    const task = await prisma.task.findUniqueOrThrow({
      where: { id: "t-open" },
    });
    expect(task.status).toBe("blocked");
    expect(task.hitl).toBe(false);
  });

  it("a terminal-status hitl:true + non-null blockedReason task has hitl cleared but status untouched", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Task" ("id","title","status","hitl","blockedReason","hitlNotifiedAt","updatedAt")
       VALUES ('t-terminal', 'terminal escalated', 'cancelled', true, 'spin detected', NULL, now());`,
    );

    await runDataMigration(prisma);

    const task = await prisma.task.findUniqueOrThrow({
      where: { id: "t-terminal" },
    });
    // UPDATE #1 clears hitl; UPDATE #2's WHERE excludes terminal statuses.
    expect(task.hitl).toBe(false);
    expect(task.status).toBe("cancelled");
  });

  it("an open PR with hitl:true ends up blocked:true", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PullRequest" ("id","repo","prNumber","state","hitl","hitlNotifiedAt","updatedAt")
       VALUES ('pr-open', 'app-vitals/shipwright', 9101, 'open', true, NULL, now());`,
    );

    await runDataMigration(prisma);

    const pr = await prisma.pullRequest.findUniqueOrThrow({
      where: { id: "pr-open" },
    });
    expect(pr.blocked).toBe(true);
  });

  it("a closed PR with hitl:true is NOT carried forward (blocked stays false)", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PullRequest" ("id","repo","prNumber","state","hitl","hitlNotifiedAt","updatedAt")
       VALUES ('pr-closed', 'app-vitals/shipwright', 9102, 'closed', true, NULL, now());`,
    );

    await runDataMigration(prisma);

    const pr = await prisma.pullRequest.findUniqueOrThrow({
      where: { id: "pr-closed" },
    });
    expect(pr.blocked).toBe(false);
  });
});
