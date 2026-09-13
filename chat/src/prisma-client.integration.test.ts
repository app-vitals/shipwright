/**
 * chat/src/prisma-client.integration.test.ts
 *
 * Integration test for the driver-adapter-backed PrismaClient factory
 * (`createPrismaClient`). Prisma 7 removed the Rust query engine along with
 * `new PrismaClient()` / `new PrismaClient({ datasources })`, so every client
 * in this service is now constructed over a `pg.Pool` wrapped in `PrismaPg`.
 * That construction path is new, so it gets its own regression check: the
 * adapter-backed client must boot and complete a real round-trip against
 * Postgres.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_CHAT to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "./index.ts";
import { createPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_CHAT;

const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("createPrismaClient (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(() => {
    prisma = createPrismaClient(TEST_DB as string);
  });

  afterEach(async () => {
    // Message's FK to Thread is ON DELETE CASCADE, but delete children first
    // anyway so a failed assertion can't leave orphaned rows behind.
    await prisma.message.deleteMany();
    await prisma.thread.deleteMany();
    await prisma.$disconnect();
  });

  it("boots over the pg driver adapter and answers a raw round-trip query", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ one: number }>
    >`SELECT 1 AS one`;

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.one)).toBe(1);
  });

  it("round-trips a model write and read through the adapter", async () => {
    const created = await prisma.thread.create({
      data: { agentId: "adapter-round-trip", title: "boot check" },
    });

    const found = await prisma.thread.findUnique({ where: { id: created.id } });

    expect(found?.id).toBe(created.id);
    expect(found?.agentId).toBe("adapter-round-trip");
    expect(found?.title).toBe("boot check");
  });
});
