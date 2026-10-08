/**
 * task-store/src/add-account-id-migration.integration.test.ts
 *
 * Migration-safety tests for 20261008000000_add_account_id (SSP-6.1).
 *
 * The migration adds `accountId TEXT NOT NULL DEFAULT 'default'` to Task,
 * PullRequest, Session and VerificationCheck plus two NEW unique keys
 * alongside the old ones. The thing to prove is that rows inserted *before*
 * the migration come out as 'default', and that it is purely additive. This
 * test reverts the migration's effects via raw SQL, seeds pre-migration rows,
 * runs the exact SQL shipped in migration.sql (read off disk), then asserts
 * through raw queries and the Prisma client.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ACCOUNT_ID } from "@shipwright/lib/default-account";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

const MIGRATION_DIR = "20261008000000_add_account_id";

const MIGRATION_SQL_PATH = join(
  import.meta.dir,
  "..",
  "prisma",
  "migrations",
  MIGRATION_DIR,
  "migration.sql",
);

const TABLES = ["Task", "PullRequest", "Session", "VerificationCheck"] as const;

function makePrisma(): PrismaClient {
  return createPrismaClient(TEST_DB as string);
}

function migrationStatements(): string[] {
  return readFileSync(MIGRATION_SQL_PATH, "utf8")
    .split(";")
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

/** Revert the migration (idempotent) to recreate the pre-migration shape. */
async function revert(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'DROP INDEX IF EXISTS "PullRequest_accountId_repo_prNumber_key";',
  );
  await prisma.$executeRawUnsafe(
    'DROP INDEX IF EXISTS "Session_accountId_slug_key";',
  );
  for (const table of TABLES) {
    await prisma.$executeRawUnsafe(
      `DROP INDEX IF EXISTS "${table}_accountId_idx";`,
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "accountId";`,
    );
  }
}

async function runMigration(prisma: PrismaClient): Promise<void> {
  for (const statement of migrationStatements()) {
    await prisma.$executeRawUnsafe(statement);
  }
}

async function clear(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('DELETE FROM "VerificationCheck";');
  await prisma.pullRequestEvent.deleteMany();
  await prisma.pullRequest.deleteMany();
  await prisma.$executeRawUnsafe('DELETE FROM "Session";');
  await prisma.$executeRawUnsafe('DELETE FROM "Task";');
}

describeOrSkip("add accountId migration (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    await clear(prisma);
    await revert(prisma);
  });

  afterEach(async () => {
    // Restore the post-migration shape for sibling suites sharing TEST_DB.
    await clear(prisma);
    await revert(prisma);
    await runMigration(prisma);
    await prisma.$disconnect();
  });

  it("backfills pre-existing rows in all four tables to 'default'", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Task" ("id","title","status","repo","updatedAt")
       VALUES ('t-pre','pre','pending','app-vitals/shipwright', now());`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PullRequest" ("id","repo","prNumber","updatedAt")
       VALUES ('pr-pre','app-vitals/shipwright', 9401, now());`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Session" ("slug","updatedAt") VALUES ('s-pre', now());`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "VerificationCheck" ("id","repo","checkName","status","at")
       VALUES ('vc-pre','app-vitals/shipwright','lint','ran_passed', now()::text);`,
    );

    await runMigration(prisma);

    for (const table of TABLES) {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ accountId: string | null }>
      >(`SELECT DISTINCT "accountId" FROM "${table}";`);
      expect(rows).toEqual([{ accountId: DEFAULT_ACCOUNT_ID }]);
    }
  });

  it("is additive: Session slug PK still enforced; old PullRequest unique dropped (SSP-6.4)", async () => {
    await runMigration(prisma);

    await prisma.$executeRawUnsafe(
      `INSERT INTO "PullRequest" ("id","accountId","repo","prNumber","updatedAt")
       VALUES ('pr-a','default','app-vitals/shipwright', 9402, now());`,
    );
    // Same repo+prNumber, different account: allowed now that SSP-6.4 dropped the old unique.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PullRequest" ("id","accountId","repo","prNumber","updatedAt")
       VALUES ('pr-b','acct-2','app-vitals/shipwright', 9402, now());`,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO "Session" ("slug","updatedAt") VALUES ('s-dup', now());`,
    );
    await expect(
      (async () =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "Session" ("slug","accountId","updatedAt") VALUES ('s-dup','acct-2', now());`,
        ))(),
    ).rejects.toThrow();
  });

  it("enforces the new unique keys and exposes accountId through the client", async () => {
    await runMigration(prisma);

    const indexes = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes
       WHERE indexname IN ('PullRequest_accountId_repo_prNumber_key','Session_accountId_slug_key')
       ORDER BY indexname;`,
    );
    expect(indexes.map((i) => i.indexname)).toEqual([
      "PullRequest_accountId_repo_prNumber_key",
      "Session_accountId_slug_key",
    ]);

    const task = await prisma.task.create({
      data: { id: "t-new", title: "new", status: "pending", repo: "a/b" },
    });
    expect(task.accountId).toBe(DEFAULT_ACCOUNT_ID);
  });
});
