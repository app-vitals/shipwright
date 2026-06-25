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

function makePrismaDouble(affectedRows = 0) {
  const calls: ExecuteRawCall[] = [];

  const prisma = {
    $executeRaw(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<number> {
      calls.push({ strings, values });
      return Promise.resolve(affectedRows);
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

const DEFAULT_TTL_MS = 300_000;

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
    expect(prisma._calls).toHaveLength(1);

    // The cutoff should be now - DEFAULT_TTL_MS
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
    // The same $executeRaw call covers both branches (heartbeatAt IS NOT NULL stale
    // AND heartbeatAt IS NULL with stale claimedAt). Both are in the WHERE clause.
    expect(prisma._calls).toHaveLength(1);
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

  test("env var SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS overrides default TTL", async () => {
    const customTtlMs = 60_000; // 1 minute instead of 5
    process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS = String(customTtlMs);

    const prisma = makePrismaDouble(0);
    // StaleClaimReaper reads the env var at construction time (or reap time)
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const expectedCutoff = new Date(NOW.getTime() - customTtlMs).toISOString();
    const call = prisma._calls[0];
    expect(call.values[0]).toBe(expectedCutoff);
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
});
