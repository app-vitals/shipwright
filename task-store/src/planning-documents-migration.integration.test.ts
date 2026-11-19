/**
 * task-store/src/planning-documents-migration.integration.test.ts
 *
 * Migration-safety tests for 20261117180000_add_planning_documents (PLU-2.1).
 *
 * The migration adds the PlanDocument table (plus its two enums) and a set of
 * nullable columns to Session and Task. The thing to prove is that it is
 * purely additive: rows that exist *before* the migration come through
 * unchanged with every new column NULL, every new column is nullable with no
 * default, and the PlanDocument [accountId, session, kind, number] unique key
 * is enforced. This test reverts the migration's effects via raw SQL, seeds
 * pre-migration rows, runs the exact SQL shipped in migration.sql (read off
 * disk), then asserts through raw queries and the Prisma client.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ACCOUNT_ID } from "./default-account.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

const MIGRATION_DIR = "20261117180000_add_planning_documents";

const MIGRATION_SQL_PATH = join(
  import.meta.dir,
  "..",
  "prisma",
  "migrations",
  MIGRATION_DIR,
  "migration.sql",
);

/** Columns this migration adds to existing tables — all must be nullable. */
const NEW_SESSION_COLUMNS = [
  "owner",
  "homeRepo",
  "planningLockHolder",
  "planningLockExpiresAt",
] as const;

const NEW_TASK_COLUMNS = [
  "owner",
  "planDocumentId",
  "specDocumentId",
  "originKind",
  "originRef",
] as const;

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
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
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "PlanDocument";');
  await prisma.$executeRawUnsafe('DROP TYPE IF EXISTS "PlanDocumentKind";');
  await prisma.$executeRawUnsafe('DROP TYPE IF EXISTS "PlanDocumentState";');
  for (const column of NEW_SESSION_COLUMNS) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Session" DROP COLUMN IF EXISTS "${column}";`,
    );
  }
  for (const column of NEW_TASK_COLUMNS) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Task" DROP COLUMN IF EXISTS "${column}";`,
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
  await prisma.$executeRawUnsafe('DELETE FROM "Session";');
  // TaskEvent's FK (TaskEvent_taskId_fkey) is ON DELETE RESTRICT — clear it
  // before Task rows, since sibling suites on the shared TEST_DB leave events behind.
  await prisma.$executeRawUnsafe('DELETE FROM "TaskEvent";');
  await prisma.$executeRawUnsafe('DELETE FROM "Task";');
}

type ColumnInfo = {
  column_name: string;
  is_nullable: string;
  column_default: string | null;
  data_type: string;
};

async function columnInfo(
  prisma: PrismaClient,
  table: string,
): Promise<ColumnInfo[]> {
  return prisma.$queryRawUnsafe<ColumnInfo[]>(
    `SELECT column_name, is_nullable, column_default, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position;`,
    table,
  );
}

/** Every pre-existing column of a row, as JSON, keyed for comparison. */
async function rowSnapshot(
  prisma: PrismaClient,
  sql: string,
): Promise<Record<string, unknown>> {
  const rows =
    await prisma.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(sql);
  expect(rows).toHaveLength(1);
  return rows[0]?.row as Record<string, unknown>;
}

function withoutNewColumns(
  row: Record<string, unknown>,
  columns: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !columns.includes(key)),
  );
}

const TASK_ROW_SQL = `SELECT to_jsonb(t) AS row FROM "Task" t WHERE id = 't-plu-pre';`;
const SESSION_ROW_SQL = `SELECT to_jsonb(s) AS row FROM "Session" s WHERE slug = 's-plu-pre';`;

