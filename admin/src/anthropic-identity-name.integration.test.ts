/**
 * admin/src/anthropic-identity-name.integration.test.ts
 * Integration tests for AnthropicIdentityNameAllocator (PAI-1.3) against a
 * real PostgreSQL DB — sequential numbering and concurrent uniqueness.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AnthropicIdentityNameAllocator } from "./anthropic-identity-name.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createAdminPrismaClient(TEST_DB as string);
}

describeOrSkip("AnthropicIdentityNameAllocator (integration)", () => {
  let prisma: PrismaClient;
  let allocator: AnthropicIdentityNameAllocator;
  const email = "jane.doe@example.com";

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentPhaseMethodology.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    allocator = new AnthropicIdentityNameAllocator(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("allocates a1 then a2 for the same owner and persists them", async () => {
    const a = await prisma.agent.create({ data: { name: "A" } });
    const b = await prisma.agent.create({ data: { name: "B" } });
    expect(await allocator.allocate(a.id, email)).toBe("jane-doe-a1");
    expect(await allocator.allocate(b.id, email)).toBe("jane-doe-a2");
    const row = await prisma.agent.findUnique({ where: { id: b.id } });
    expect(row?.anthropicIdentityName).toBe("jane-doe-a2");
  });

  it("applies the configured suffix", async () => {
    const a = await prisma.agent.create({ data: { name: "A" } });
    const suffixed = new AnthropicIdentityNameAllocator(prisma, {
      suffix: "dev",
    });
    expect(await suffixed.allocate(a.id, email)).toBe("jane-doe-a1-dev");
  });

  it("gives concurrent allocations different names", async () => {
    const agents = await Promise.all(
      ["A", "B", "C", "D"].map((name) =>
        prisma.agent.create({ data: { name } }),
      ),
    );
    const names = await Promise.all(
      agents.map((a) => allocator.allocate(a.id, email)),
    );
    expect(new Set(names).size).toBe(agents.length);
    for (const n of names) expect(n).toMatch(/^jane-doe-a\d+$/);
  });

  it("concurrent allocations for the same agent agree on one name", async () => {
    const a = await prisma.agent.create({ data: { name: "A" } });
    const names = await Promise.all([
      allocator.allocate(a.id, email),
      allocator.allocate(a.id, email),
    ]);
    expect(names[0]).toBe(names[1]);
    const row = await prisma.agent.findUnique({ where: { id: a.id } });
    expect(row?.anthropicIdentityName).toBe(names[0]);
  });
});
