/**
 * task-store/src/pull-request.integration.test.ts
 *
 * Integration tests for the PullRequest model against a real Postgres DB.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: TEST_DB as string } },
  });
}

describeOrSkip("PullRequest model (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.pullRequest.deleteMany();
  });

  it("inserts a PullRequest with all defaults", async () => {
    const created = await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 42,
      },
    });

    const read = await prisma.pullRequest.findUnique({
      where: { id: created.id },
    });

    expect(read).not.toBeNull();
    if (!read) return;

    expect(read.repo).toBe("app-vitals/shipwright");
    expect(read.prNumber).toBe(42);
    expect(read.state).toBe("open");
    expect(read.reviewState).toBe("pending");
    expect(read.patchCycles).toBe(0);
    expect(read.staged).toBe(false);
    expect(read.taskId).toBeNull();
    expect(read.commitSha).toBeNull();
    expect(read.agentId).toBeNull();
    expect(read.reviewedAt).toBeNull();
    expect(read.patchedAt).toBeNull();
    expect(read.mergedAt).toBeNull();
    expect(read.claimedBy).toBeNull();
    expect(read.claimedAt).toBeNull();
    expect(read.heartbeatAt).toBeNull();
    expect(read.createdAt).toBeInstanceOf(Date);
    expect(read.updatedAt).toBeInstanceOf(Date);
  });

  it("rejects duplicate (repo, prNumber)", async () => {
    await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 99,
      },
    });

    let threw = false;
    try {
      await prisma.pullRequest.create({
        data: {
          repo: "app-vitals/shipwright",
          prNumber: 99,
        },
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
  });
});
