/**
 * task-store/src/pull-request.integration.test.ts
 *
 * Integration tests for the PullRequest model and PullRequestService against a
 * real Postgres DB.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { FixedClock } from "./clock.ts";
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

  afterEach(async () => {
    await prisma.$disconnect();
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

  afterEach(async () => {
    await prisma.$disconnect();
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

// ─── Phase-aware claim() integration tests ────────────────────────────────────

describeOrSkip("PullRequestService.claim() phase support (integration)", () => {
  let prisma: PrismaClient;
  let service: PullRequestService;

  beforeEach(async () => {
    prisma = makePrisma();
    service = new PullRequestService(prisma);
    await prisma.pullRequest.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("claim(phase=patch) does not reset reviewState — stays posted", async () => {
    const repo = "app-vitals/shipwright";
    const prNumber = 700;
    const commitSha = "sha-patch";

    // Create a record that has reviewState=posted (review complete, waiting for patch)
    await prisma.pullRequest.create({
      data: {
        repo,
        prNumber,
        commitSha,
        reviewState: "posted",
        phase: "review",
        claimedBy: null,
      },
    });

    // Claim with phase=patch — should NOT reset reviewState to pending/in_progress
    const result = await service.claim(repo, prNumber, commitSha, "agent-b", undefined, "patch");
    expect(result.record.reviewState).toBe("posted");
    expect(result.record.phase).toBe("patch");
    expect(result.record.claimedBy).toBe("agent-b");
  });

  it.each([
    ["pending", 710],
    ["in_progress", 711],
    ["posted", 712],
    ["approved", 713],
  ] as const)(
    "claim(phase=patch) never mutates reviewState=%s",
    async (priorReviewState, prNumber) => {
      const repo = "app-vitals/shipwright";
      const commitSha = `sha-patch-${priorReviewState}`;

      await prisma.pullRequest.create({
        data: {
          repo,
          prNumber,
          commitSha,
          reviewState: priorReviewState,
          phase: "review",
          claimedBy: null,
        },
      });

      const result = await service.claim(repo, prNumber, commitSha, "agent-b", undefined, "patch");
      expect(result.record.reviewState).toBe(priorReviewState);
      expect(result.record.phase).toBe("patch");
    },
  );

  it("claim(phase=deploy) sets phase=deploy, readyForDeployAt if null, does not clear reviewState", async () => {
    const repo = "app-vitals/shipwright";
    const prNumber = 701;
    const commitSha = "sha-deploy";

    await prisma.pullRequest.create({
      data: {
        repo,
        prNumber,
        commitSha,
        reviewState: "approved",
        phase: "patch",
        claimedBy: null,
        readyForDeployAt: null,
      },
    });

    const result = await service.claim(repo, prNumber, commitSha, "agent-c", undefined, "deploy");
    expect(result.record.phase).toBe("deploy");
    expect(result.record.reviewState).toBe("approved");
    expect(result.record.readyForDeployAt).not.toBeNull();
  });

  it("claim(phase=review) sets phase=review and reviewState=in_progress", async () => {
    const repo = "app-vitals/shipwright";
    const prNumber = 702;
    const commitSha = "sha-review";

    const result = await service.claim(repo, prNumber, commitSha, "agent-a", undefined, "review");
    expect(result.status).toBe(201);
    expect(result.record.phase).toBe("review");
    expect(result.record.reviewState).toBe("in_progress");
  });

  it("claim(phase=patch) conflict: 409 if same commitSha and phase=patch and already claimed", async () => {
    const repo = "app-vitals/shipwright";
    const prNumber = 703;
    const commitSha = "sha-conflict-patch";
    const now = new Date().toISOString();

    // Create record already claimed for patch with fresh heartbeat
    await prisma.pullRequest.create({
      data: {
        repo,
        prNumber,
        commitSha,
        reviewState: "posted",
        phase: "patch",
        claimedBy: "agent-x",
        claimedAt: now,
        heartbeatAt: now,
      },
    });

    let threw = false;
    try {
      await service.claim(repo, prNumber, commitSha, "agent-y", undefined, "patch");
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(ConflictError);
    }
    expect(threw).toBe(true);
  });
});

// ─── complete() sets readyForPatchAt ──────────────────────────────────────────

describeOrSkip("PullRequestService.complete() readyForPatchAt (integration)", () => {
  let prisma: PrismaClient;
  let service: PullRequestService;

  beforeEach(async () => {
    prisma = makePrisma();
    service = new PullRequestService(prisma);
    await prisma.pullRequest.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("complete() sets readyForPatchAt=now alongside reviewState=posted", async () => {
    const now = new Date("2026-07-01T10:00:00.000Z");
    const clock = FixedClock(now);
    const svc = new PullRequestService(prisma, clock);

    const { record: created } = await svc.claim(
      "app-vitals/shipwright",
      800,
      "sha-complete",
      "agent-a",
    );

    const completed = await svc.complete(created.id);
    expect(completed.reviewState).toBe("posted");
    expect(completed.reviewedAt).toBe(now.toISOString());
    expect(completed.readyForPatchAt).toBe(now.toISOString());
  });

  it("update() sets readyForDeployAt=now when reviewState transitions to approved and it is unset", async () => {
    const now = new Date("2026-07-01T11:00:00.000Z");
    const clock = FixedClock(now);
    const svc = new PullRequestService(prisma, clock);

    const { record: created } = await svc.claim(
      "app-vitals/shipwright",
      801,
      "sha-approve",
      "agent-a",
    );
    expect(created.readyForDeployAt).toBeNull();

    const updated = await svc.update(created.id, { reviewState: "approved" });
    expect(updated.reviewState).toBe("approved");
    expect(updated.readyForDeployAt).toBe(now.toISOString());
  });

  it("update() does not overwrite readyForDeployAt if already set when approving", async () => {
    const now = new Date("2026-07-01T12:00:00.000Z");
    const clock = FixedClock(now);
    const svc = new PullRequestService(prisma, clock);

    const { record: created } = await svc.claim(
      "app-vitals/shipwright",
      802,
      "sha-approve-2",
      "agent-a",
      undefined,
      "deploy",
    );
    expect(created.readyForDeployAt).toBe(now.toISOString());

    const later = new Date("2026-07-01T13:00:00.000Z");
    const laterClock = FixedClock(later);
    const svcLater = new PullRequestService(prisma, laterClock);
    const updated = await svcLater.update(created.id, {
      reviewState: "approved",
    });
    expect(updated.readyForDeployAt).toBe(now.toISOString());
  });

  it("update() respects an explicitly provided readyForDeployAt when approving", async () => {
    const now = new Date("2026-07-01T14:00:00.000Z");
    const clock = FixedClock(now);
    const svc = new PullRequestService(prisma, clock);

    const { record: created } = await svc.claim(
      "app-vitals/shipwright",
      803,
      "sha-approve-3",
      "agent-a",
    );
    expect(created.readyForDeployAt).toBeNull();

    const explicit = "2026-06-30T00:00:00.000Z";
    const updated = await svc.update(created.id, {
      reviewState: "approved",
      readyForDeployAt: explicit,
    });
    expect(updated.readyForDeployAt).toBe(explicit);
  });
});

// ─── claimNext() integration tests ───────────────────────────────────────────

describeOrSkip("PullRequestService.claimNext() (integration)", () => {
  let prisma: PrismaClient;
  let service: PullRequestService;

  beforeEach(async () => {
    prisma = makePrisma();
    service = new PullRequestService(prisma);
    await prisma.pullRequest.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("claimNext() returns null when active claim count >= maxConcurrent", async () => {
    const now = new Date();
    const freshHb = now.toISOString();

    // Create maxConcurrent=2 PRs already claimed by agent-a with fresh heartbeat
    await prisma.pullRequest.createMany({
      data: [
        {
          repo: "app-vitals/shipwright",
          prNumber: 901,
          commitSha: "sha-a",
          reviewState: "in_progress",
          state: "open",
          claimedBy: "agent-a",
          claimedAt: freshHb,
          heartbeatAt: freshHb,
        },
        {
          repo: "app-vitals/shipwright",
          prNumber: 902,
          commitSha: "sha-b",
          reviewState: "in_progress",
          state: "open",
          claimedBy: "agent-a",
          claimedAt: freshHb,
          heartbeatAt: freshHb,
        },
      ],
    });

    // Also create an unclaimed PR that would normally be picked up
    await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 903,
        reviewState: "pending",
        state: "open",
      },
    });

    const result = await service.claimNext("agent-a", 2);
    expect(result).toBeNull();
  });

  it("claimNext() returns oldest eligible PR by COALESCE timestamp ordering across phases", async () => {
    // PR 1: posted (ready for patch), readyForPatchAt=T+2
    await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 910,
        commitSha: "sha-patch",
        reviewState: "posted",
        state: "open",
        claimedBy: null,
        readyForPatchAt: "2026-07-01T02:00:00.000Z",
      },
    });

    // PR 2: pending (ready for review), readyForReviewAt=T+1 (oldest)
    await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 911,
        commitSha: "sha-review",
        reviewState: "pending",
        state: "open",
        claimedBy: null,
        readyForReviewAt: "2026-07-01T01:00:00.000Z",
      },
    });

    // PR 3: approved (ready for deploy), readyForDeployAt=T+3
    await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 912,
        commitSha: "sha-deploy",
        reviewState: "approved",
        state: "open",
        claimedBy: null,
        readyForDeployAt: "2026-07-01T03:00:00.000Z",
      },
    });

    // Should pick PR 911 (oldest COALESCE timestamp = readyForReviewAt T+1)
    const result = await service.claimNext("agent-z", 5);
    expect(result).not.toBeNull();
    expect(result?.pr.prNumber).toBe(911);
    expect(result?.phase).toBe("review");
  });

  it("claimNext() determines phase from reviewState: pending→review, posted→patch, approved→deploy", async () => {
    // Only one PR, posted
    await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 920,
        commitSha: "sha-phase",
        reviewState: "posted",
        state: "open",
        claimedBy: null,
        readyForPatchAt: "2026-07-01T01:00:00.000Z",
      },
    });

    const result = await service.claimNext("agent-z", 5);
    expect(result).not.toBeNull();
    expect(result?.phase).toBe("patch");
    expect(result?.pr.phase).toBe("patch");
  });

  it("claimNext() sets readyForReviewAt=now on first claim (when null)", async () => {
    const now = new Date("2026-07-01T10:00:00.000Z");
    const clock = FixedClock(now);
    const svc = new PullRequestService(prisma, clock);

    await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 930,
        reviewState: "pending",
        state: "open",
        claimedBy: null,
        readyForReviewAt: null,
      },
    });

    const result = await svc.claimNext("agent-z", 5);
    expect(result).not.toBeNull();
    expect(result?.pr.readyForReviewAt).toBe(now.toISOString());
  });

  it("claimNext() returns null when no eligible PRs exist", async () => {
    // Only a closed PR — should not be picked up
    await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 940,
        reviewState: "pending",
        state: "closed",
        claimedBy: null,
      },
    });

    const result = await service.claimNext("agent-z", 5);
    expect(result).toBeNull();
  });

  it("claimNext() skips PRs already claimed by others with fresh heartbeat", async () => {
    const now = new Date().toISOString();

    // PR claimed by someone else with fresh heartbeat
    await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 950,
        commitSha: "sha-claimed",
        reviewState: "pending",
        state: "open",
        claimedBy: "agent-other",
        claimedAt: now,
        heartbeatAt: now,
        readyForReviewAt: "2026-07-01T01:00:00.000Z",
      },
    });

    const result = await service.claimNext("agent-a", 5);
    expect(result).toBeNull();
  });

  it("claimNext() with repos scope skips out-of-scope PRs and claims in-scope ones", async () => {
    // Out-of-scope PR is globally older (would win without SQL filter)
    await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/other-repo",
        prNumber: 1,
        commitSha: "sha-out",
        reviewState: "pending",
        state: "open",
        readyForReviewAt: "2026-07-01T00:00:00.000Z",
      },
    });

    // In-scope PR is newer
    const inScopePr = await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 2,
        commitSha: "sha-in",
        reviewState: "pending",
        state: "open",
        readyForReviewAt: "2026-07-01T01:00:00.000Z",
      },
    });

    const result = await service.claimNext("agent-scoped", 5, [
      "app-vitals/shipwright",
    ]);

    expect(result).not.toBeNull();
    expect(result?.pr.id).toBe(inScopePr.id);
    expect(result?.pr.repo).toBe("app-vitals/shipwright");
    expect(result?.phase).toBe("review");
  });
});
