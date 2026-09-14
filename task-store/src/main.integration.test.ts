/**
 * task-store/src/main.integration.test.ts
 *
 * Integration tests for `createPrismaClient` — main.ts's PrismaClient factory.
 *
 * Prisma 7 removed the implicit Rust-engine connection path: the client is now
 * constructed over a driver adapter (`PrismaPg` wrapping a `pg.Pool`) instead
 * of reading the datasource URL itself. That construction path is new code, so
 * it gets its own integration check — the adapter-backed client must actually
 * boot and round-trip a query against a real Postgres.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { checkDbReady } from "./main.ts";
import { type PrismaClient, createPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("createPrismaClient (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(() => {
    // TEST_DB is guaranteed set — the describe block is skipped otherwise.
    prisma = createPrismaClient(TEST_DB as string);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("boots an adapter-backed client that executes a raw query", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ one: number }>
    >`SELECT 1::int AS one`;
    expect(rows).toEqual([{ one: 1 }]);
  });

  it("round-trips a Task row through the adapter-backed client", async () => {
    const title = `adapter round-trip ${crypto.randomUUID()}`;

    const created = await prisma.task.create({
      data: { title, status: "pending", source: "integration-test" },
    });

    try {
      const found = await prisma.task.findUnique({ where: { id: created.id } });
      expect(found?.title).toBe(title);
      expect(found?.status).toBe("pending");
    } finally {
      await prisma.task.delete({ where: { id: created.id } });
    }
  });

  it("reports ready via checkDbReady", async () => {
    await expect(checkDbReady(prisma)).resolves.toBe(true);
  });
});
