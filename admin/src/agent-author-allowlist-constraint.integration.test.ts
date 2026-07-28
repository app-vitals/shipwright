/**
 * admin/src/agent-author-allowlist-constraint.integration.test.ts
 * Integration test for the NOT NULL constraint on Agent.authorAllowlist,
 * against a real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 *
 * Root cause: the authorAllowlist column was added without NOT NULL
 * (unlike the sibling `repos` column), so Prisma's `string[]` type was a
 * lie — the DB could (and did) hold NULL, crashing shipwright-loop
 * (Sentry issue 7633628941).
 *
 * This test drives the real `prisma migrate deploy` CLI (not a hand-rolled
 * replay of the migration SQL) to prove:
 *   1. A pre-existing NULL row is backfilled to '{}' when the new
 *      migration is applied.
 *   2. After the migration, the DB itself rejects a raw NULL insert.
 *
 * `prisma migrate deploy` only ever applies a migration once per database
 * (it's recorded in `_prisma_migrations` and never replayed), so to exercise
 * "migrate deploy applies the new migration against a DB that already has a
 * NULL row" repeatably — both on a first run and on a re-run against a DB
 * where this migration was already applied by an earlier test run — this
 * test explicitly rolls the column and the migration's tracking row back to
 * a pre-migration state before applying it. This mirrors the exact
 * production scenario: an existing DB with the constraint already applied
 * gets a new NULL row written some other way, and needs (re-)verification
 * that the constraint layer is what's actually protecting it. Because this
 * test mutates and restores shared schema state, it must not run
 * concurrently with itself or other migrate-deploy-driving tests — see the
 * DB-lock guard below.
 */

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const ADMIN_DIR = fileURLToPath(new URL("..", import.meta.url));
const REAL_SCHEMA = `${ADMIN_DIR}prisma/schema.prisma`;
const NEW_MIGRATION_NAME =
  "20260727120000_add_not_null_to_agent_author_allowlist";

function makePrisma(): PrismaClient {
  return new PrismaClient({
    // TEST_DB is guaranteed set — the describe block is skipped otherwise.
    datasources: { db: { url: TEST_DB as string } },
  });
}

/**
 * Runs `prisma migrate deploy` against the real schema.prisma.
 */
function migrateDeploy(): void {
  execSync(`bunx prisma migrate deploy --schema=${REAL_SCHEMA}`, {
    cwd: ADMIN_DIR,
    env: { ...process.env, DATABASE_URL_SHIPWRIGHT_ADMIN: TEST_DB },
    stdio: "pipe",
  });
}

/**
 * Rolls the DB back to "the new NOT NULL migration has not been applied
 * yet": drops the NOT NULL constraint (mirrors the pre-migration schema)
 * and removes the migration's tracking row from `_prisma_migrations` so
 * `migrate deploy` will apply it fresh. Safe to call whether or not the
 * migration has actually been applied before.
 */
async function rollBackNewMigration(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Agent" ALTER COLUMN "authorAllowlist" DROP NOT NULL;`,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "_prisma_migrations" WHERE migration_name = $1;`,
    NEW_MIGRATION_NAME,
  );
}

// A fixed advisory lock key for this test file. `prisma migrate deploy`
// mutates shared schema state (the Agent table's NOT NULL constraint, the
// `_prisma_migrations` tracking table) that this file's own tests, run
// concurrently by bun's test runner, would otherwise stomp on each other
// over. Other test files' `beforeEach` cleanup (deleteMany) races with a
// mid-flight `migrate deploy` too, so every test below serializes on this
// lock for its full duration.
const ADVISORY_LOCK_KEY = 483_912_001;

async function withSchemaLock<T>(
  prisma: PrismaClient,
  fn: () => Promise<T>,
): Promise<T> {
  await prisma.$executeRawUnsafe(
    `SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY});`,
  );
  try {
    return await fn();
  } finally {
    await prisma.$executeRawUnsafe(
      `SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY});`,
    );
  }
}

describeOrSkip(
  "Agent.authorAllowlist NOT NULL constraint (integration)",
  () => {
    let prisma: PrismaClient;

    beforeEach(async () => {
      prisma = makePrisma();
    });

    afterEach(async () => {
      await prisma.$disconnect();
    });

    it("migrate deploy backfills a pre-existing NULL row to '{}' and then rejects further NULL inserts", async () => {
      await withSchemaLock(prisma, async () => {
        // 1. Roll the column and migration-tracking row back to "not yet
        //    applied", so the column accepts NULL again (mirrors a DB
        //    that predates this migration, whether this is the very
        //    first time it's run against this test DB or a re-run).
        await rollBackNewMigration(prisma);

        // 2. Seed a row with authorAllowlist explicitly NULL via raw
        //    SQL — simulating a row written before the constraint
        //    existed (exactly the Sentry 7633628941 scenario).
        const agent = await prisma.agent.create({
          data: { name: "Pre-existing NULL agent" },
        });
        await prisma.$executeRawUnsafe(
          `UPDATE "Agent" SET "authorAllowlist" = NULL WHERE id = $1;`,
          agent.id,
        );

        const seeded = await prisma.$queryRawUnsafe<
          { authorAllowlist: unknown }[]
        >(`SELECT "authorAllowlist" FROM "Agent" WHERE id = $1;`, agent.id);
        expect(seeded[0]?.authorAllowlist).toBeNull();

        // 3. Deploy — this applies the new migration under test for
        //    real via the Prisma CLI.
        migrateDeploy();

        // 4. The pre-existing NULL row must now be backfilled to '{}'.
        const backfilled = await prisma.agent.findUniqueOrThrow({
          where: { id: agent.id },
        });
        expect(backfilled.authorAllowlist).toEqual([]);

        // 5. The column must now reject NULL at the DB level.
        let insertError: unknown;
        try {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "Agent" (id, name, "authorAllowlist", "updatedAt") VALUES ($1, $2, NULL, now());`,
            "test-null-insert-id",
            "Should be rejected",
          );
        } catch (err) {
          insertError = err;
        }
        expect(insertError).toBeDefined();
        // Postgres error code 23502 = not_null_violation. The driver
        // surfaces it as `meta.code` on PrismaClientKnownRequestError;
        // the stringified error also names the offending row/table,
        // which we additionally sanity-check.
        const meta = (insertError as { meta?: { code?: string } }).meta;
        expect(meta?.code).toBe("23502");
        expect(String(insertError)).toMatch(/Failing row contains/i);
      });
    }, 30_000);

    it("migrate deploy is idempotent — running it twice after the NOT NULL migration does not error", async () => {
      await withSchemaLock(prisma, async () => {
        migrateDeploy();
        expect(() => migrateDeploy()).not.toThrow();

        const agent = await prisma.agent.create({
          data: { name: "Post-migration agent" },
        });
        expect(agent.authorAllowlist).toEqual([]);
      });
    }, 30_000);
  },
);
