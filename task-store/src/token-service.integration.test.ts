/**
 * task-store/src/token-service.integration.test.ts
 *
 * Integration tests for TaskTokenService.seed() — the bootstrap admin token seeder.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; the suite skips otherwise.
 *
 * Covers:
 *   - seed() with a raw token creates an admin token (agentId: null)
 *   - seed() is idempotent — a second call with the same token is a no-op
 *   - the seeded token passes validate() as an admin token
 *   - seed() without env var: calling it with undefined is a no-op (no error)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "./index.ts";
import { TaskTokenService } from "./token-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: TEST_DB as string } },
  });
}

describeOrSkip("TaskTokenService.seed() (integration)", () => {
  let prisma: PrismaClient;
  let tokenService: TaskTokenService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.taskToken.deleteMany();
    tokenService = new TaskTokenService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("creates an admin token (agentId: null) from the raw token", async () => {
    await tokenService.seed("dev-task-store-admin-token");

    const tokens = await prisma.taskToken.findMany();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].agentId).toBeNull();
    expect(tokens[0].revokedAt).toBeNull();
    expect(tokens[0].label).toBe("seed");
  });

  it("is idempotent — second call with same token creates no duplicate", async () => {
    await tokenService.seed("dev-task-store-admin-token");
    await tokenService.seed("dev-task-store-admin-token");

    const tokens = await prisma.taskToken.findMany();
    expect(tokens).toHaveLength(1);
  });

  it("seeded token passes validate() as admin (agentId: null)", async () => {
    await tokenService.seed("dev-task-store-admin-token");

    const result = await tokenService.validate("dev-task-store-admin-token");
    expect(result).not.toBeNull();
    expect(result?.agentId).toBeNull();
  });

  it("does nothing when called with empty string", async () => {
    await tokenService.seed("");

    const tokens = await prisma.taskToken.findMany();
    expect(tokens).toHaveLength(0);
  });
});
