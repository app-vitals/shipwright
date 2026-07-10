/**
 * task-store/src/stale-claim-reaper.unit.test.ts
 *
 * Unit tests for StaleClaimReaper. Uses a Prisma double (plain object with a
 * $executeRaw stub) and FixedClock for deterministic time.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FixedClock } from "./clock.ts";
import { StaleClaimReaper } from "./stale-claim-reaper.ts";

// ─── Prisma double ────────────────────────────────────────────────────────────

interface ExecuteRawCall {
  strings: TemplateStringsArray;
  values: unknown[];
}

/**
 * makePrismaDouble — accepts per-call return values.
 * `affectedRowsByCall` can be a single number (applied to the first call only;
 * subsequent calls return 0) or an array of per-call values.
 * This lets tests isolate Task vs PullRequest reap behaviour without coupling
 * to the order of $executeRaw calls.
 */
function makePrismaDouble(affectedRowsByCall: number | number[] = 0) {
  const calls: ExecuteRawCall[] = [];
  const rowsByCall = Array.isArray(affectedRowsByCall)
    ? affectedRowsByCall
    : [affectedRowsByCall];

  const prisma = {
    $executeRaw(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<number> {
      calls.push({ strings, values });
      const idx = calls.length - 1;
      return Promise.resolve(rowsByCall[idx] ?? 0);
    },
    _calls: calls,
  };

  return prisma as unknown as {
    $executeRaw: (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<number>;
    _calls: ExecuteRawCall[];
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 2_100_000;

/** Build a Date that is `offsetMs` milliseconds before `now`. */
function msAgo(now: Date, offsetMs: number): Date {
  return new Date(now.getTime() - offsetMs);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("StaleClaimReaper", () => {
  const NOW = new Date("2026-06-24T12:00:00.000Z");
  const clock = FixedClock(NOW);

  beforeEach(() => {
    // biome-ignore lint/performance/noDelete: env var must be fully removed, not set to "undefined" string
    delete process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: env var must be fully removed, not set to "undefined" string
    delete process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS;
  });

  test("reaps stale task with heartbeatAt < cutoff", async () => {
    const prisma = makePrismaDouble(1);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(1);
    // Two $executeRaw calls: one for Task, one for PullRequest
    expect(prisma._calls).toHaveLength(2);

    // The cutoff should be now - DEFAULT_TTL_MS (unified TTL for both record types)
    const expectedCutoff = msAgo(NOW, DEFAULT_TTL_MS).toISOString();
    const call = prisma._calls[0];
    // The cutoff is the first interpolated value
    expect(call.values[0]).toBe(expectedCutoff);
  });

  test("skips fresh task with heartbeatAt >= cutoff (cutoff computation is correct)", async () => {
    const prisma = makePrismaDouble(0);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    // Verify that the cutoff value passed to $executeRaw is exactly now - TTL
    const expectedCutoff = new Date(
      NOW.getTime() - DEFAULT_TTL_MS,
    ).toISOString();
    const call = prisma._calls[0];
    expect(call.values[0]).toBe(expectedCutoff);

    // A task with heartbeatAt = NOW (fresh) would NOT match heartbeatAt < cutoff,
    // so it is untouched. We verify this via the cutoff being in the past.
    const cutoff = new Date(call.values[0] as string);
    expect(cutoff < NOW).toBe(true);
  });

  test("reaps task with heartbeatAt=null and stale claimedAt", async () => {
    const prisma = makePrismaDouble(1);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(1);
    // Two $executeRaw calls: one for Task, one for PullRequest
    expect(prisma._calls).toHaveLength(2);
    const sql = prisma._calls[0].strings.join("?");
    expect(sql).toContain('"heartbeatAt" IS NULL');
    expect(sql).toContain('"claimedAt"');
  });

  test("skips task with heartbeatAt=null and fresh claimedAt (not reset)", async () => {
    // Returning 0 means no tasks were reset — fresh claimedAt tasks are excluded
    const prisma = makePrismaDouble(0);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(0);
    // Confirm the WHERE clause includes the cutoff used to filter claimedAt too
    const call = prisma._calls[0];
    expect(call.values[0]).toBe(
      new Date(NOW.getTime() - DEFAULT_TTL_MS).toISOString(),
    );
  });

  test("env var SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS overrides default TTL for PR reap", async () => {
    const customTtlMs = 60_000; // 1 minute instead of 35
    process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS = String(customTtlMs);

    const prisma = makePrismaDouble(0);
    // StaleClaimReaper reads the env var at construction time (or reap time)
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const expectedCutoff = new Date(NOW.getTime() - customTtlMs).toISOString();
    // PullRequest claims are the second $executeRaw call
    const call = prisma._calls[1];
    expect(call.values[0]).toBe(expectedCutoff);
  });

  test("env var SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS overrides default TTL for Task reap", async () => {
    const customTtlMs = 60_000; // 1 minute instead of 35
    process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS = String(customTtlMs);

    const prisma = makePrismaDouble(0);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const expectedCutoff = new Date(NOW.getTime() - customTtlMs).toISOString();
    // Task claims are the first $executeRaw call
    const call = prisma._calls[0];
    expect(call.values[0]).toBe(expectedCutoff);
  });

  test("Task TTL and PullRequest TTL cutoffs are the same unified value", async () => {
    const prisma = makePrismaDouble([0, 0]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const taskCutoff = prisma._calls[0].values[0] as string;
    const prCutoff = prisma._calls[1].values[0] as string;
    expect(taskCutoff).toBe(prCutoff);
    expect(new Date(taskCutoff).getTime()).toBe(
      new Date(prCutoff).getTime(),
    );
  });

  test("returns count of reaped tasks", async () => {
    const prisma = makePrismaDouble(3);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(3);
  });

  test("clears startedAt in reap SET clause so re-claims get a fresh timestamp", async () => {
    const prisma = makePrismaDouble(1);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const sql = prisma._calls[0].strings.join("?");
    expect(sql).toContain('"startedAt" = NULL');
  });

  // ─── PullRequest reaping ────────────────────────────────────────────────────

  test("reaps 0 stale PRs when none are in_progress", async () => {
    // Both calls return 0: 0 tasks, 0 PRs
    const prisma = makePrismaDouble([0, 0]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(0);
    expect(prisma._calls).toHaveLength(2);
    // Second call targets PullRequest table
    const prSql = prisma._calls[1].strings.join("?");
    expect(prSql).toContain('"PullRequest"');
    expect(prSql).toContain('"reviewState"');
  });

  test("reaps N stale PRs with expired heartbeat", async () => {
    // 0 tasks, 2 stale PRs
    const prisma = makePrismaDouble([0, 2]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(2);
    expect(prisma._calls).toHaveLength(2);
    const prSql = prisma._calls[1].strings.join("?");
    // Resets to pending, clears claim fields
    expect(prSql).toContain("'pending'");
    expect(prSql).toContain('"claimedBy" = NULL');
    expect(prSql).toContain('"claimedAt" = NULL');
    expect(prSql).toContain('"heartbeatAt" = NULL');
    // Same cutoff as Task reap
    const expectedCutoff = new Date(
      NOW.getTime() - DEFAULT_TTL_MS,
    ).toISOString();
    expect(prisma._calls[1].values[0]).toBe(expectedCutoff);
  });

  test("combined count: tasks + PRs both reaped", async () => {
    // 3 tasks + 2 PRs = 5 total
    const prisma = makePrismaDouble([3, 2]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(5);
  });

  test("PR reap WHERE clause covers in_progress with heartbeatAt IS NULL", async () => {
    const prisma = makePrismaDouble([0, 1]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const prSql = prisma._calls[1].strings.join("?");
    expect(prSql).toContain('"heartbeatAt" IS NULL');
    expect(prSql).toContain('"claimedAt"');
  });

  // ─── Phase-aware reaper tests ─────────────────────────────────────────────────

  test("PR reap uses claimedBy IS NOT NULL (phase-agnostic) not reviewState='in_progress'", async () => {
    const prisma = makePrismaDouble([0, 0]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const prSql = prisma._calls[1].strings.join("?");
    // Should filter by claimedBy IS NOT NULL, not reviewState = 'in_progress'
    expect(prSql).toContain('"claimedBy" IS NOT NULL');
    // Should NOT use reviewState = 'in_progress' as the primary filter anymore
    expect(prSql).not.toContain("'in_progress'");
  });

  test("PR reap resets phase=null and clears claim fields", async () => {
    const prisma = makePrismaDouble([0, 1]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const prSql = prisma._calls[1].strings.join("?");
    expect(prSql).toContain('"claimedBy" = NULL');
    expect(prSql).toContain('"claimedAt" = NULL');
    expect(prSql).toContain('"heartbeatAt" = NULL');
    expect(prSql).toContain('"phase" = NULL');
  });

  test("PR reap does not blindly reset reviewState to pending — uses CASE based on phase", async () => {
    const prisma = makePrismaDouble([0, 1]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const prSql = prisma._calls[1].strings.join("?");
    // Should use a CASE expression that only resets to pending when phase was 'review'
    // and preserves 'posted'/'approved' for patch/deploy items
    expect(prSql).toContain("CASE");
    expect(prSql).toContain("'review'");
    expect(prSql).toContain("'pending'");
  });

  // ─── 2_100_000ms unified default TTL boundary ──────────────────────────────

  test("PR claim just under 2_100_000ms old is NOT reaped", async () => {
    // 0 tasks, 0 PRs affected — verifies the cutoff constant and date math
    const prisma = makePrismaDouble([0, 0]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(0);
    expect(prisma._calls).toHaveLength(2);

    // The cutoff used to filter is now - DEFAULT_TTL_MS (2_100_000ms)
    const expectedCutoff = msAgo(NOW, DEFAULT_TTL_MS).toISOString();
    expect(prisma._calls[1].values[0]).toBe(expectedCutoff);

    // A heartbeatAt just under 2_100_000ms old is more recent than the cutoff,
    // so it would not match "heartbeatAt < cutoff" and is correctly excluded.
    const heartbeatAt = msAgo(NOW, DEFAULT_TTL_MS - 1_000);
    expect(heartbeatAt.getTime() > new Date(expectedCutoff).getTime()).toBe(
      true,
    );
  });

  test("PR claim just over 2_100_000ms old IS reaped, reviewState resets to pending", async () => {
    // 0 tasks, 1 PR affected — simulates a claim just past the TTL window
    const prisma = makePrismaDouble([0, 1]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(1);
    expect(prisma._calls).toHaveLength(2);

    const expectedCutoff = msAgo(NOW, DEFAULT_TTL_MS).toISOString();
    expect(prisma._calls[1].values[0]).toBe(expectedCutoff);

    // A heartbeatAt just over 2_100_000ms old is older than the cutoff,
    // so it matches "heartbeatAt < cutoff" and would be reaped.
    const heartbeatAt = msAgo(NOW, DEFAULT_TTL_MS + 1_000);
    expect(heartbeatAt.getTime() < new Date(expectedCutoff).getTime()).toBe(
      true,
    );

    // The reaper resets reviewState to 'pending' for phase='review' claims via CASE.
    const prSql = prisma._calls[1].strings.join("?");
    expect(prSql).toContain("CASE");
    expect(prSql).toContain("'review'");
    expect(prSql).toContain("'pending'");
  });

  test("task claim just under 2_100_000ms old is NOT reaped", async () => {
    const prisma = makePrismaDouble([0, 0]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(0);
    expect(prisma._calls).toHaveLength(2);

    const expectedCutoff = msAgo(NOW, DEFAULT_TTL_MS).toISOString();
    expect(prisma._calls[0].values[0]).toBe(expectedCutoff);

    // A heartbeatAt just under 2_100_000ms old is more recent than the cutoff,
    // so it would not match "heartbeatAt < cutoff" and is correctly excluded.
    const heartbeatAt = msAgo(NOW, DEFAULT_TTL_MS - 1_000);
    expect(heartbeatAt.getTime() > new Date(expectedCutoff).getTime()).toBe(
      true,
    );
  });

  test("task claim just over 2_100_000ms old IS reaped", async () => {
    const prisma = makePrismaDouble([1, 0]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(1);
    expect(prisma._calls).toHaveLength(2);

    const expectedCutoff = msAgo(NOW, DEFAULT_TTL_MS).toISOString();
    expect(prisma._calls[0].values[0]).toBe(expectedCutoff);

    // A heartbeatAt just over 2_100_000ms old is older than the cutoff,
    // so it matches "heartbeatAt < cutoff" and would be reaped.
    const heartbeatAt = msAgo(NOW, DEFAULT_TTL_MS + 1_000);
    expect(heartbeatAt.getTime() < new Date(expectedCutoff).getTime()).toBe(
      true,
    );
  });
});
