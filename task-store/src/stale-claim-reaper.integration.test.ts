/**
 * task-store/src/stale-claim-reaper.integration.test.ts
 *
 * Integration tests for StaleClaimReaper against a real Postgres DB. Verifies
 * the phase/reviewState-aware reap semantics end to end (raw SQL CASE + WHERE
 * behaviour that the unit tests can only assert on as SQL text).
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { DEFAULT_CLAIM_TTL_MS } from "@shipwright/lib/claim-ttl";
import { PrismaClient } from "../prisma/client/index.js";
import { FixedClock } from "./clock.ts";
import { StaleClaimReaper } from "./stale-claim-reaper.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: TEST_DB as string } },
  });
}

// Import the real shared constant rather than a hardcoded literal so this
// test tracks any future bump to DEFAULT_CLAUDE_TIMEOUT_MS automatically.
const DEFAULT_TTL_MS = DEFAULT_CLAIM_TTL_MS;

describeOrSkip("StaleClaimReaper Task reaping (integration)", () => {
  const NOW = new Date("2026-09-01T12:00:00.000Z");
  const STALE = new Date(
    NOW.getTime() - DEFAULT_TTL_MS - 5 * 60_000,
  ).toISOString();
  const FRESH = new Date(NOW.getTime() - 60_000).toISOString();

  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    // TaskEvent's FK is ON DELETE RESTRICT (TCS-1.1) — clear event rows
    // before their parent Task rows, in case another test file sharing
    // TEST_DB left rows behind. reap() also touches PullRequest in the same
    // pass, so clear that table (and its FK-restricted event rows) too —
    // otherwise a stray PullRequest row left by the sibling describe block
    // below would inflate this suite's `reaped` count.
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    await prisma.pullRequestEvent.deleteMany();
    await prisma.pullRequest.deleteMany();
  });

  it("(TCS-1.3) reaps a stale in_progress task and writes the expected TaskEvent rows", async () => {
    const staleTask = await prisma.task.create({
      data: {
        title: "stale-in-progress-task",
        status: "in_progress",
        claimedBy: "agent-stale",
        claimedAt: STALE,
        heartbeatAt: STALE,
        startedAt: STALE,
      },
    });

    const freshTask = await prisma.task.create({
      data: {
        title: "fresh-in-progress-task",
        status: "in_progress",
        claimedBy: "agent-fresh",
        claimedAt: FRESH,
        heartbeatAt: FRESH,
        startedAt: FRESH,
      },
    });

    const reaper = new StaleClaimReaper(prisma, FixedClock(NOW));
    const reaped = await reaper.reap();

    expect(reaped).toBe(1);

    const row = await prisma.task.findUnique({ where: { id: staleTask.id } });
    expect(row).not.toBeNull();
    expect(row?.status).toBe("pending");
    expect(row?.claimedBy).toBeNull();
    expect(row?.claimedAt).toBeNull();
    expect(row?.heartbeatAt).toBeNull();
    expect(row?.startedAt).toBeNull();

    // The fresh control is untouched.
    const freshRow = await prisma.task.findUnique({
      where: { id: freshTask.id },
    });
    expect(freshRow?.status).toBe("in_progress");
    expect(freshRow?.claimedBy).toBe("agent-fresh");

    const events = await prisma.taskEvent.findMany({
      where: { taskId: staleTask.id },
      orderBy: { field: "asc" },
    });

    // status/claimedBy/claimedAt/startedAt are audited fields that changed;
    // heartbeatAt is excluded from the audit trail (matches
    // computeTaskTransitionDiff's TASK_AUDITED_FIELDS allowlist and every
    // other TaskEvent-writing call site in this codebase — see claim()'s
    // TCS-1.1 integration test for the identical exclusion).
    const byField = Object.fromEntries(events.map((e) => [e.field, e]));
    expect(Object.keys(byField).sort()).toEqual(
      ["claimedAt", "claimedBy", "startedAt", "status"].sort(),
    );

    expect(byField.status.oldValue).toBe("in_progress");
    expect(byField.status.newValue).toBe("pending");
    expect(byField.status.method).toBe("reap");
    expect(byField.status.actor).toBeNull();

    expect(byField.claimedBy.oldValue).toBe("agent-stale");
    expect(byField.claimedBy.newValue).toBeNull();
    expect(byField.claimedBy.method).toBe("reap");
    expect(byField.claimedBy.actor).toBeNull();

    expect(byField.claimedAt.oldValue).toBe(STALE);
    expect(byField.claimedAt.newValue).toBeNull();

    expect(byField.startedAt.oldValue).toBe(STALE);
    expect(byField.startedAt.newValue).toBeNull();

    // No heartbeatAt row, even though heartbeatAt was nulled on the Task row.
    expect(byField.heartbeatAt).toBeUndefined();

    // All rows from this reap share the same `at` stamp.
    const atValues = new Set(events.map((e) => e.at));
    expect(atValues.size).toBe(1);

    // The fresh, untouched task produced no events at all.
    const freshEvents = await prisma.taskEvent.findMany({
      where: { taskId: freshTask.id },
    });
    expect(freshEvents).toHaveLength(0);
  });

  it("(TCS-1.3) reaps 0 tasks and writes 0 TaskEvent rows when nothing is stale", async () => {
    await prisma.task.create({
      data: {
        title: "fresh-task",
        status: "in_progress",
        claimedBy: "agent-fresh",
        claimedAt: FRESH,
        heartbeatAt: FRESH,
      },
    });

    const reaper = new StaleClaimReaper(prisma, FixedClock(NOW));
    const reaped = await reaper.reap();

    expect(reaped).toBe(0);
    const events = await prisma.taskEvent.findMany();
    expect(events).toHaveLength(0);
  });
});

describeOrSkip("StaleClaimReaper PR reaping (integration)", () => {
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  // Well past the TTL window → stale; comfortably within it → fresh.
  const STALE = new Date(
    NOW.getTime() - DEFAULT_TTL_MS - 5 * 60_000,
  ).toISOString();
  const FRESH = new Date(NOW.getTime() - 60_000).toISOString();

  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    // PullRequestEvent's FK is ON DELETE RESTRICT (PSA-1.2) — clear event
    // rows before their parent PullRequest rows, in case another test file
    // sharing TEST_DB left rows behind. reap() also touches Task in the same
    // pass (TCS-1.3), so clear that table too for the same reason as the
    // sibling Task-reaping describe block above.
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    await prisma.pullRequestEvent.deleteMany();
    await prisma.pullRequest.deleteMany();
  });

  it("releases stale claims, regressing only pending/in_progress reviewState and preserving posted/approved", async () => {
    // Four stale-claimed rows, one per reviewState, plus a fresh-claimed control.
    await prisma.pullRequest.createMany({
      data: [
        {
          repo: "app-vitals/shipwright",
          prNumber: 2001,
          reviewState: "pending",
          phase: "review",
          claimedBy: "agent-stale",
          claimedAt: STALE,
          heartbeatAt: STALE,
        },
        {
          repo: "app-vitals/shipwright",
          prNumber: 2002,
          reviewState: "in_progress",
          phase: "review",
          claimedBy: "agent-stale",
          claimedAt: STALE,
          heartbeatAt: STALE,
        },
        {
          repo: "app-vitals/shipwright",
          prNumber: 2003,
          reviewState: "posted",
          phase: "review",
          claimedBy: "agent-stale",
          claimedAt: STALE,
          heartbeatAt: STALE,
        },
        {
          repo: "app-vitals/shipwright",
          prNumber: 2004,
          reviewState: "approved",
          phase: "review",
          claimedBy: "agent-stale",
          claimedAt: STALE,
          heartbeatAt: STALE,
        },
        {
          repo: "app-vitals/shipwright",
          prNumber: 2005,
          reviewState: "in_progress",
          phase: "review",
          claimedBy: "agent-fresh",
          claimedAt: FRESH,
          heartbeatAt: FRESH,
        },
      ],
    });

    const reaper = new StaleClaimReaper(prisma, FixedClock(NOW));
    const reaped = await reaper.reap();

    // Four stale PRs reaped; the fresh control is not.
    expect(reaped).toBe(4);

    const byNumber = async (prNumber: number) => {
      const row = await prisma.pullRequest.findUnique({
        where: { repo_prNumber: { repo: "app-vitals/shipwright", prNumber } },
      });
      if (!row) throw new Error(`expected PR ${prNumber} to exist`);
      return row;
    };

    // pending + in_progress → regressed to pending, claim released.
    for (const prNumber of [2001, 2002]) {
      const row = await byNumber(prNumber);
      expect(row.reviewState).toBe("pending");
      expect(row.claimedBy).toBeNull();
      expect(row.claimedAt).toBeNull();
      expect(row.heartbeatAt).toBeNull();
      expect(row.phase).toBeNull();
    }

    // posted → reviewState preserved, claim released.
    const posted = await byNumber(2003);
    expect(posted.reviewState).toBe("posted");
    expect(posted.claimedBy).toBeNull();
    expect(posted.claimedAt).toBeNull();
    expect(posted.heartbeatAt).toBeNull();
    expect(posted.phase).toBeNull();

    // approved → reviewState preserved, claim released.
    const approved = await byNumber(2004);
    expect(approved.reviewState).toBe("approved");
    expect(approved.claimedBy).toBeNull();
    expect(approved.claimedAt).toBeNull();
    expect(approved.heartbeatAt).toBeNull();
    expect(approved.phase).toBeNull();

    // Fresh control → completely untouched.
    const fresh = await byNumber(2005);
    expect(fresh.reviewState).toBe("in_progress");
    expect(fresh.claimedBy).toBe("agent-fresh");
    expect(fresh.claimedAt).toBe(FRESH);
    expect(fresh.heartbeatAt).toBe(FRESH);
    expect(fresh.phase).toBe("review");
  });
});
