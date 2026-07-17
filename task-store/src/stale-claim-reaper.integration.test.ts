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

const DEFAULT_TTL_MS = 2_100_000;

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
