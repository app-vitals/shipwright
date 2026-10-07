/**
 * task-store/src/skip-tracking.integration.test.ts
 *
 * Integration tests for skip-count tracking on TaskService and
 * PullRequestService against a real Postgres DB — covers
 * recordSkip()/resetSkip() atomic increment behavior and the auto-block
 * (hitl + blockedReason) that fires once skipCount crosses the threshold (3,
 * mirroring SPIN_DETECTION_THRESHOLD in agent/src/loop-orchestrator.ts).
 *
 * TaskService.recordSkip() is additionally reason-aware (SRB-1.1): every
 * test in this file that doesn't explicitly pass a `reason` relies on
 * recordSkip()'s own "unspecified" default applying identically across
 * calls, so repeated no-reason calls still form one streak — the dedicated
 * "reason-aware streak" describe block below covers same-reason increments,
 * different-reason resets (including from no prior reason), and the
 * threshold crossing's blockedReason/hitl content explicitly.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type PrismaClient, createPrismaClient } from "./prisma-client.ts";
import { FixedClock } from "./clock.ts";
import { NotFoundError } from "./errors.ts";
import { PullRequestService } from "./pull-request-service.ts";
import { TaskService } from "./task-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createPrismaClient(TEST_DB as string);
}

// ─── TaskService.recordSkip / resetSkip ────────────────────────────────────────

describeOrSkip("TaskService.recordSkip/resetSkip (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    // TaskEvent's FK is ON DELETE RESTRICT (TCS-1.1) — clear event rows
    // before their parent Task rows, since recordSkip()/resetSkip() write them.
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("recordSkip() increments skipCount from 0 to 1 and sets lastSkippedAt", async () => {
    const now = new Date("2026-07-21T09:00:00.000Z");
    const clock = FixedClock(now);
    const service = new TaskService(prisma, clock);

    const task = await prisma.task.create({
      data: { title: "Skip me", status: "pending" },
    });

    const updated = await service.recordSkip(task.id);
    expect(updated.skipCount).toBe(1);
    expect(updated.lastSkippedAt).toBe(now.toISOString());
    expect(updated.hitl).not.toBe(true);
    expect(updated.blockedReason).toBeNull();
  });

  it("repeated recordSkip() calls increment skipCount each time and update lastSkippedAt", async () => {
    const t1 = new Date("2026-07-21T09:00:00.000Z");
    const t2 = new Date("2026-07-21T09:05:00.000Z");
    const task = await prisma.task.create({
      data: { title: "Skip repeatedly", status: "pending" },
    });

    const service1 = new TaskService(prisma, FixedClock(t1));
    const first = await service1.recordSkip(task.id);
    expect(first.skipCount).toBe(1);
    expect(first.lastSkippedAt).toBe(t1.toISOString());

    const service2 = new TaskService(prisma, FixedClock(t2));
    const second = await service2.recordSkip(task.id);
    expect(second.skipCount).toBe(2);
    expect(second.lastSkippedAt).toBe(t2.toISOString());
  });

  it("recordSkip() crossing skipCount>=3 sets status:'blocked' and a descriptive blockedReason", async () => {
    const service = new TaskService(
      prisma,
      FixedClock(new Date("2026-07-21T09:00:00.000Z")),
    );
    const task = await prisma.task.create({
      data: { title: "Skip until blocked", status: "pending" },
    });

    await service.recordSkip(task.id);
    await service.recordSkip(task.id);
    const third = await service.recordSkip(task.id);

    expect(third.skipCount).toBe(3);
    expect(third.status).toBe("blocked");
    expect(third.hitl).toBe(true);
    expect(third.blockedReason).toBeTruthy();
    expect(third.blockedReason).toContain("3");
  });

  it("recordSkip() past the threshold keeps incrementing and stays blocked (idempotent-ish, not a guard)", async () => {
    const service = new TaskService(
      prisma,
      FixedClock(new Date("2026-07-21T09:00:00.000Z")),
    );
    const task = await prisma.task.create({
      data: { title: "Skip past threshold", status: "pending" },
    });

    await service.recordSkip(task.id);
    await service.recordSkip(task.id);
    await service.recordSkip(task.id);
    const fourth = await service.recordSkip(task.id);

    expect(fourth.skipCount).toBe(4);
    expect(fourth.status).toBe("blocked");
    expect(fourth.blockedReason).toBeTruthy();
  });

  it("resetSkip() sets skipCount back to 0 and lastSkippedAt back to null", async () => {
    const service = new TaskService(
      prisma,
      FixedClock(new Date("2026-07-21T09:00:00.000Z")),
    );
    const task = await prisma.task.create({
      data: { title: "Skip then reset", status: "pending" },
    });

    await service.recordSkip(task.id);
    await service.recordSkip(task.id);

    const reset = await service.resetSkip(task.id);
    expect(reset.skipCount).toBe(0);
    expect(reset.lastSkippedAt).toBeNull();
    expect(reset.lastSkipReason).toBeNull();
  });

  it("resetSkip() works even when skipCount is already 0 (no-op-ish)", async () => {
    const service = new TaskService(prisma);
    const task = await prisma.task.create({
      data: { title: "Never skipped", status: "pending" },
    });

    const reset = await service.resetSkip(task.id);
    expect(reset.skipCount).toBe(0);
    expect(reset.lastSkippedAt).toBeNull();
    expect(reset.lastSkipReason).toBeNull();
  });

  it("recordSkip() throws NotFoundError when the task does not exist", async () => {
    const service = new TaskService(prisma);
    let caught: unknown;
    try {
      await service.recordSkip("00000000-0000-0000-0000-000000000000");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
  });

  it("resetSkip() throws NotFoundError when the task does not exist", async () => {
    const service = new TaskService(prisma);
    let caught: unknown;
    try {
      await service.resetSkip("00000000-0000-0000-0000-000000000000");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
  });
});

// ─── TaskService.recordSkip() reason-aware streak (SRB-1.1) ────────────────────
//
// recordSkip(id, reason) resets the streak (skipCount=1, new lastSkipReason)
// when `reason` differs from the task's current lastSkipReason — including
// when lastSkipReason is null (no prior streak) — and increments skipCount
// when it matches. Crossing SKIP_BLOCK_THRESHOLD (3) sets status:'blocked',
// hitl:true, and a blockedReason naming the consecutive count and reason.

describeOrSkip("TaskService.recordSkip() reason-aware streak (SRB-1.1)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("first-ever skip (lastSkipReason starts null) starts a streak at skipCount=1 and stores the reason", async () => {
    const service = new TaskService(
      prisma,
      FixedClock(new Date("2026-09-01T00:00:00.000Z")),
    );
    const task = await prisma.task.create({
      data: { title: "Reason-aware", status: "pending" },
    });

    const updated = await service.recordSkip(
      task.id,
      "dev-task:deferred:unmet-hidden-requirement",
    );

    expect(updated.skipCount).toBe(1);
    expect(updated.lastSkipReason).toBe(
      "dev-task:deferred:unmet-hidden-requirement",
    );
  });

  it("consecutive recordSkip() calls with the SAME reason increment skipCount and keep lastSkipReason", async () => {
    const service = new TaskService(
      prisma,
      FixedClock(new Date("2026-09-01T00:00:00.000Z")),
    );
    const task = await prisma.task.create({
      data: { title: "Same reason streak", status: "pending" },
    });

    await service.recordSkip(
      task.id,
      "dev-task:deferred:unmet-hidden-requirement",
    );
    const second = await service.recordSkip(
      task.id,
      "dev-task:deferred:unmet-hidden-requirement",
    );

    expect(second.skipCount).toBe(2);
    expect(second.lastSkipReason).toBe(
      "dev-task:deferred:unmet-hidden-requirement",
    );
    expect(second.status).not.toBe("blocked");
  });

  it("a recordSkip() call with a DIFFERENT reason resets skipCount to 1 and overwrites lastSkipReason", async () => {
    const service = new TaskService(
      prisma,
      FixedClock(new Date("2026-09-01T00:00:00.000Z")),
    );
    const task = await prisma.task.create({
      data: { title: "Reason change", status: "pending" },
    });

    await service.recordSkip(task.id, "reason-a");
    await service.recordSkip(task.id, "reason-a");
    const third = await service.recordSkip(task.id, "reason-b");

    expect(third.skipCount).toBe(1);
    expect(third.lastSkipReason).toBe("reason-b");
    expect(third.status).not.toBe("blocked");
  });

  it("three consecutive skips with an identical reason cross the threshold: status:'blocked', hitl:true, blockedReason names the count and reason", async () => {
    const service = new TaskService(
      prisma,
      FixedClock(new Date("2026-09-01T00:00:00.000Z")),
    );
    const task = await prisma.task.create({
      data: { title: "Threshold by reason", status: "pending" },
    });

    await service.recordSkip(
      task.id,
      "dev-task:deferred:unmet-hidden-requirement",
    );
    await service.recordSkip(
      task.id,
      "dev-task:deferred:unmet-hidden-requirement",
    );
    const third = await service.recordSkip(
      task.id,
      "dev-task:deferred:unmet-hidden-requirement",
    );

    expect(third.skipCount).toBe(3);
    expect(third.status).toBe("blocked");
    expect(third.hitl).toBe(true);
    expect(third.blockedReason).toContain("3");
    expect(third.blockedReason).toContain(
      "dev-task:deferred:unmet-hidden-requirement",
    );
  });

  it("a reason change resets the streak and does NOT trip the threshold, even after 2 prior same-reason skips", async () => {
    const service = new TaskService(
      prisma,
      FixedClock(new Date("2026-09-01T00:00:00.000Z")),
    );
    const task = await prisma.task.create({
      data: { title: "Reset avoids false block", status: "pending" },
    });

    await service.recordSkip(task.id, "reason-a");
    await service.recordSkip(task.id, "reason-a");
    const third = await service.recordSkip(task.id, "reason-b");

    expect(third.skipCount).toBe(1);
    expect(third.status).not.toBe("blocked");
    expect(third.hitl).not.toBe(true);
    expect(third.blockedReason).toBeNull();
  });

  it("an omitted reason defaults server-side to 'unspecified' and still forms a streak", async () => {
    const service = new TaskService(
      prisma,
      FixedClock(new Date("2026-09-01T00:00:00.000Z")),
    );
    const task = await prisma.task.create({
      data: { title: "Default reason", status: "pending" },
    });

    const first = await service.recordSkip(task.id);
    expect(first.lastSkipReason).toBe("unspecified");

    const second = await service.recordSkip(task.id);
    expect(second.skipCount).toBe(2);
    expect(second.lastSkipReason).toBe("unspecified");
  });
});

// ─── PullRequestService.recordSkip / resetSkip ─────────────────────────────────

describeOrSkip("PullRequestService.recordSkip/resetSkip (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    // PullRequestEvent's FK is ON DELETE RESTRICT (PSA-1.2) — clear event
    // rows before their parent PullRequest rows, since recordSkip/resetSkip
    // now write them.
    await prisma.pullRequestEvent.deleteMany();
    await prisma.prFinding.deleteMany();
    await prisma.pullRequest.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("recordSkip() increments skipCount from 0 to 1 and sets lastSkippedAt", async () => {
    const now = new Date("2026-07-21T09:00:00.000Z");
    const clock = FixedClock(now);
    const service = new PullRequestService(prisma, clock);

    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 9001 },
    });

    const updated = await service.recordSkip(pr.id);
    expect(updated.skipCount).toBe(1);
    expect(updated.lastSkippedAt).toBe(now.toISOString());
    expect(updated.blocked).toBe(false);
    expect(updated.blockedReason).toBeNull();
  });

  it("repeated recordSkip() calls increment skipCount each time and update lastSkippedAt", async () => {
    const t1 = new Date("2026-07-21T09:00:00.000Z");
    const t2 = new Date("2026-07-21T09:05:00.000Z");
    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 9002 },
    });

    const service1 = new PullRequestService(prisma, FixedClock(t1));
    const first = await service1.recordSkip(pr.id);
    expect(first.skipCount).toBe(1);
    expect(first.lastSkippedAt).toBe(t1.toISOString());

    const service2 = new PullRequestService(prisma, FixedClock(t2));
    const second = await service2.recordSkip(pr.id);
    expect(second.skipCount).toBe(2);
    expect(second.lastSkippedAt).toBe(t2.toISOString());
  });

  it("recordSkip() crossing skipCount>=3 sets blocked:true and a descriptive blockedReason", async () => {
    const service = new PullRequestService(
      prisma,
      FixedClock(new Date("2026-07-21T09:00:00.000Z")),
    );
    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 9003 },
    });

    await service.recordSkip(pr.id);
    await service.recordSkip(pr.id);
    const third = await service.recordSkip(pr.id);

    expect(third.skipCount).toBe(3);
    expect(third.blocked).toBe(true);
    expect(third.blockedReason).toBeTruthy();
    expect(third.blockedReason).toContain("3");
  });

  it("recordSkip() past the threshold keeps incrementing and stays blocked", async () => {
    const service = new PullRequestService(
      prisma,
      FixedClock(new Date("2026-07-21T09:00:00.000Z")),
    );
    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 9004 },
    });

    await service.recordSkip(pr.id);
    await service.recordSkip(pr.id);
    await service.recordSkip(pr.id);
    const fourth = await service.recordSkip(pr.id);

    expect(fourth.skipCount).toBe(4);
    expect(fourth.blocked).toBe(true);
    expect(fourth.blockedReason).toBeTruthy();
  });

  it("resetSkip() sets skipCount back to 0 and lastSkippedAt back to null", async () => {
    const service = new PullRequestService(
      prisma,
      FixedClock(new Date("2026-07-21T09:00:00.000Z")),
    );
    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 9005 },
    });

    await service.recordSkip(pr.id);
    await service.recordSkip(pr.id);

    const reset = await service.resetSkip(pr.id);
    expect(reset.skipCount).toBe(0);
    expect(reset.lastSkippedAt).toBeNull();
  });

  it("resetSkip() works even when skipCount is already 0 (no-op-ish)", async () => {
    const service = new PullRequestService(prisma);
    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 9006 },
    });

    const reset = await service.resetSkip(pr.id);
    expect(reset.skipCount).toBe(0);
    expect(reset.lastSkippedAt).toBeNull();
  });

  it("recordSkip() throws NotFoundError when the PR does not exist", async () => {
    const service = new PullRequestService(prisma);
    let caught: unknown;
    try {
      await service.recordSkip("00000000-0000-0000-0000-000000000000");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
  });

  it("resetSkip() throws NotFoundError when the PR does not exist", async () => {
    const service = new PullRequestService(prisma);
    let caught: unknown;
    try {
      await service.resetSkip("00000000-0000-0000-0000-000000000000");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
  });

  describe("block-time state (PSL-3.1)", () => {
    const NOW = new Date("2026-10-07T12:00:00.000Z");

    it("recordSkip() below the threshold sets none of the block-time fields", async () => {
      const service = new PullRequestService(prisma, FixedClock(NOW));
      const pr = await prisma.pullRequest.create({
        data: {
          repo: "app-vitals/shipwright",
          prNumber: 9101,
          commitSha: "sha1",
        },
      });

      await service.recordSkip(pr.id);
      const second = await service.recordSkip(pr.id);

      expect(second.blocked).toBe(false);
      expect(second.blockedHeadSha).toBeNull();
      expect(second.blockedReviewId).toBeNull();
      expect(second.blockedAt).toBeNull();
      expect(second.lastAutoBlockReason).toBeNull();
      expect(second.lastAutoBlockedAt).toBeNull();
    });

    it("recordSkip() at the threshold records head SHA, latest review, and auto-block history", async () => {
      const service = new PullRequestService(prisma, FixedClock(NOW));
      const pr = await prisma.pullRequest.create({
        data: {
          repo: "app-vitals/shipwright",
          prNumber: 9102,
          commitSha: "sha2",
        },
      });
      await prisma.prFinding.create({
        data: {
          prRecordId: pr.id,
          ref: "old",
          disposition: "resolved",
          source: "review",
          evidence: "e",
          at: NOW.toISOString(),
          createdAt: new Date("2026-10-07T10:00:00.000Z"),
        },
      });
      const latest = await prisma.prFinding.create({
        data: {
          prRecordId: pr.id,
          ref: "new",
          disposition: "resolved",
          source: "review",
          evidence: "e",
          at: NOW.toISOString(),
          createdAt: new Date("2026-10-07T11:00:00.000Z"),
        },
      });

      await service.recordSkip(pr.id);
      await service.recordSkip(pr.id);
      const third = await service.recordSkip(pr.id);

      expect(third.blocked).toBe(true);
      expect(third.blockedHeadSha).toBe("sha2");
      expect(third.blockedReviewId).toBe(latest.id);
      expect(third.blockedAt).toBe(NOW.toISOString());
      expect(third.lastAutoBlockReason).toBe(third.blockedReason);
      expect(third.lastAutoBlockedAt).toBe(NOW.toISOString());
    });

    it("resetSkip() clears the live block but retains lastAutoBlock* history", async () => {
      const service = new PullRequestService(prisma, FixedClock(NOW));
      const pr = await prisma.pullRequest.create({
        data: {
          repo: "app-vitals/shipwright",
          prNumber: 9103,
          commitSha: "sha3",
        },
      });
      await service.recordSkip(pr.id);
      await service.recordSkip(pr.id);
      const blocked = await service.recordSkip(pr.id);

      const reset = await service.resetSkip(pr.id);

      expect(reset.blocked).toBe(false);
      expect(reset.blockedReason).toBeNull();
      expect(reset.skipCount).toBe(0);
      expect(reset.lastAutoBlockReason).toBe(blocked.blockedReason);
      expect(reset.lastAutoBlockedAt).toBe(NOW.toISOString());
    });
  });
});
