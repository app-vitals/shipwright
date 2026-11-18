/**
 * task-store/src/system-cron-origin-backfill-migration.integration.test.ts
 *
 * SCM-2.2: the 20261118000000_backfill_system_cron_origin data migration.
 * Seeds pre-migration system-cron rows for both live cron ids (including the
 * hyphenated ids, so a split-on-'-' join would be wrong), runs the shipped
 * SQL, and asserts every system-cron row has originKind='cron' and
 * originRef=<cron id>, while non-cron rows are untouched.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const SQL_PATH = join(
  import.meta.dir,
  "..",
  "prisma",
  "migrations",
  "20261118000000_backfill_system_cron_origin",
  "migration.sql",
);

function statements(): string[] {
  return readFileSync(SQL_PATH, "utf8")
    .split(";")
    .map((s) =>
      s
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

describeOrSkip("system-cron origin backfill migration (integration)", () => {
  let prisma: PrismaClient;

  async function clear() {
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    await prisma.systemCronTrigger.deleteMany();
    await prisma.systemCronDefinition.deleteMany();
  }

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    await clear();
    for (const [id, name] of [
      ["test-readiness", "Test readiness"],
      ["docs-freshness", "Docs freshness"],
    ]) {
      await prisma.systemCronDefinition.create({
        data: {
          id,
          name,
          schedule: "0 7 * * *",
          titleTemplate: "t",
          descriptionTemplate: "d",
        },
      });
    }
  });

  afterEach(async () => {
    await clear();
    await prisma.$disconnect();
  });

  it("backfills originKind/originRef from the cron id prefix", async () => {
    const slot = "20261117T070000Z";
    const rows = [
      { id: `SC-test-readiness-${slot}-acme-widgets`, ref: null, kind: null },
      { id: `SC-docs-freshness-${slot}-acme-gadgets`, ref: null, kind: null },
      // Stamped by the old code with the display name.
      {
        id: `SC-docs-freshness-${slot}-acme-old`,
        ref: "Docs freshness",
        kind: "cron",
      },
    ];
    for (const r of rows) {
      await prisma.task.create({
        data: {
          id: r.id,
          title: "x",
          status: "pending",
          source: "system-cron",
          originKind: r.kind,
          originRef: r.ref,
        },
      });
    }
    await prisma.task.create({
      data: {
        id: "human-1",
        title: "h",
        status: "pending",
        source: "manual",
      },
    });

    for (const s of statements()) await prisma.$executeRawUnsafe(s);
    // Idempotent.
    for (const s of statements()) await prisma.$executeRawUnsafe(s);

    const cron = await prisma.task.findMany({
      where: { source: "system-cron" },
    });
    expect(cron).toHaveLength(3);
    for (const t of cron) {
      expect(t.originKind).toBe("cron");
      expect(t.id.startsWith(`SC-${t.originRef}-`)).toBe(true);
    }
    expect(new Set(cron.map((t) => t.originRef))).toEqual(
      new Set(["test-readiness", "docs-freshness"]),
    );
    const human = await prisma.task.findUniqueOrThrow({
      where: { id: "human-1" },
    });
    expect(human.originKind).toBeNull();
    expect(human.originRef).toBeNull();
  });
});
