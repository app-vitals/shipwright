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
import { ConflictError } from "./errors.ts";
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
    expect(read.phase).toBeNull();
    expect(read.readyForReviewAt).toBeNull();
    expect(read.readyForPatchAt).toBeNull();
    expect(read.readyForDeployAt).toBeNull();
    expect(read.createdAt).toBeInstanceOf(Date);
    expect(read.updatedAt).toBeInstanceOf(Date);
  });

  it("readyFor*At timestamps default to null on creation", async () => {
    const created = await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 500,
      },
    });
    expect(created.readyForReviewAt).toBeNull();
    expect(created.readyForPatchAt).toBeNull();
    expect(created.readyForDeployAt).toBeNull();
    expect(created.phase).toBeNull();
  });

  it("COALESCE(readyForReviewAt, readyForPatchAt, readyForDeployAt) ordering returns oldest item first across mixed phases", async () => {
    // Insert PRs with different phase timestamps — oldest ready timestamp wins
    await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 601,
        phase: "patch",
        readyForPatchAt: "2026-07-01T02:00:00.000Z",
      },
    });
    await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 602,
        phase: "review",
        readyForReviewAt: "2026-07-01T01:00:00.000Z",
      },
    });
    await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 603,
        phase: "deploy",
        readyForDeployAt: "2026-07-01T03:00:00.000Z",
      },
    });

    const rows = await prisma.$queryRaw<{ prNumber: number; ready: string }[]>`
      SELECT "prNumber",
             COALESCE("readyForReviewAt", "readyForPatchAt", "readyForDeployAt") AS ready
        FROM "PullRequest"
       WHERE "prNumber" IN (601, 602, 603)
       ORDER BY COALESCE("readyForReviewAt", "readyForPatchAt", "readyForDeployAt") ASC
    `;

    expect(rows).toHaveLength(3);
    expect(rows[0].prNumber).toBe(602); // earliest: readyForReviewAt 01:00
    expect(rows[1].prNumber).toBe(601); // middle:   readyForPatchAt  02:00
    expect(rows[2].prNumber).toBe(603); // latest:   readyForDeployAt 03:00
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

    // Exactly one INSERT wins (status 201); the other hits the P2002 unique
    // constraint and the service maps it to ConflictError(409).
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // The winning caller gets a 201 with an in_progress record.
    const winner = fulfilled[0];
    if (winner.status === "fulfilled") {
      expect(winner.value.status).toBe(201);
      expect(winner.value.record.repo).toBe(repo);
      expect(winner.value.record.prNumber).toBe(prNumber);
      expect(winner.value.record.reviewState).toBe("in_progress");
    }

    // The losing caller must reject with ConflictError, not a generic 500.
    const loser = rejected[0];
    if (loser.status === "rejected") {
      expect(loser.reason).toBeInstanceOf(ConflictError);
    }

    // Verify exactly one record in the DB
    const records = await prisma.pullRequest.findMany({
      where: { repo, prNumber },
    });
    expect(records).toHaveLength(1);
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
