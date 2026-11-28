/**
 * task-store/src/case-insensitive-unique-indexes-migration.integration.test.ts
 *
 * STI-1.1 integration coverage for the
 * 20261128010000_add_case_insensitive_unique_indexes migration: unique indexes
 * on (accountId, lower(slug)) for Session and lower(id) for Task, and a
 * fail-loud collision check that names the colliding values.
 *
 * Each test builds a throwaway schema, replays every earlier migration into
 * it, then applies the real migration.sql. Requires
 * DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; the suite skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { toPoolConfig } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const MIGRATIONS_DIR = join(import.meta.dir, "..", "prisma", "migrations");
const TARGET = "20261128010000_add_case_insensitive_unique_indexes";

function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

function priorMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name < TARGET)
    .map((d) => d.name)
    .sort();
}

describeOrSkip(
  "case-insensitive unique indexes migration (STI-1.1, integration)",
  () => {
    let client: pg.Client;
    let schema: string;

    beforeEach(async () => {
      schema = `sti11_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      client = new pg.Client(toPoolConfig(TEST_DB as string));
      await client.connect();
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      for (const name of priorMigrations()) {
        await client.query(migrationSql(name));
      }
    });

    afterEach(async () => {
      await client.query("ROLLBACK");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    });

    const applyTarget = () => client.query(migrationSql(TARGET));

    const insertSession = (slug: string, accountId = "default") =>
      client.query(
        `INSERT INTO "Session" ("slug","accountId","updatedAt") VALUES ($1,$2,now())`,
        [slug, accountId],
      );

    const insertTask = (id: string) =>
      client.query(
        `INSERT INTO "Task" ("id","title","status","updatedAt") VALUES ($1,'t','pending',now())`,
        [id],
      );

    it("rejects a case-variant session slug in the same account", async () => {
      await insertSession("My-Session");
      await applyTarget();
      await expect(insertSession("my-session")).rejects.toThrow(
        /Session_accountId_lower_slug_key/,
      );
    });

    it("allows the same slug in a different account", async () => {
      await insertSession("My-Session", "acct-a");
      await applyTarget();
      await insertSession("my-session", "acct-b");
    });

    it("rejects a case-variant task id", async () => {
      await insertTask("STI-1.1");
      await applyTarget();
      await expect(insertTask("sti-1.1")).rejects.toThrow(/Task_lower_id_key/);
    });

    it("applies cleanly when no collisions exist", async () => {
      await insertSession("a");
      await insertSession("b");
      await insertTask("T-1");
      await insertTask("T-2");
      await applyTarget();
    });

    it("fails naming colliding session slugs and task ids", async () => {
      await insertSession("Foo");
      await insertSession("foo");
      await insertTask("ABC-1");
      await insertTask("abc-1");
      await expect(applyTarget()).rejects.toThrow(
        /default\/foo => \[Foo, foo\].*abc-1 => \[ABC-1, abc-1\]/s,
      );
    });
  },
);
