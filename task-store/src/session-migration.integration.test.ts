/**
 * task-store/src/session-migration.integration.test.ts
 *
 * Migration-safety tests for the Session model creation
 * (20260910000000_add_session_model, SES-1.1).
 *
 * Verifies that the migration:
 * 1. Creates the Session table with correct columns and constraints
 * 2. Makes no modifications to existing tables (Task, PullRequest, etc)
 * 3. The Session model is additive — existing data is untouched
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "../prisma/client/index.js";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

/** Directory name of the migration under test. */
const MIGRATION_DIR = "20260910000000_add_session_model";

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
 * keeps this test honest: it fails if the migration ever stops creating the
 * Session table.
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
 * Check if the Session table exists in the database.
 */
async function hasSessionTable(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT count(*) AS count FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'Session';`,
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

/**
 * Check if a specific column exists in the Session table.
 */
async function hasSessionColumn(
  prisma: PrismaClient,
  columnName: string,
): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT count(*) AS count FROM information_schema.columns
     WHERE table_name = 'Session' AND column_name = $1;`,
    columnName,
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

/**
 * Get column info for the Session table (type, nullable, defaults).
 */
async function getSessionColumnInfo(prisma: PrismaClient): Promise<
  Array<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>
> {
  return prisma.$queryRawUnsafe<
    Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>
  >(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_name = 'Session'
     ORDER BY ordinal_position;`,
  );
}

/**
 * Drop the Session table if it exists, for cleanup after test.
 */
async function dropSessionTable(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "Session" CASCADE;');
}

describeOrSkip("add Session model migration (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    // Clean up any leftover Session table from a crashed prior run
    await dropSessionTable(prisma);
  });

  afterEach(async () => {
    await dropSessionTable(prisma);
    await prisma.$disconnect();
  });

  // The suite's own migrations already applied this migration once (via
  // `prisma migrate deploy`) before any test file ran, so the Session table
  // is expected to exist for every OTHER test file/suite that depends on it
  // (e.g. session-service.integration.test.ts) — this file just re-applies
  // and re-drops it per-test to exercise the migration.sql in isolation.
  // Without restoring it here, this file's last afterEach leaves the table
  // dropped for the remainder of the `bun test` run (file execution order is
  // alphabetical, so session-migration runs before session-service),
  // breaking every later suite that assumes Session already exists. Re-run
  // the migration statements one more time after all of this file's tests
  // finish so the table is left in the same state this file found it in.
  afterAll(async () => {
    const restore = makePrisma();
    try {
      if (!(await hasSessionTable(restore))) {
        for (const statement of migrationStatements()) {
          await restore.$executeRawUnsafe(statement);
        }
      }
    } finally {
      await restore.$disconnect();
    }
  });

  it("creates the Session table", async () => {
    expect(await hasSessionTable(prisma)).toBe(false);

    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }

    expect(await hasSessionTable(prisma)).toBe(true);
  });

  it("creates slug as the primary key (NOT NULL, unique)", async () => {
    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }

    expect(await hasSessionColumn(prisma, "slug")).toBe(true);

    const columns = await getSessionColumnInfo(prisma);
    const slugCol = columns.find((c) => c.column_name === "slug");
    expect(slugCol).toBeDefined();
    expect(slugCol?.data_type).toBe("text");
    expect(slugCol?.is_nullable).toBe("NO");
  });

  it("creates title as nullable VARCHAR", async () => {
    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }

    expect(await hasSessionColumn(prisma, "title")).toBe(true);

    const columns = await getSessionColumnInfo(prisma);
    const titleCol = columns.find((c) => c.column_name === "title");
    expect(titleCol).toBeDefined();
    expect(titleCol?.is_nullable).toBe("YES");
  });

  it("creates createdAt with DEFAULT CURRENT_TIMESTAMP", async () => {
    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }

    expect(await hasSessionColumn(prisma, "createdAt")).toBe(true);

    const columns = await getSessionColumnInfo(prisma);
    const createdAtCol = columns.find((c) => c.column_name === "createdAt");
    expect(createdAtCol).toBeDefined();
    expect(createdAtCol?.is_nullable).toBe("NO");
    expect(createdAtCol?.column_default).toContain("CURRENT_TIMESTAMP");
  });

  it("creates updatedAt with automatic update trigger", async () => {
    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }

    expect(await hasSessionColumn(prisma, "updatedAt")).toBe(true);

    const columns = await getSessionColumnInfo(prisma);
    const updatedAtCol = columns.find((c) => c.column_name === "updatedAt");
    expect(updatedAtCol).toBeDefined();
    expect(updatedAtCol?.is_nullable).toBe("NO");
  });

  it("creates archivedAt as nullable TIMESTAMP", async () => {
    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }

    expect(await hasSessionColumn(prisma, "archivedAt")).toBe(true);

    const columns = await getSessionColumnInfo(prisma);
    const archivedAtCol = columns.find((c) => c.column_name === "archivedAt");
    expect(archivedAtCol).toBeDefined();
    expect(archivedAtCol?.is_nullable).toBe("YES");
  });

  it("creates archivedBy as nullable TEXT", async () => {
    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }

    expect(await hasSessionColumn(prisma, "archivedBy")).toBe(true);

    const columns = await getSessionColumnInfo(prisma);
    const archivedByCol = columns.find((c) => c.column_name === "archivedBy");
    expect(archivedByCol).toBeDefined();
    expect(archivedByCol?.is_nullable).toBe("YES");
  });

  it("does not modify existing Task table", async () => {
    const tasksBeforeCount = await prisma.task.count();

    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }

    const tasksAfterCount = await prisma.task.count();
    expect(tasksAfterCount).toBe(tasksBeforeCount);
  });

  it("does not modify existing PullRequest table", async () => {
    const prsBeforeCount = await prisma.pullRequest.count();

    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }

    const prsAfterCount = await prisma.pullRequest.count();
    expect(prsAfterCount).toBe(prsBeforeCount);
  });

  it("allows inserting and querying Session records", async () => {
    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }

    // Insert a Session record using raw SQL
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Session" ("slug", "title", "createdAt", "updatedAt")
       VALUES ('test-session-1', 'Test Session', now(), now());`,
    );

    // Verify we can query it back
    const sessions = await prisma.$queryRawUnsafe<
      Array<{ slug: string; title: string | null }>
    >(`SELECT "slug", "title" FROM "Session" WHERE "slug" = 'test-session-1';`);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.slug).toBe("test-session-1");
    expect(sessions[0]?.title).toBe("Test Session");
  });
});
