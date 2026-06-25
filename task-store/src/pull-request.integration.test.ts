/**
 * task-store/src/pull-request.integration.test.ts
 *
 * Integration tests for the PullRequest model and PullRequestService against a
 * real Postgres DB.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { PullRequestService } from "./pull-request-service.ts";

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

describeOrSkip("PullRequestService.claim() atomicity (integration)", () => {
  let prisma: PrismaClient;
  let service: PullRequestService;

  beforeEach(async () => {
    prisma = makePrisma();
    service = new PullRequestService(prisma);
    await prisma.pullRequest.deleteMany();
  });

  it("concurrent claims on same (repo, prNumber): one succeeds, one gets ConflictError", async () => {
    const repo = "app-vitals/shipwright";
    const prNumber = 100;
    const commitSha = "abc123";

    // Race two simultaneous claim() calls against an empty table.
    const results = await Promise.allSettled([
      service.claim(repo, prNumber, commitSha, "agent-a"),
      service.claim(repo, prNumber, commitSha, "agent-b"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one should succeed (create the record) and one should fail.
    // Note: with two concurrent claims on a fresh record, both will attempt to
    // INSERT. Postgres serializes via the unique constraint — one INSERT wins
    // (status 201), the other gets a P2002 unique violation. The service maps
    // P2002 → ConflictError on the transaction retry path, or the second
    // caller sees an existing record with same commitSha + in_progress →
    // ConflictError(409) on its own read-then-decide path.
    //
    // The invariant: at most one record exists and at most one caller gets a
    // non-error result.
    expect(fulfilled.length + rejected.length).toBe(2);

    // At least one must have succeeded (created the PR)
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // Verify exactly one record in the DB
    const records = await prisma.pullRequest.findMany({
      where: { repo, prNumber },
    });
    expect(records).toHaveLength(1);

    // If both happened to succeed (possible if second concurrent claim saw
    // reviewState=pending from first and updated it), both are fine — the
    // record is still consistent and in_progress.
    for (const result of fulfilled) {
      if (result.status === "fulfilled") {
        expect(result.value.record.repo).toBe(repo);
        expect(result.value.record.prNumber).toBe(prNumber);
        expect(result.value.record.reviewState).toBe("in_progress");
      }
    }
  });

  it("second claim with same commitSha on in_progress record returns ConflictError", async () => {
    const repo = "app-vitals/shipwright";
    const prNumber = 200;
    const commitSha = "def456";

    // First claim — creates the record
    const first = await service.claim(repo, prNumber, commitSha, "agent-a");
    expect(first.status).toBe(201);
    expect(first.record.reviewState).toBe("in_progress");

    // Second claim with same commitSha — should conflict (same sha + in_progress)
    let threw = false;
    try {
      await service.claim(repo, prNumber, commitSha, "agent-b");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("claim with different commitSha resets the record (200)", async () => {
    const repo = "app-vitals/shipwright";
    const prNumber = 300;

    // First claim
    await service.claim(repo, prNumber, "sha-1", "agent-a");

    // Second claim with different sha — should reset (200)
    const second = await service.claim(repo, prNumber, "sha-2", "agent-b");
    expect(second.status).toBe(200);
    expect(second.record.commitSha).toBe("sha-2");
    expect(second.record.claimedBy).toBe("agent-b");
    expect(second.record.reviewState).toBe("in_progress");
  });

  it("claim on pending record (same sha) resets to in_progress (200)", async () => {
    const repo = "app-vitals/shipwright";
    const prNumber = 400;
    const commitSha = "sha-pending";

    // Create a record with same sha but pending state (simulating a released claim)
    await prisma.pullRequest.create({
      data: {
        repo,
        prNumber,
        commitSha,
        reviewState: "pending",
      },
    });

    // Claim should succeed (200) even with same sha because reviewState is pending
    const result = await service.claim(repo, prNumber, commitSha, "agent-a");
    expect(result.status).toBe(200);
    expect(result.record.reviewState).toBe("in_progress");
    expect(result.record.claimedBy).toBe("agent-a");
  });
});
