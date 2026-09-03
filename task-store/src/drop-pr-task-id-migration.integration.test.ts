/**
 * task-store/src/drop-pr-task-id-migration.integration.test.ts
 *
 * Migration-safety tests for the PullRequest.taskId column drop
 * (20260903110340_drop_pull_request_task_id, PTL-3.1).
 *
 * `taskId` was never reliably populated (~10% of records overall, 0% in
 * several repos) and could not represent the bundle case at all, so every
 * consumer migrated to a live `GET /tasks?repo=&pr=` lookup (PTL-1.1 →
 * PTL-2.2) before this migration dropped the column. The one thing left to
 * prove is that the drop itself is safe against *historical* data: rows that
 * really do carry a non-null taskId must survive the `DROP COLUMN` with every
 * other field intact, rather than erroring or taking the row with them.
 *
 * The post-migration Prisma client has no knowledge of the column, so this
 * test re-creates the pre-migration shape via raw SQL (column + its index),
 * seeds rows with non-null historical taskId values, then runs the *exact*
 * SQL shipped in migration.sql — read off disk, not re-typed — and asserts
 * the post-migration state through the Prisma client.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "../prisma/client/index.js";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

/** Directory name of the migration under test. */
const MIGRATION_DIR = "20260903110340_drop_pull_request_task_id";

const MIGRATION_SQL_PATH = join(
  import.meta.dir,
  "..",
  "prisma",
  "migrations",
  MIGRATION_DIR,
  "migration.sql",
);

function makePrisma(): PrismaClient {
  return new PrismaClient({
    // TEST_DB is guaranteed set — the describe block is skipped otherwise.
    datasources: { db: { url: TEST_DB as string } },
  });
}

/**
 * The migration's statements, split on `;` with comments and blank fragments
 * dropped. Reading the shipped file (rather than restating the SQL inline)
 * keeps this test honest: it fails if the migration ever stops dropping the
 * column.
 */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION_SQL_PATH, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
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

/**
 * Re-create the pre-migration shape (nullable taskId column + its index) so
 * historical rows can be seeded. Idempotent, so a crashed prior run can't
 * wedge the suite.
 */
async function addTaskIdColumn(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PullRequest" ADD COLUMN IF NOT EXISTS "taskId" TEXT;',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "PullRequest_taskId_idx" ON "PullRequest"("taskId");',
  );
}

/**
 * Restore the post-migration shape regardless of how the test body exited —
 * this suite shares TEST_DB with every other task-store integration file, so
 * a leftover column would break the Prisma client's `SELECT *` for siblings.
 */
async function dropTaskIdColumn(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'DROP INDEX IF EXISTS "PullRequest_taskId_idx";',
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PullRequest" DROP COLUMN IF EXISTS "taskId";',
  );
}

/** True when the PullRequest table currently has a taskId column. */
async function hasTaskIdColumn(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT count(*) AS count FROM information_schema.columns
     WHERE table_name = 'PullRequest' AND column_name = 'taskId';`,
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

describeOrSkip("drop PullRequest.taskId migration (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    // PullRequestEvent's FK is ON DELETE RESTRICT (PSA-1.2) — clear event
    // rows before their parent PullRequest rows, in case another test file
    // sharing TEST_DB left rows behind.
    await prisma.pullRequestEvent.deleteMany();
    await prisma.pullRequest.deleteMany();
    await addTaskIdColumn(prisma);
  });

  afterEach(async () => {
    await dropTaskIdColumn(prisma);
    await prisma.pullRequestEvent.deleteMany();
    await prisma.pullRequest.deleteMany();
    await prisma.$disconnect();
  });

  it("drops the column without error when historical rows carry non-null taskId data", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PullRequest" ("id","repo","prNumber","taskId","state","reviewState","updatedAt")
       VALUES ('pr-historical', 'app-vitals/shipwright', 9301, 'PTL-1.1', 'open', 'posted', now());`,
    );

    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }

    expect(await hasTaskIdColumn(prisma)).toBe(false);
  });

  it("preserves every other field on a row that had a non-null taskId", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PullRequest" ("id","repo","prNumber","taskId","state","reviewState","commitSha","patchCycles","reviewCycles","blocked","updatedAt")
       VALUES ('pr-keepfields', 'app-vitals/shipwright', 9302, 'PTL-1.2', 'merged', 'approved', 'abc123def456', 2, 3, true, now());`,
    );

    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }

    const pr = await prisma.pullRequest.findUniqueOrThrow({
      where: { id: "pr-keepfields" },
    });
    expect(pr.repo).toBe("app-vitals/shipwright");
    expect(pr.prNumber).toBe(9302);
    expect(pr.state).toBe("merged");
    expect(pr.reviewState).toBe("approved");
    expect(pr.commitSha).toBe("abc123def456");
    expect(pr.patchCycles).toBe(2);
    expect(pr.reviewCycles).toBe(3);
    expect(pr.blocked).toBe(true);
  });

  it("keeps mixed null and non-null taskId rows — no row is dropped", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PullRequest" ("id","repo","prNumber","taskId","updatedAt")
       VALUES ('pr-with-task', 'app-vitals/shipwright', 9303, 'PTL-2.1', now()),
              ('pr-without-task', 'app-vitals/shipwright', 9304, NULL, now());`,
    );

    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }

    const ids = (
      await prisma.pullRequest.findMany({ orderBy: { prNumber: "asc" } })
    ).map((pr) => pr.id);
    expect(ids).toEqual(["pr-with-task", "pr-without-task"]);
  });

  it("also removes the column's index, so nothing is left referencing it", async () => {
    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }

    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) AS count FROM pg_indexes
       WHERE tablename = 'PullRequest' AND indexname = 'PullRequest_taskId_idx';`,
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(0);
  });
});
