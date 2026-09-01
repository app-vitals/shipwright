/**
 * task-store/src/stale-claim-reaper.unit.test.ts
 *
 * Unit tests for StaleClaimReaper. Uses a Prisma double (plain object with a
 * $executeRaw stub) and FixedClock for deterministic time.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CLAIM_TTL_MS } from "@shipwright/lib/claim-ttl";
import { FixedClock } from "./clock.ts";
import { StaleClaimReaper } from "./stale-claim-reaper.ts";

// ─── Prisma double ────────────────────────────────────────────────────────────

interface ExecuteRawCall {
  strings: TemplateStringsArray;
  values: unknown[];
}

interface TaskEventCreateCall {
  data: {
    taskId: string;
    field: string;
    oldValue: string | null;
    newValue: string | null;
    actor: string | null;
    method: string;
    at: string;
  };
}

/** A minimal stale "before" Task row the double's `task.findMany` returns. */
interface FakeStaleTask {
  id: string;
  status: string;
  claimedBy: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
}

/**
 * makePrismaDouble — models the post-TCS-1.3 shape of `reap()`: the Task
 * branch now runs inside `$transaction` (pre-select via `tx.task.findMany`,
 * RETURNING UPDATE via `tx.$queryRaw`, TaskEvent writes via
 * `tx.taskEvent.create`), while the PullRequest branch is untouched — still a
 * single top-level `$executeRaw` call recorded in `_calls`.
 *
 * `prAffectedRows` is the PullRequest `$executeRaw`'s returned row count
 * (unchanged contract from before TCS-1.3). `staleTasks` is the set of "before"
 * Task rows the double pretends `tx.task.findMany` selected — the double's
 * `tx.$queryRaw` mirrors the real UPDATE...RETURNING by resetting and
 * returning exactly those rows (status='pending', claim fields nulled),
 * since in the real UPDATE any row `findMany` already selected as stale
 * necessarily matches the same WHERE predicate.
 */