describeOrSkip("add planning documents migration (integration)", () => {
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

  it("is purely additive: every statement creates a type/table/index or adds a column", () => {
    const statements = migrationStatements();
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatch(
        /^(CREATE TYPE|CREATE TABLE|CREATE (UNIQUE )?INDEX|ALTER TABLE "(Task|Session)" ADD COLUMN)/,
      );
      // No renames, drops, defaults on existing tables or NOT NULL additions.
      expect(statement).not.toMatch(/\b(DROP|RENAME)\b/);
      if (statement.startsWith("ALTER TABLE")) {
        expect(statement).not.toMatch(/NOT NULL|DEFAULT/);
      }
    }
  });

  it("leaves pre-existing Task and Session rows unchanged with every new column NULL", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Task" ("id","title","status","repo","session","source","acceptanceCriteria","dependencies","updatedAt")
       VALUES ('t-plu-pre','pre','pending','app-vitals/shipwright','plu-sess','planning/plu-sess/PLAN.md',
               ARRAY['ac-1']::TEXT[], ARRAY['t-dep']::TEXT[], now());`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Session" ("slug","title","updatedAt") VALUES ('s-plu-pre','Pre session', now());`,
    );

    const taskBefore = await rowSnapshot(prisma, TASK_ROW_SQL);
    const sessionBefore = await rowSnapshot(prisma, SESSION_ROW_SQL);

    await runMigration(prisma);

    const taskAfter = await rowSnapshot(prisma, TASK_ROW_SQL);
    const sessionAfter = await rowSnapshot(prisma, SESSION_ROW_SQL);

    expect(withoutNewColumns(taskAfter, NEW_TASK_COLUMNS)).toEqual(taskBefore);
    expect(withoutNewColumns(sessionAfter, NEW_SESSION_COLUMNS)).toEqual(
      sessionBefore,
    );
    for (const column of NEW_TASK_COLUMNS) {
      expect(column in taskAfter).toBe(true);
      expect(taskAfter[column]).toBeNull();
    }
    for (const column of NEW_SESSION_COLUMNS) {
      expect(column in sessionAfter).toBe(true);
      expect(sessionAfter[column]).toBeNull();
    }
  });

  it("adds every new Task and Session column as nullable with no default", async () => {
    await runMigration(prisma);

    const taskColumns = await columnInfo(prisma, "Task");
    for (const name of NEW_TASK_COLUMNS) {
      const column = taskColumns.find((c) => c.column_name === name);
      expect(column).toBeDefined();
      expect(column?.is_nullable).toBe("YES");
      expect(column?.column_default).toBeNull();
    }

    const sessionColumns = await columnInfo(prisma, "Session");
    for (const name of NEW_SESSION_COLUMNS) {
      const column = sessionColumns.find((c) => c.column_name === name);
      expect(column).toBeDefined();
      expect(column?.is_nullable).toBe("YES");
      expect(column?.column_default).toBeNull();
    }
    // PWE-2.1: a later migration drops the column again.
    expect(
      sessionColumns.find((c) => c.column_name === "declaredRepos"),
    ).toBeUndefined();
  });

  it("creates PlanDocument with the [accountId, session, kind, number] unique key", async () => {
    await runMigration(prisma);

    const indexes = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'PlanDocument' AND indexname = 'PlanDocument_accountId_session_kind_number_key';`,
    );
    expect(indexes).toHaveLength(1);

    const insert = (accountId: string, kind: string, number: number) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "PlanDocument" ("id","accountId","session","kind","number","repo","path","state","updatedAt")
         VALUES ($1, $2, 'plu-sess', $3::"PlanDocumentKind", $4, 'app-vitals/shipwright',
                 'planning/plu-sess/SPEC-0001.md', 'draft', now());`,
        `pd-${accountId}-${kind}-${number}`,
        accountId,
        kind,
        number,
      );

    await insert("default", "spec", 1);
    // Different number, kind, or account: allowed.
    await insert("default", "spec", 2);
    await insert("default", "plan", 1);
    await insert("acct-2", "spec", 1);

    // Same account, session, kind and number: rejected by the unique key.
    await expect(
      (async () =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "PlanDocument" ("id","accountId","session","kind","number","repo","path","state","updatedAt")
         VALUES ('pd-dup','default','plu-sess','spec',1,'app-vitals/shipwright',
                 'planning/plu-sess/SPEC-0001.md','draft', now());`,
        ))(),
    ).rejects.toThrow();
  });

  it("rejects kind and state values outside their enums", async () => {
    await runMigration(prisma);

    await expect(
      (async () =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "PlanDocument" ("id","session","kind","number","repo","path","updatedAt")
         VALUES ('pd-bad-kind','plu-sess','bogus',1,'a/b','p.md', now());`,
        ))(),
    ).rejects.toThrow();
    await expect(
      (async () =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "PlanDocument" ("id","session","kind","number","repo","path","state","updatedAt")
         VALUES ('pd-bad-state','plu-sess','spec',1,'a/b','p.md','bogus', now());`,
        ))(),
    ).rejects.toThrow();
  });

  it("exposes PlanDocument and the new columns through the Prisma client", async () => {
    await runMigration(prisma);

    const doc = await prisma.planDocument.create({
      data: {
        session: "plu-sess",
        kind: "spec",
        number: 1,
        repo: "app-vitals/shipwright",
        path: "planning/plu-sess/SPEC-0001.md",
      },
    });
    expect(doc.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(doc.state).toBe("draft");
    expect(doc.repos).toEqual([]);
    expect(doc.title).toBeNull();
    expect(doc.owner).toBeNull();
    expect(doc.prUrl).toBeNull();
    expect(doc.commitSha).toBeNull();
    expect(doc.plannedAt).toBeNull();
    expect(doc.originTaskId).toBeNull();

    const task = await prisma.task.create({
      data: {
        id: "t-plu-new",
        title: "new",
        status: "pending",
        repo: "a/b",
        owner: "dev@example.com",
        planDocumentId: doc.id,
        specDocumentId: doc.id,
        originKind: "document",
        originRef: doc.id,
      },
    });
    expect(task.owner).toBe("dev@example.com");
    expect(task.planDocumentId).toBe(doc.id);

    const lockExpiry = new Date("2026-11-17T18:15:00.000Z");
    const session = await prisma.session.create({
      data: {
        slug: "plu-sess",
        owner: "dev@example.com",
        homeRepo: "app-vitals/shipwright",
        planningLockHolder: "agent-1",
        planningLockExpiresAt: lockExpiry,
      },
    });
    expect(session.homeRepo).toBe("app-vitals/shipwright");
    expect(session.planningLockExpiresAt?.toISOString()).toBe(
      lockExpiry.toISOString(),
    );
  });
});
