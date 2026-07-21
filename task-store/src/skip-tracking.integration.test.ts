/**
 * task-store/src/skip-tracking.integration.test.ts
 *
 * Integration tests for skip-count tracking on TaskService and
 * PullRequestService against a real Postgres DB — covers
 * recordSkip()/resetSkip() atomic increment behavior and the auto-block
 * (hitl + blockedReason) that fires once skipCount crosses the threshold (3,
 * mirroring SPIN_DETECTION_THRESHOLD in agent/src/loop-orchestrator.ts).
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { FixedClock } from "./clock.ts";
import { NotFoundError } from "./errors.ts";
import { PullRequestService } from "./pull-request-service.ts";
import { TaskService } from "./task-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    // TEST_DB is guaranteed set — the describe block is skipped otherwise.
    datasources: { db: { url: TEST_DB as string } },
  });
}

// ─── TaskService.recordSkip / resetSkip ────────────────────────────────────────

describeOrSkip("TaskService.recordSkip/resetSkip (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
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

  it("recordSkip() crossing skipCount>=3 sets hitl:true and a descriptive blockedReason", async () => {
    const service = new TaskService(prisma, FixedClock(new Date("2026-07-21T09:00:00.000Z")));
    const task = await prisma.task.create({
      data: { title: "Skip until blocked", status: "pending" },
    });

    await service.recordSkip(task.id);
    await service.recordSkip(task.id);
    const third = await service.recordSkip(task.id);

    expect(third.skipCount).toBe(3);
    expect(third.hitl).toBe(true);
    expect(third.blockedReason).toBeTruthy();
    expect(third.blockedReason).toContain("3");
  });

  it("recordSkip() past the threshold keeps incrementing and stays blocked (idempotent-ish, not a guard)", async () => {
    const service = new TaskService(prisma, FixedClock(new Date("2026-07-21T09:00:00.000Z")));
    const task = await prisma.task.create({
      data: { title: "Skip past threshold", status: "pending" },
    });

    await service.recordSkip(task.id);
    await service.recordSkip(task.id);
    await service.recordSkip(task.id);
    const fourth = await service.recordSkip(task.id);

    expect(fourth.skipCount).toBe(4);
    expect(fourth.hitl).toBe(true);
    expect(fourth.blockedReason).toBeTruthy();
  });

  it("resetSkip() sets skipCount back to 0 and lastSkippedAt back to null", async () => {
    const service = new TaskService(prisma, FixedClock(new Date("2026-07-21T09:00:00.000Z")));
    const task = await prisma.task.create({
      data: { title: "Skip then reset", status: "pending" },
    });

    await service.recordSkip(task.id);
    await service.recordSkip(task.id);

    const reset = await service.resetSkip(task.id);
    expect(reset.skipCount).toBe(0);
    expect(reset.lastSkippedAt).toBeNull();
  });

  it("resetSkip() works even when skipCount is already 0 (no-op-ish)", async () => {
    const service = new TaskService(prisma);
    const task = await prisma.task.create({
      data: { title: "Never skipped", status: "pending" },
    });

    const reset = await service.resetSkip(task.id);
    expect(reset.skipCount).toBe(0);
    expect(reset.lastSkippedAt).toBeNull();
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

// ─── PullRequestService.recordSkip / resetSkip ─────────────────────────────────

describeOrSkip("PullRequestService.recordSkip/resetSkip (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
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
    expect(updated.hitl).toBe(false);
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

  it("recordSkip() crossing skipCount>=3 sets hitl:true and a descriptive blockedReason", async () => {
    const service = new PullRequestService(prisma, FixedClock(new Date("2026-07-21T09:00:00.000Z")));
    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 9003 },
    });

    await service.recordSkip(pr.id);
    await service.recordSkip(pr.id);
    const third = await service.recordSkip(pr.id);

    expect(third.skipCount).toBe(3);
    expect(third.hitl).toBe(true);
    expect(third.blockedReason).toBeTruthy();
    expect(third.blockedReason).toContain("3");
  });

  it("recordSkip() past the threshold keeps incrementing and stays blocked", async () => {
    const service = new PullRequestService(prisma, FixedClock(new Date("2026-07-21T09:00:00.000Z")));
    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 9004 },
    });

    await service.recordSkip(pr.id);
    await service.recordSkip(pr.id);
    await service.recordSkip(pr.id);
    const fourth = await service.recordSkip(pr.id);

    expect(fourth.skipCount).toBe(4);
    expect(fourth.hitl).toBe(true);
    expect(fourth.blockedReason).toBeTruthy();
  });

  it("resetSkip() sets skipCount back to 0 and lastSkippedAt back to null", async () => {
    const service = new PullRequestService(prisma, FixedClock(new Date("2026-07-21T09:00:00.000Z")));
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
});