function makePrismaDouble(
  prAffectedRows: number | number[] = 0,
  staleTasks: FakeStaleTask[] = [],
) {
  const calls: ExecuteRawCall[] = [];
  const queryRawCalls: ExecuteRawCall[] = [];
  const taskEventCreateCalls: TaskEventCreateCall[] = [];
  const rowsByCall = Array.isArray(prAffectedRows)
    ? prAffectedRows
    : [prAffectedRows];

  interface FakeTx {
    task: { findMany: () => Promise<FakeStaleTask[]> };
    $queryRaw: (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown[]>;
    taskEvent: { create: (call: TaskEventCreateCall) => Promise<unknown> };
  }

  const tx: FakeTx = {
    task: {
      findMany: () => Promise.resolve(staleTasks),
    },
    $queryRaw(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<unknown[]> {
      queryRawCalls.push({ strings, values });
      // Mirrors the real UPDATE...RETURNING: every pre-selected stale row is
      // reset and returned.
      return Promise.resolve(
        staleTasks.map((t) => ({
          id: t.id,
          status: "pending",
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
          startedAt: null,
        })),
      );
    },
    taskEvent: {
      create(call: TaskEventCreateCall) {
        taskEventCreateCalls.push(call);
        return Promise.resolve(call.data);
      },
    },
  };

  const prisma = {
    $transaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
      return fn(tx);
    },
    $executeRaw(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<number> {
      calls.push({ strings, values });
      const idx = calls.length - 1;
      return Promise.resolve(rowsByCall[idx] ?? 0);
    },
    _calls: calls,
    _queryRawCalls: queryRawCalls,
    _taskEventCreateCalls: taskEventCreateCalls,
  };

  return prisma as unknown as {
    $transaction: typeof prisma.$transaction;
    $executeRaw: (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<number>;
    _calls: ExecuteRawCall[];
    _queryRawCalls: ExecuteRawCall[];
    _taskEventCreateCalls: TaskEventCreateCall[];
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Import the real shared constant rather than a hardcoded literal so this
// test tracks any future bump to DEFAULT_CLAUDE_TIMEOUT_MS automatically.
const DEFAULT_TTL_MS = DEFAULT_CLAIM_TTL_MS;

/** Build a Date that is `offsetMs` milliseconds before `now`. */
function msAgo(now: Date, offsetMs: number): Date {
  return new Date(now.getTime() - offsetMs);
}

/** Build a fake stale Task row for the double's `task.findMany` result. */
function fakeStaleTask(overrides: Partial<FakeStaleTask> = {}): FakeStaleTask {
  return {
    id: "task-1",
    status: "in_progress",
    claimedBy: "agent-stale",
    claimedAt: "2026-06-24T10:00:00.000Z",
    heartbeatAt: "2026-06-24T10:00:00.000Z",
    startedAt: "2026-06-24T10:00:00.000Z",
    ...overrides,
  };
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
    const prisma = makePrismaDouble(0, [fakeStaleTask()]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(1);
    // The Task branch's RETURNING UPDATE is a $queryRaw call (inside the
    // transaction); the PullRequest branch is still a top-level $executeRaw.
    expect(prisma._queryRawCalls).toHaveLength(1);
    expect(prisma._calls).toHaveLength(1);

    // The cutoff should be now - DEFAULT_TTL_MS (unified TTL for both record types)
    const expectedCutoff = msAgo(NOW, DEFAULT_TTL_MS).toISOString();
    const call = prisma._queryRawCalls[0];
    // The cutoff is the first interpolated value
    expect(call.values[0]).toBe(expectedCutoff);
  });

  test("skips fresh task with heartbeatAt >= cutoff (cutoff computation is correct)", async () => {
    const prisma = makePrismaDouble(0, []);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    // No stale tasks found → task.findMany returns [] → the RETURNING UPDATE
    // is skipped entirely (no candidate rows to touch).
    expect(prisma._queryRawCalls).toHaveLength(0);

    // Verify the cutoff used for the PullRequest branch's $executeRaw is
    // exactly now - TTL (same unified cutoff value the Task branch computes).
    const expectedCutoff = new Date(
      NOW.getTime() - DEFAULT_TTL_MS,
    ).toISOString();
    const call = prisma._calls[0];
    expect(call.values[0]).toBe(expectedCutoff);

    const cutoff = new Date(call.values[0] as string);
    expect(cutoff < NOW).toBe(true);
  });

  test("reaps task with heartbeatAt=null and stale claimedAt", async () => {
    const prisma = makePrismaDouble(0, [fakeStaleTask({ heartbeatAt: null })]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(1);
    expect(prisma._queryRawCalls).toHaveLength(1);
    const sql = prisma._queryRawCalls[0].strings.join("?");
    expect(sql).toContain('"heartbeatAt" IS NULL');
    expect(sql).toContain('"claimedAt"');
  });

  test("skips task with heartbeatAt=null and fresh claimedAt (not reset)", async () => {
    // No stale tasks pre-selected — fresh claimedAt tasks are excluded before
    // the RETURNING UPDATE ever runs.
    const prisma = makePrismaDouble(0, []);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(0);
    // Confirm the WHERE clause includes the cutoff used to filter claimedAt too
    // (verified via the PullRequest branch's cutoff, which is unified).
    const call = prisma._calls[0];
    expect(call.values[0]).toBe(
      new Date(NOW.getTime() - DEFAULT_TTL_MS).toISOString(),
    );
  });

  test("env var SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS overrides default TTL for PR reap", async () => {
    const customTtlMs = 60_000; // 1 minute instead of the default TTL
    process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS = String(customTtlMs);

    const prisma = makePrismaDouble(0, []);
    // StaleClaimReaper reads the env var at construction time (or reap time)
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const expectedCutoff = new Date(NOW.getTime() - customTtlMs).toISOString();
    // PullRequest claims are still the sole $executeRaw call.
    const call = prisma._calls[0];
    expect(call.values[0]).toBe(expectedCutoff);
  });

  test("env var SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS overrides default TTL for Task reap", async () => {
    const customTtlMs = 60_000; // 1 minute instead of the default TTL
    process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS = String(customTtlMs);

    const prisma = makePrismaDouble(0, [fakeStaleTask()]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const expectedCutoff = new Date(NOW.getTime() - customTtlMs).toISOString();
    // Task claims are the (sole) $queryRaw call.
    const call = prisma._queryRawCalls[0];
    expect(call.values[0]).toBe(expectedCutoff);
  });

  test("Task TTL and PullRequest TTL cutoffs are the same unified value", async () => {
    const prisma = makePrismaDouble(0, [fakeStaleTask()]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const taskCutoff = prisma._queryRawCalls[0].values[0] as string;
    const prCutoff = prisma._calls[0].values[0] as string;
    expect(taskCutoff).toBe(prCutoff);
    expect(new Date(taskCutoff).getTime()).toBe(new Date(prCutoff).getTime());
  });

  test("returns count of reaped tasks", async () => {
    const prisma = makePrismaDouble(0, [
      fakeStaleTask({ id: "t1" }),
      fakeStaleTask({ id: "t2" }),
      fakeStaleTask({ id: "t3" }),
    ]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(3);
  });

  test("clears startedAt in reap SET clause so re-claims get a fresh timestamp", async () => {
    const prisma = makePrismaDouble(0, [fakeStaleTask()]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const sql = prisma._queryRawCalls[0].strings.join("?");
    expect(sql).toContain('"startedAt" = NULL');
  });

  test("reap UPDATE...RETURNING clause reports the audited columns (TCS-1.3)", async () => {
    const prisma = makePrismaDouble(0, [fakeStaleTask()]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const sql = prisma._queryRawCalls[0].strings.join("?");
    expect(sql).toContain("RETURNING");
    expect(sql).toContain("id");
    expect(sql).toContain("status");
    expect(sql).toContain('"claimedBy"');
    expect(sql).toContain('"claimedAt"');
    expect(sql).toContain('"heartbeatAt"');
    expect(sql).toContain('"startedAt"');
  });

  test("writes one TaskEvent row per changed audited field, method=reap, actor=null (TCS-1.3)", async () => {
    const prisma = makePrismaDouble(0, [
      fakeStaleTask({
        id: "task-1",
        status: "in_progress",
        claimedBy: "agent-stale",
        claimedAt: "2026-06-24T10:00:00.000Z",
        heartbeatAt: "2026-06-24T10:00:00.000Z",
        startedAt: "2026-06-24T10:00:00.000Z",
      }),
    ]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    // status/claimedBy/claimedAt/startedAt changed; heartbeatAt is excluded
    // from the audit trail (matches computeTaskTransitionDiff's
    // TASK_AUDITED_FIELDS allowlist), so exactly 4 rows are expected.
    const byField = Object.fromEntries(
      prisma._taskEventCreateCalls.map((c) => [c.data.field, c.data]),
    );
    expect(Object.keys(byField).sort()).toEqual(
      ["claimedAt", "claimedBy", "startedAt", "status"].sort(),
    );

    expect(byField.status.oldValue).toBe("in_progress");
    expect(byField.status.newValue).toBe("pending");
    expect(byField.status.method).toBe("reap");
    expect(byField.status.actor).toBeNull();
    expect(byField.status.taskId).toBe("task-1");

    expect(byField.claimedBy.oldValue).toBe("agent-stale");
    expect(byField.claimedBy.newValue).toBeNull();

    expect(byField.claimedAt.oldValue).toBe("2026-06-24T10:00:00.000Z");
    expect(byField.claimedAt.newValue).toBeNull();

    expect(byField.startedAt.oldValue).toBe("2026-06-24T10:00:00.000Z");
    expect(byField.startedAt.newValue).toBeNull();

    expect(byField.heartbeatAt).toBeUndefined();

    // Every row shares the same `at` stamp.
    const atValues = new Set(
      prisma._taskEventCreateCalls.map((c) => c.data.at),
    );
    expect(atValues.size).toBe(1);
  });

  test("writes no TaskEvent rows when no tasks are stale", async () => {
    const prisma = makePrismaDouble(0, []);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    expect(prisma._taskEventCreateCalls).toHaveLength(0);
  });

  test("writes TaskEvent rows for each of multiple reaped tasks independently", async () => {
    const prisma = makePrismaDouble(0, [
      fakeStaleTask({ id: "task-a", claimedBy: "agent-a" }),
      fakeStaleTask({ id: "task-b", claimedBy: "agent-b" }),
    ]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(2);
    const byTask = new Map<string, TaskEventCreateCall["data"][]>();
    for (const call of prisma._taskEventCreateCalls) {
      const arr = byTask.get(call.data.taskId) ?? [];
      arr.push(call.data);
      byTask.set(call.data.taskId, arr);
    }
    expect(byTask.get("task-a")?.length).toBe(4);
    expect(byTask.get("task-b")?.length).toBe(4);
  });

  // ─── PullRequest reaping ────────────────────────────────────────────────────

  test("reaps 0 stale PRs when none are in_progress", async () => {
    const prisma = makePrismaDouble(0, []);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(0);
    expect(prisma._calls).toHaveLength(1);
    // The sole $executeRaw call targets PullRequest table
    const prSql = prisma._calls[0].strings.join("?");
    expect(prSql).toContain('"PullRequest"');
    expect(prSql).toContain('"reviewState"');
  });

  test("reaps N stale PRs with expired heartbeat", async () => {
    const prisma = makePrismaDouble(2, []);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(2);
    expect(prisma._calls).toHaveLength(1);
    const prSql = prisma._calls[0].strings.join("?");
    // Resets to pending, clears claim fields
    expect(prSql).toContain("'pending'");
    expect(prSql).toContain('"claimedBy" = NULL');
    expect(prSql).toContain('"claimedAt" = NULL');
    expect(prSql).toContain('"heartbeatAt" = NULL');
    // Same cutoff as Task reap
    const expectedCutoff = new Date(
      NOW.getTime() - DEFAULT_TTL_MS,
    ).toISOString();
    expect(prisma._calls[0].values[0]).toBe(expectedCutoff);
  });

  test("combined count: tasks + PRs both reaped", async () => {
    // 3 tasks + 2 PRs = 5 total
    const prisma = makePrismaDouble(2, [
      fakeStaleTask({ id: "t1" }),
      fakeStaleTask({ id: "t2" }),
      fakeStaleTask({ id: "t3" }),
    ]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(5);
  });

  test("PR reap WHERE clause covers in_progress with heartbeatAt IS NULL", async () => {
    const prisma = makePrismaDouble(1, []);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const prSql = prisma._calls[0].strings.join("?");
    expect(prSql).toContain('"heartbeatAt" IS NULL');
    expect(prSql).toContain('"claimedAt"');
  });

  // ─── Phase-aware reaper tests ─────────────────────────────────────────────────

  test("PR reap uses claimedBy IS NOT NULL (phase-agnostic) not reviewState='in_progress'", async () => {
    const prisma = makePrismaDouble(0, []);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const prSql = prisma._calls[0].strings.join("?");
    // Should filter by claimedBy IS NOT NULL, not reviewState = 'in_progress'
    expect(prSql).toContain('"claimedBy" IS NOT NULL');
    // The WHERE clause must not gate on reviewState — every stale claim is
    // released regardless of its reviewState (reviewState only governs whether
    // the reset-to-pending happens, via the SET CASE, not whether we act).
    const whereClause = prSql.slice(prSql.indexOf("WHERE"));
    expect(whereClause).not.toContain('"reviewState"');
  });

  test("PR reap resets phase=null and clears claim fields", async () => {
    const prisma = makePrismaDouble(1, []);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const prSql = prisma._calls[0].strings.join("?");
    expect(prSql).toContain('"claimedBy" = NULL');
    expect(prSql).toContain('"claimedAt" = NULL');
    expect(prSql).toContain('"heartbeatAt" = NULL');
    expect(prSql).toContain('"phase" = NULL');
  });

  test("PR reap does not blindly reset reviewState to pending — uses CASE based on reviewState", async () => {
    const prisma = makePrismaDouble(1, []);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const prSql = prisma._calls[0].strings.join("?");
    // Should use a CASE expression that only resets to pending when reviewState
    // is still 'pending'/'in_progress' and preserves 'posted'/'approved'.
    expect(prSql).toContain("CASE");
    expect(prSql).toContain('"reviewState" IN');
    expect(prSql).toContain("'in_progress'");
    expect(prSql).toContain("'pending'");
    expect(prSql).toContain('ELSE "reviewState"');
  });

  test("PR reap preserves posted/approved reviewState but still clears claim fields", async () => {
    const prisma = makePrismaDouble(1, []);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    await reaper.reap();

    const prSql = prisma._calls[0].strings.join("?");
    // reviewState regresses to pending only for pending/in_progress; posted and
    // approved fall through the ELSE branch and keep their value (no duplicate
    // review re-dispatch).
    expect(prSql).toContain('WHEN "reviewState" IN');
    expect(prSql).toContain('ELSE "reviewState"');
    // Claim fields are released for every stale claim regardless of reviewState.
    expect(prSql).toContain('"claimedBy" = NULL');
    expect(prSql).toContain('"claimedAt" = NULL');
    expect(prSql).toContain('"heartbeatAt" = NULL');
    expect(prSql).toContain('"phase" = NULL');
  });

  // ─── DEFAULT_TTL_MS unified default TTL boundary ──────────────────────────

  test("PR claim just under DEFAULT_TTL_MS old is NOT reaped", async () => {
    const prisma = makePrismaDouble(0, []);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(0);
    expect(prisma._calls).toHaveLength(1);

    // The cutoff used to filter is now - DEFAULT_TTL_MS
    const expectedCutoff = msAgo(NOW, DEFAULT_TTL_MS).toISOString();
    expect(prisma._calls[0].values[0]).toBe(expectedCutoff);

    // A heartbeatAt just under DEFAULT_TTL_MS old is more recent than the cutoff,
    // so it would not match "heartbeatAt < cutoff" and is correctly excluded.
    const heartbeatAt = msAgo(NOW, DEFAULT_TTL_MS - 1_000);
    expect(heartbeatAt.getTime() > new Date(expectedCutoff).getTime()).toBe(
      true,
    );
  });

  test("PR claim just over DEFAULT_TTL_MS old IS reaped, reviewState resets to pending", async () => {
    const prisma = makePrismaDouble(1, []);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(1);
    expect(prisma._calls).toHaveLength(1);

    const expectedCutoff = msAgo(NOW, DEFAULT_TTL_MS).toISOString();
    expect(prisma._calls[0].values[0]).toBe(expectedCutoff);

    // A heartbeatAt just over DEFAULT_TTL_MS old is older than the cutoff,
    // so it matches "heartbeatAt < cutoff" and would be reaped.
    const heartbeatAt = msAgo(NOW, DEFAULT_TTL_MS + 1_000);
    expect(heartbeatAt.getTime() < new Date(expectedCutoff).getTime()).toBe(
      true,
    );

    // The reaper resets reviewState to 'pending' for pending/in_progress claims via CASE.
    const prSql = prisma._calls[0].strings.join("?");
    expect(prSql).toContain("CASE");
    expect(prSql).toContain('"reviewState" IN');
    expect(prSql).toContain("'in_progress'");
    expect(prSql).toContain("'pending'");
  });

  test("task claim just under DEFAULT_TTL_MS old is NOT reaped", async () => {
    const prisma = makePrismaDouble(0, []);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(0);
    expect(prisma._queryRawCalls).toHaveLength(0);

    // findMany found no stale tasks; verify the unified cutoff via the PR
    // branch, which shares the same cutoff computation.
    const expectedCutoff = msAgo(NOW, DEFAULT_TTL_MS).toISOString();
    expect(prisma._calls[0].values[0]).toBe(expectedCutoff);

    // A heartbeatAt just under DEFAULT_TTL_MS old is more recent than the cutoff,
    // so it would not match "heartbeatAt < cutoff" and is correctly excluded.
    const heartbeatAt = msAgo(NOW, DEFAULT_TTL_MS - 1_000);
    expect(heartbeatAt.getTime() > new Date(expectedCutoff).getTime()).toBe(
      true,
    );
  });

  test("task claim just over DEFAULT_TTL_MS old IS reaped", async () => {
    const prisma = makePrismaDouble(0, [fakeStaleTask()]);
    const reaper = new StaleClaimReaper(prisma as never, clock);

    const count = await reaper.reap();

    expect(count).toBe(1);
    expect(prisma._queryRawCalls).toHaveLength(1);

    const expectedCutoff = msAgo(NOW, DEFAULT_TTL_MS).toISOString();
    expect(prisma._queryRawCalls[0].values[0]).toBe(expectedCutoff);

    // A heartbeatAt just over DEFAULT_TTL_MS old is older than the cutoff,
    // so it matches "heartbeatAt < cutoff" and would be reaped.
    const heartbeatAt = msAgo(NOW, DEFAULT_TTL_MS + 1_000);
    expect(heartbeatAt.getTime() < new Date(expectedCutoff).getTime()).toBe(
      true,
    );
  });
});
