/**
 * admin/src/prisma-client.integration.test.ts
 * Integration tests for the Prisma 7 driver-adapter client factory against a
 * real PostgreSQL DB.
 *
 * The rest of the admin integration suite is the regression check for query
 * *behavior* across the v6→v7 upgrade. This file covers the one thing that is
 * genuinely new: client construction now goes through a `PrismaPg` driver
 * adapter over a `pg.Pool` instead of Prisma's built-in query engine, so the
 * boot path itself needs a live-DB assertion that it connects and round-trips.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("createAdminPrismaClient (integration)", () => {
  let prisma: PrismaClient | undefined;

  afterEach(async () => {
    await prisma?.$disconnect();
    prisma = undefined;
  });

  it("boots an adapter-backed client that executes a raw round-trip query", async () => {
    // TEST_DB is guaranteed set — the describe block is skipped otherwise.
    prisma = createAdminPrismaClient(TEST_DB as string);

    const rows = await prisma.$queryRaw<
      Array<{ one: number }>
    >`SELECT 1 AS one`;

    expect(rows).toEqual([{ one: 1 }]);
  });

  it("round-trips a model write and read back through the adapter", async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);

    const created = await prisma.agent.create({
      data: { name: "Adapter Boot Agent" },
    });
    try {
      const found = await prisma.agent.findUnique({
        where: { id: created.id },
      });
      expect(found?.name).toBe("Adapter Boot Agent");
    } finally {
      await prisma.agent.delete({ where: { id: created.id } });
    }
  });
});
