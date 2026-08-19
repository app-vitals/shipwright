/**
 * task-store/src/pull-request-service.unit.test.ts
 *
 * Unit tests for PullRequestService.patch(). Uses a hand-built Prisma double
 * (plain object with findUnique/update stubs) and FixedClock for deterministic
 * time — no mock.module(), no global overrides (see stale-claim-reaper.unit.test.ts
 * for the reference pattern).
 */

import { describe, expect, test } from "bun:test";
import { FixedClock } from "./clock.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";
import type { PullRequest } from "./index.ts";
import { PullRequestService } from "./pull-request-service.ts";

// ─── Prisma double ────────────────────────────────────────────────────────────

interface UpdateCall {
  where: unknown;
  data: Record<string, unknown>;
}

/**
 * makePrismaDouble — configurable findUnique return value, records update()
 * calls so tests can assert on the exact data payload passed to Prisma.
 */
function makePrismaDouble(
  findUniqueResult: Partial<PullRequest> | null = null,
) {
  const updateCalls: UpdateCall[] = [];

  const prisma = {
    pullRequest: {
      findUnique(_args: unknown): Promise<Partial<PullRequest> | null> {
        return Promise.resolve(findUniqueResult);
      },
      update(args: UpdateCall): Promise<Partial<PullRequest>> {
        updateCalls.push(args);
        return Promise.resolve({
          id: "pr-1",
          ...(findUniqueResult ?? {}),
          ...args.data,
        } as Partial<PullRequest>);
      },
    },
    _updateCalls: updateCalls,
  };

  return prisma as unknown as {
    pullRequest: {
      findUnique: (args: unknown) => Promise<Partial<PullRequest> | null>;
      update: (args: UpdateCall) => Promise<Partial<PullRequest>>;
    };
    _updateCalls: UpdateCall[];
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PullRequestService.patch()", () => {
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  const clock = FixedClock(NOW);

  test("commitSha omitted — unconditionally resets reviewState=pending (backward compat)", async () => {
    const prisma = makePrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    await svc.patch("pr-1");

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.reviewState).toBe("pending");
    expect(data.patchCycles).toEqual({ increment: 1 });
    expect(data.patchedAt).toBe(NOW.toISOString());
    expect(data.claimedBy).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.heartbeatAt).toBeNull();
    expect(data.phase).toBeNull();
  });

  test("commitSha unchanged — does NOT touch reviewState, still clears claim fields", async () => {
    const sameSha = "abc123";
    const prisma = makePrismaDouble({
      id: "pr-1",
      commitSha: sameSha,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.patch("pr-1", sameSha);

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect("reviewState" in data).toBe(false);
    expect(data.patchCycles).toEqual({ increment: 1 });
    expect(data.patchedAt).toBe(NOW.toISOString());
    expect(data.claimedBy).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.heartbeatAt).toBeNull();
    expect(data.phase).toBeNull();
  });

  test("commitSha changed — resets reviewState=pending, updates commitSha, clears claim fields", async () => {
    const oldSha = "abc123";
    const newSha = "def456";
    const prisma = makePrismaDouble({
      id: "pr-1",
      commitSha: oldSha,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.patch("pr-1", newSha);

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.reviewState).toBe("pending");
    expect(data.commitSha).toBe(newSha);
    expect(data.patchCycles).toEqual({ increment: 1 });
    expect(data.patchedAt).toBe(NOW.toISOString());
    expect(data.claimedBy).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.heartbeatAt).toBeNull();
    expect(data.phase).toBeNull();
  });

  test("commitSha provided but record does not exist — throws NotFoundError", async () => {
    const prisma = makePrismaDouble(null);
    const svc = new PullRequestService(prisma as never, clock);

    let caught: unknown;
    try {
      await svc.patch("missing-id", "somesha");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect(prisma._updateCalls).toHaveLength(0);
  });

  // ─── ciFailureSignature streak tracking ───────────────────────────────────

  test("ciFailureSignature omitted — leaves lastCiFailureSignature/consecutiveCiFailureCount untouched", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      lastCiFailureSignature: "some-prior-signature",
      consecutiveCiFailureCount: 2,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.patch("pr-1");

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect("lastCiFailureSignature" in data).toBe(false);
    expect("consecutiveCiFailureCount" in data).toBe(false);
    expect("blocked" in data).toBe(false);
    expect("blockedReason" in data).toBe(false);
  });

  test("ciFailureSignature matches stored signature — increments consecutiveCiFailureCount, does not reset", async () => {
    const signature = "npm-test-failed-foo.ts";
    const prisma = makePrismaDouble({
      id: "pr-1",
      commitSha: "abc123",
      lastCiFailureSignature: signature,
      consecutiveCiFailureCount: 1,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.patch("pr-1", "abc123", signature);

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.consecutiveCiFailureCount).toEqual({ increment: 1 });
    expect("lastCiFailureSignature" in data).toBe(false);
  });

  test("ciFailureSignature differs from stored signature — resets consecutiveCiFailureCount to 1, stores new signature", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      commitSha: "abc123",
      lastCiFailureSignature: "old-signature",
      consecutiveCiFailureCount: 2,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.patch("pr-1", "abc123", "new-signature");

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.consecutiveCiFailureCount).toBe(1);
    expect(data.lastCiFailureSignature).toBe("new-signature");
  });

  test("ciFailureSignature provided with no prior stored signature — resets (sets) consecutiveCiFailureCount to 1, stores signature", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      commitSha: "abc123",
      lastCiFailureSignature: null,
      consecutiveCiFailureCount: 0,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.patch("pr-1", "abc123", "first-signature");

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.consecutiveCiFailureCount).toBe(1);
    expect(data.lastCiFailureSignature).toBe("first-signature");
  });

  test("ciFailureSignature crossing CI_FAILURE_BLOCK_THRESHOLD (3) sets blocked:true and a descriptive blockedReason in the same request", async () => {
    const signature = "flaky-e2e-test";
    const prisma = makePrismaDouble({
      id: "pr-1",
      commitSha: "abc123",
      lastCiFailureSignature: signature,
      consecutiveCiFailureCount: 2,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.patch("pr-1", "abc123", signature);

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.consecutiveCiFailureCount).toEqual({ increment: 1 });
    expect(data.blocked).toBe(true);
    expect(data.blockedReason).toBeTruthy();
    expect(data.blockedReason).toContain("3");
    expect(data.blockedReason).toContain(signature);
    expect(result.blocked).toBe(true);
  });

  test("ciFailureSignature below threshold does NOT set blocked/blockedReason", async () => {
    const signature = "some-signature";
    const prisma = makePrismaDouble({
      id: "pr-1",
      commitSha: "abc123",
      lastCiFailureSignature: signature,
      consecutiveCiFailureCount: 0,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.patch("pr-1", "abc123", signature);

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect("blocked" in data).toBe(false);
    expect("blockedReason" in data).toBe(false);
  });

  test("ciFailureSignature reset case (differing signature) does NOT set blocked/blockedReason even if prior count was at/above threshold", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      commitSha: "abc123",
      lastCiFailureSignature: "old-signature",
      consecutiveCiFailureCount: 5,
      blocked: true,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.patch("pr-1", "abc123", "new-signature");

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.consecutiveCiFailureCount).toBe(1);
    expect("blocked" in data).toBe(false);
    expect("blockedReason" in data).toBe(false);
  });

  test("ciFailureSignature combined with commitSha match (no-op review cycle) still tracks the CI streak independently", async () => {
    const sameSha = "abc123";
    const signature = "same-failure";
    const prisma = makePrismaDouble({
      id: "pr-1",
      commitSha: sameSha,
      lastCiFailureSignature: signature,
      consecutiveCiFailureCount: 1,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.patch("pr-1", sameSha, signature);

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    // reviewState untouched (no-op patch cycle), but the CI streak still increments
    expect("reviewState" in data).toBe(false);
    expect(data.consecutiveCiFailureCount).toEqual({ increment: 1 });
  });
});

describe("PullRequestService.list() sort", () => {
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  const clock = FixedClock(NOW);

  /**
   * Prisma double for list(): captures the findMany args (in particular
   * orderBy and where) passed by the service, mirroring the
   * $transaction([findMany, count]) shape list() actually issues.
   */
  function makeListPrismaDouble() {
    const findManyCalls: Array<{ orderBy?: unknown; where?: unknown }> = [];

    const prisma = {
      pullRequest: {
        findMany(args: { orderBy?: unknown; where?: unknown }) {
          findManyCalls.push(args);
          return Promise.resolve([]);
        },
        count() {
          return Promise.resolve(0);
        },
      },
      $transaction(ops: Promise<unknown>[]) {
        return Promise.all(ops);
      },
      _findManyCalls: findManyCalls,
    };

    return prisma as unknown as {
      pullRequest: {
        findMany: (args: {
          orderBy?: unknown;
          where?: unknown;
        }) => Promise<unknown[]>;
        count: () => Promise<number>;
      };
      $transaction: (ops: Promise<unknown>[]) => Promise<unknown[]>;
      _findManyCalls: Array<{ orderBy?: unknown; where?: unknown }>;
    };
  }

  test("list({ sort: 'desc' }) orders by createdAt descending", async () => {
    const prisma = makeListPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    await svc.list({ sort: "desc" });

    expect(prisma._findManyCalls).toHaveLength(1);
    expect(prisma._findManyCalls[0].orderBy).toEqual({ createdAt: "desc" });
  });

  test("list({}) orders by createdAt ascending (current/default behavior)", async () => {
    const prisma = makeListPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    await svc.list({});

    expect(prisma._findManyCalls).toHaveLength(1);
    expect(prisma._findManyCalls[0].orderBy).toEqual({ createdAt: "asc" });
  });

  test("list({ sort: 'asc' }) orders by createdAt ascending (explicit)", async () => {
    const prisma = makeListPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    await svc.list({ sort: "asc" });

    expect(prisma._findManyCalls).toHaveLength(1);
    expect(prisma._findManyCalls[0].orderBy).toEqual({ createdAt: "asc" });
  });
});

describe("PullRequestService.list() updatedSince/repo where clause", () => {
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  const clock = FixedClock(NOW);

  /**
   * Prisma double for list(): captures the findMany args (in particular
   * where) passed by the service, mirroring the $transaction([findMany,
   * count]) shape list() actually issues.
   */
  function makeListPrismaDouble() {
    const findManyCalls: Array<{ where?: unknown }> = [];

    const prisma = {
      pullRequest: {
        findMany(args: { where?: unknown }) {
          findManyCalls.push(args);
          return Promise.resolve([]);
        },
        count() {
          return Promise.resolve(0);
        },
      },
      $transaction(ops: Promise<unknown>[]) {
        return Promise.all(ops);
      },
      _findManyCalls: findManyCalls,
    };

    return prisma as unknown as {
      pullRequest: {
        findMany: (args: { where?: unknown }) => Promise<unknown[]>;
        count: () => Promise<number>;
      };
      $transaction: (ops: Promise<unknown>[]) => Promise<unknown[]>;
      _findManyCalls: Array<{ where?: unknown }>;
    };
  }

  test("list({ updatedSince }) sets where.updatedAt = { gte: new Date(updatedSince) }", async () => {
    const prisma = makeListPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);
    const updatedSince = "2026-07-01T00:00:00.000Z";

    await svc.list({ updatedSince });

    expect(prisma._findManyCalls).toHaveLength(1);
    expect(
      (prisma._findManyCalls[0].where as { updatedAt?: { gte: Date } })
        .updatedAt,
    ).toEqual({ gte: new Date(updatedSince) });
  });

  test("list({}) omits where.updatedAt entirely (preserves current unfiltered behavior)", async () => {
    const prisma = makeListPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    await svc.list({});

    expect(prisma._findManyCalls).toHaveLength(1);
    expect(
      (prisma._findManyCalls[0].where as { updatedAt?: unknown }).updatedAt,
    ).toBeUndefined();
  });

  test("list({ repo, updatedSince }) applies both filters together in where", async () => {
    const prisma = makeListPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);
    const updatedSince = "2026-07-01T00:00:00.000Z";

    await svc.list({ repo: "org/repo", updatedSince });

    expect(prisma._findManyCalls).toHaveLength(1);
    const where = prisma._findManyCalls[0].where as {
      repo?: string;
      updatedAt?: { gte: Date };
    };
    expect(where.repo).toBe("org/repo");
    expect(where.updatedAt).toEqual({ gte: new Date(updatedSince) });
  });

  test("list({ updatedSince: 'not-a-date' }) throws BadRequestError instead of passing Invalid Date to Prisma", async () => {
    const prisma = makeListPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    await expect(svc.list({ updatedSince: "not-a-date" })).rejects.toThrow(
      BadRequestError,
    );
  });

  test("list({ repo: ['org/a', 'org/b'] }) produces a where.repo.in clause", async () => {
    const prisma = makeListPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    await svc.list({ repo: ["org/a", "org/b"] });

    expect(prisma._findManyCalls).toHaveLength(1);
    const where = prisma._findManyCalls[0].where as {
      repo?: { in: string[] };
    };
    expect(where.repo).toEqual({ in: ["org/a", "org/b"] });
  });

  test("list({ org: 'app-vitals' }) produces a where.repo.startsWith('app-vitals/') clause", async () => {
    const prisma = makeListPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    await svc.list({ org: "app-vitals" });

    expect(prisma._findManyCalls).toHaveLength(1);
    const where = prisma._findManyCalls[0].where as {
      OR?: Array<{ repo: { startsWith: string } }>;
    };
    expect(where.OR).toEqual([{ repo: { startsWith: "app-vitals/" } }]);
  });

  test("list({ repo: ['org/a', 'org/b'], org: ['acme'] }) combines both via AND", async () => {
    const prisma = makeListPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    await svc.list({ repo: ["org/a", "org/b"], org: ["acme"] });

    expect(prisma._findManyCalls).toHaveLength(1);
    const where = prisma._findManyCalls[0].where as {
      AND?: [{ repo: { in: string[] } }, { OR: unknown[] }];
    };
    expect(where.AND).toEqual([
      { repo: { in: ["org/a", "org/b"] } },
      { OR: [{ repo: { startsWith: "acme/" } }] },
    ]);
  });

  test("list({ repo: 'org/repo' }) still applies exact-match (single string, no org)", async () => {
    const prisma = makeListPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    await svc.list({ repo: "org/repo" });

    expect(prisma._findManyCalls).toHaveLength(1);
    expect(prisma._findManyCalls[0].where).toMatchObject({
      repo: "org/repo",
    });
  });
});

describe("PullRequestService.list({ blocked: true }) / isPrBlocked()", () => {
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  const clock = FixedClock(NOW);

  /**
   * Prisma double for the blocked-filter branch of list(): captures the
   * candidates findMany() result and the joined task.findMany() lookup,
   * mirroring the non-transactional shape list({ blocked: true }) actually
   * issues (see pull-request-service.ts's `if (filters.blocked)` branch).
   */
  function makeBlockedListPrismaDouble(
    candidates: Partial<PullRequest>[],
    tasks: Array<{ id: string; status: string }> = [],
  ) {
    const prisma = {
      pullRequest: {
        findMany() {
          return Promise.resolve(candidates);
        },
      },
      task: {
        findMany() {
          return Promise.resolve(tasks);
        },
      },
    };

    return prisma as unknown as {
      pullRequest: { findMany: () => Promise<Partial<PullRequest>[]> };
      task: {
        findMany: () => Promise<Array<{ id: string; status: string }>>;
      };
    };
  }

  test("list({ blocked: true }) returns a PR with pr.blocked === true", async () => {
    const prisma = makeBlockedListPrismaDouble([
      { id: "pr-1", taskId: null, blocked: true } as Partial<PullRequest>,
    ]);
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.list({ blocked: true });

    expect(result.prs.map((p) => p.id)).toEqual(["pr-1"]);
    expect(result.total).toBe(1);
  });

  test("list({ blocked: true }) returns a PR whose linked task has status === 'blocked'", async () => {
    const prisma = makeBlockedListPrismaDouble(
      [
        {
          id: "pr-1",
          taskId: "task-1",
          blocked: false,
        } as Partial<PullRequest>,
      ],
      [{ id: "task-1", status: "blocked" }],
    );
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.list({ blocked: true });

    expect(result.prs.map((p) => p.id)).toEqual(["pr-1"]);
    expect(result.total).toBe(1);
  });

  test("list({ blocked: true }) excludes a PR whose linked task has hitl:true but status not 'blocked' (task.hitl branch removed)", async () => {
    // Task double intentionally includes a legacy `hitl` field to prove
    // isPrBlocked no longer reads it.
    const taskWithHitl: { id: string; status: string; hitl: boolean } = {
      id: "task-1",
      status: "in_progress",
      hitl: true,
    };
    const prisma = makeBlockedListPrismaDouble(
      [
        {
          id: "pr-1",
          taskId: "task-1",
          blocked: false,
        } as Partial<PullRequest>,
      ],
      [taskWithHitl],
    );
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.list({ blocked: true });

    expect(result.prs).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("list({ blocked: true }) excludes a PR with pr.blocked === false and no blocked linked task", async () => {
    const prisma = makeBlockedListPrismaDouble(
      [
        {
          id: "pr-1",
          taskId: "task-1",
          blocked: false,
        } as Partial<PullRequest>,
      ],
      [{ id: "task-1", status: "pr_open" }],
    );
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.list({ blocked: true });

    expect(result.prs).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("list({ blocked: true }) evaluates a PR with no taskId on pr.blocked alone (no crash/false-positive)", async () => {
    const prisma = makeBlockedListPrismaDouble([
      { id: "pr-1", taskId: null, blocked: false } as Partial<PullRequest>,
      { id: "pr-2", taskId: null, blocked: true } as Partial<PullRequest>,
    ]);
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.list({ blocked: true });

    expect(result.prs.map((p) => p.id)).toEqual(["pr-2"]);
  });
});

describe("PullRequestService.recordSkip()", () => {
  const NOW = new Date("2026-07-21T09:00:00.000Z");
  const clock = FixedClock(NOW);

  /**
   * Prisma double for recordSkip(): simulates real atomic-increment
   * semantics for `skipCount: { increment: 1 }` (the generic makePrismaDouble
   * above merges args.data verbatim, which doesn't resolve Prisma's
   * increment operator to a numeric value) so tests can assert on the
   * resulting skipCount across recordSkip()'s two possible update() calls.
   */
  function makeRecordSkipPrismaDouble(initialSkipCount: number) {
    const updateCalls: UpdateCall[] = [];
    const record: Partial<PullRequest> = {
      id: "pr-1",
      skipCount: initialSkipCount,
      blocked: false,
      blockedReason: null,
    };

    const prisma = {
      pullRequest: {
        update(args: UpdateCall): Promise<Partial<PullRequest>> {
          updateCalls.push(args);
          const { data } = args;
          for (const [key, value] of Object.entries(data)) {
            if (
              key === "skipCount" &&
              typeof value === "object" &&
              value !== null &&
              "increment" in value
            ) {
              record.skipCount =
                (record.skipCount ?? 0) +
                (value as { increment: number }).increment;
            } else {
              (record as Record<string, unknown>)[key] = value;
            }
          }
          return Promise.resolve({ ...record });
        },
      },
      _updateCalls: updateCalls,
    };

    return prisma as unknown as {
      pullRequest: {
        update: (args: UpdateCall) => Promise<Partial<PullRequest>>;
      };
      _updateCalls: UpdateCall[];
    };
  }

  test("recordSkip() below SKIP_BLOCK_THRESHOLD only increments skipCount/lastSkippedAt, no blocked/blockedReason", async () => {
    const prisma = makeRecordSkipPrismaDouble(1);
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.recordSkip("pr-1");

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.skipCount).toEqual({ increment: 1 });
    expect(data.lastSkippedAt).toBe(NOW.toISOString());
    expect("blocked" in data).toBe(false);
    expect("blockedReason" in data).toBe(false);
    expect(result.skipCount).toBe(2);
  });

  test("recordSkip() crossing SKIP_BLOCK_THRESHOLD (3) sets blocked:true and a descriptive blockedReason in a second update call", async () => {
    const prisma = makeRecordSkipPrismaDouble(2);
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.recordSkip("pr-1");

    expect(prisma._updateCalls).toHaveLength(2);
    const blockUpdate = prisma._updateCalls[1].data;
    expect(blockUpdate.blocked).toBe(true);
    expect(blockUpdate.blockedReason).toBeTruthy();
    expect(blockUpdate.blockedReason).toContain("3");
    expect("hitl" in blockUpdate).toBe(false);
    expect(result.blocked).toBe(true);
  });

  test("recordSkip() exactly at threshold (skipCount reaching 3) sets blocked:true", async () => {
    const prisma = makeRecordSkipPrismaDouble(2);
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.recordSkip("pr-1");

    expect(result.skipCount).toBe(3);
    expect(result.blocked).toBe(true);
  });
});

describe("PullRequestService.resetSkip()", () => {
  const NOW = new Date("2026-07-21T09:00:00.000Z");
  const clock = FixedClock(NOW);

  test("clears blocked/blockedReason when the PR was auto-blocked by the skip mechanism", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      skipCount: 3,
      blocked: true,
      blockedReason:
        "Auto-blocked after 3 consecutive skips (dispatched but found nothing to do)",
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.resetSkip("pr-1");

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.skipCount).toBe(0);
    expect(data.lastSkippedAt).toBeNull();
    expect(data.blocked).toBe(false);
    expect(data.blockedReason).toBeNull();
    expect(result.blocked).toBe(false);
    expect(result.blockedReason).toBeNull();
  });

  test("does NOT clear blocked/blockedReason when the PR was blocked by a different mechanism (e.g. CI-failure streak)", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      skipCount: 0,
      blocked: true,
      blockedReason:
        "Auto-blocked after 3 consecutive patch cycles hitting the same CI failure (npm-test-failed-foo.unit.test.ts)",
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.resetSkip("pr-1");

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.skipCount).toBe(0);
    expect(data.lastSkippedAt).toBeNull();
    expect("blocked" in data).toBe(false);
    expect("blockedReason" in data).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toBe(
      "Auto-blocked after 3 consecutive patch cycles hitting the same CI failure (npm-test-failed-foo.unit.test.ts)",
    );
  });

  test("no-ops on blocked fields when the PR is not currently blocked", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      skipCount: 1,
      blocked: false,
      blockedReason: null,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.resetSkip("pr-1");

    const { data } = prisma._updateCalls[0];
    expect("blocked" in data).toBe(false);
    expect("blockedReason" in data).toBe(false);
  });

  test("defensive: blocked:true with a null blockedReason does not crash and does not clear the block", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      skipCount: 0,
      blocked: true,
      blockedReason: null,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.resetSkip("pr-1");

    const { data } = prisma._updateCalls[0];
    expect("blocked" in data).toBe(false);
    expect("blockedReason" in data).toBe(false);
    expect(result.blocked).toBe(true);
  });

  test("throws NotFoundError when the PR does not exist", async () => {
    const prisma = makePrismaDouble(null);
    const svc = new PullRequestService(prisma as never, clock);

    await expect(svc.resetSkip("missing")).rejects.toThrow(NotFoundError);
  });
});

describe("PullRequestService.update() merge completion", () => {
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  const clock = FixedClock(NOW);

  test("state:merged clears claimedBy/claimedAt/heartbeatAt/phase", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      readyForDeployAt: NOW.toISOString(),
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.update("pr-1", {
      state: "merged",
      mergedAt: NOW.toISOString(),
      reviewState: "approved",
      commitSha: "sha-merged",
    });

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.state).toBe("merged");
    expect(data.commitSha).toBe("sha-merged");
    expect(data.claimedBy).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.heartbeatAt).toBeNull();
    expect(data.phase).toBeNull();
  });

  test("state:closed clears claimedBy/claimedAt/heartbeatAt/phase", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      readyForDeployAt: NOW.toISOString(),
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.update("pr-1", { state: "closed" });

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.state).toBe("closed");
    expect(data.claimedBy).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.heartbeatAt).toBeNull();
    expect(data.phase).toBeNull();
  });

  test("non-merge update does not touch claim fields", async () => {
    const prisma = makePrismaDouble({ id: "pr-1" } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.update("pr-1", { commitSha: "sha-unrelated" });

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect("claimedBy" in data).toBe(false);
    expect("claimedAt" in data).toBe(false);
    expect("heartbeatAt" in data).toBe(false);
    expect("phase" in data).toBe(false);
  });
});

describe("PullRequestService.update() claim release on review post", () => {
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  const clock = FixedClock(NOW);

  test("reviewState:posted clears claimedBy/claimedAt/heartbeatAt/phase in the same write", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      claimedBy: "agent-a",
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.update("pr-1", { reviewState: "posted" });

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.reviewState).toBe("posted");
    expect(data.claimedBy).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.heartbeatAt).toBeNull();
    expect(data.phase).toBeNull();
  });

  test("reviewState:approved clears claim fields AND stamps readyForDeployAt", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      claimedBy: "agent-a",
      readyForDeployAt: null,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.update("pr-1", { reviewState: "approved" });

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.reviewState).toBe("approved");
    expect(data.readyForDeployAt).toBe(NOW.toISOString());
    expect(data.claimedBy).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.heartbeatAt).toBeNull();
    expect(data.phase).toBeNull();
  });

  test("auto-release wins over claim fields set in the same posted PATCH body", async () => {
    // The release is unconditional, mirroring the state:'merged' block, so any
    // claim field supplied in the same posted/approved PATCH is overwritten with
    // null. (In practice the route allowlist already drops claimedBy/claimedAt/
    // heartbeatAt; only phase is writable and it too gets nulled here.)
    const prisma = makePrismaDouble({
      id: "pr-1",
      claimedBy: "agent-a",
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.update("pr-1", {
      reviewState: "posted",
      claimedBy: "agent-b",
      phase: "patch",
    });

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.reviewState).toBe("posted");
    expect(data.claimedBy).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.heartbeatAt).toBeNull();
    expect(data.phase).toBeNull();
  });

  test("update that does not touch reviewState leaves claim fields alone", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      claimedBy: "agent-a",
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.update("pr-1", { staged: true });

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect("claimedBy" in data).toBe(false);
    expect("claimedAt" in data).toBe(false);
    expect("heartbeatAt" in data).toBe(false);
    expect("phase" in data).toBe(false);
  });

  test("re-asserting an already-posted reviewState still (idempotently) clears claim fields", async () => {
    // Behavior choice: the release keys off the incoming reviewState value, not
    // a state transition, so a redundant PATCH to 'posted' also clears the claim
    // fields. This is harmless — an already-released claim is written null→null —
    // and keeps the rule simple: "posted/approved ⇒ no claim".
    const prisma = makePrismaDouble({
      id: "pr-1",
      reviewState: "posted",
      claimedBy: null,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.update("pr-1", { reviewState: "posted" });

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.reviewState).toBe("posted");
    expect(data.claimedBy).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.heartbeatAt).toBeNull();
    expect(data.phase).toBeNull();
  });
});

describe("PullRequestService.release()", () => {
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  const clock = FixedClock(NOW);

  test("reviewState:posted — preserves reviewState, still clears claim fields", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      reviewState: "posted",
      claimedBy: "agent-a",
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.release("pr-1");

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect("reviewState" in data).toBe(false);
    expect(data.claimedBy).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.heartbeatAt).toBeNull();
  });

  test("reviewState:approved — preserves reviewState, still clears claim fields", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      reviewState: "approved",
      claimedBy: "agent-a",
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.release("pr-1");

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect("reviewState" in data).toBe(false);
    expect(data.claimedBy).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.heartbeatAt).toBeNull();
  });

  test("reviewState:pending — resets reviewState=pending (no-op value), clears claim fields", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      reviewState: "pending",
      claimedBy: "agent-a",
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.release("pr-1");

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.reviewState).toBe("pending");
    expect(data.claimedBy).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.heartbeatAt).toBeNull();
  });

  test("reviewState:in_progress — resets reviewState=pending, clears claim fields", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      reviewState: "in_progress",
      claimedBy: "agent-a",
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.release("pr-1");

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.reviewState).toBe("pending");
    expect(data.claimedBy).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.heartbeatAt).toBeNull();
  });

  test("reviewState missing/null on existing record — resets reviewState=pending, clears claim fields", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      claimedBy: "agent-a",
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.release("pr-1");

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.reviewState).toBe("pending");
    expect(data.claimedBy).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.heartbeatAt).toBeNull();
  });

  test("record does not exist — throws NotFoundError, does not call update", async () => {
    const prisma = makePrismaDouble(null);
    const svc = new PullRequestService(prisma as never, clock);

    let caught: unknown;
    try {
      await svc.release("missing-id");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect(prisma._updateCalls).toHaveLength(0);
  });
});

describe("PullRequestService.update() blocked/blockedReason pass-through", () => {
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  const clock = FixedClock(NOW);

  test("update() persists blocked/blockedReason and returns them", async () => {
    const prisma = makePrismaDouble({ id: "pr-1" } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.update("pr-1", {
      blocked: true,
      blockedReason: "no linked task",
    });

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.blocked).toBe(true);
    expect(data.blockedReason).toBe("no linked task");
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toBe("no linked task");
  });

  test("update() omitting blocked/blockedReason does not touch them", async () => {
    const prisma = makePrismaDouble({ id: "pr-1" } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.update("pr-1", { commitSha: "sha-unrelated" });

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect("blocked" in data).toBe(false);
    expect("blockedReason" in data).toBe(false);
  });
});

describe("PullRequestService.complete() claim release", () => {
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  const clock = FixedClock(NOW);

  test("complete() clears claimedBy/claimedAt/heartbeatAt/phase in the same write", async () => {
    // complete() is the path the review flow actually uses
    // (POST /prs/:id/complete); it must release the claim in the same write, not
    // leave it for the reaper.
    const prisma = makePrismaDouble({
      id: "pr-1",
      claimedBy: "agent-a",
      phase: "review",
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.complete("pr-1");

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.claimedBy).toBeNull();
    expect(data.claimedAt).toBeNull();
    expect(data.heartbeatAt).toBeNull();
    expect(data.phase).toBeNull();
  });

  test("complete() preserves existing posted-review behavior (reviewCycles/reviewState/reviewedAt/readyForPatchAt)", async () => {
    const prisma = makePrismaDouble({ id: "pr-1" } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.complete("pr-1");

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.reviewCycles).toEqual({ increment: 1 });
    expect(data.reviewState).toBe("posted");
    expect(data.reviewedAt).toBe(NOW.toISOString());
    expect(data.readyForPatchAt).toBe(NOW.toISOString());
  });
});

// ─── appendFinding() ────────────────────────────────────────────────────────
//
// Unlike the DB-backed race test in pull-request-service.integration.test.ts
// (which requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST and self-skips
// without it), this exercises appendFinding()'s own two code paths — the
// existence check and the create() call — against a hand-built Prisma
// double, no real Postgres required. Mirrors makePrismaDouble above but adds
// the prFinding.create() surface appendFinding() depends on.

interface CreateFindingCall {
  data: Record<string, unknown>;
}

function makeFindingPrismaDouble(prExists: boolean) {
  const createCalls: CreateFindingCall[] = [];

  const prisma = {
    pullRequest: {
      findUnique(_args: unknown): Promise<{ id: string } | null> {
        return Promise.resolve(prExists ? { id: "pr-1" } : null);
      },
    },
    prFinding: {
      create(args: CreateFindingCall): Promise<Record<string, unknown>> {
        createCalls.push(args);
        return Promise.resolve({ id: "finding-1", ...args.data });
      },
    },
    _createCalls: createCalls,
  };

  return prisma as unknown as {
    pullRequest: { findUnique: (args: unknown) => Promise<{ id: string } | null> };
    prFinding: { create: (args: CreateFindingCall) => Promise<Record<string, unknown>> };
    _createCalls: CreateFindingCall[];
  };
}

describe("PullRequestService.appendFinding()", () => {
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  const clock = FixedClock(NOW);

  test("inserts a PrFinding row scoped to prRecordId when the PR exists", async () => {
    const prisma = makeFindingPrismaDouble(true);
    const svc = new PullRequestService(prisma as never, clock);

    const finding = await svc.appendFinding("pr-1", {
      ref: "src/foo.ts:42",
      disposition: "resolved",
      source: "review",
      evidence: "Fixed in the follow-up commit.",
    });

    expect(prisma._createCalls).toHaveLength(1);
    const { data } = prisma._createCalls[0];
    expect(data.prRecordId).toBe("pr-1");
    expect(data.ref).toBe("src/foo.ts:42");
    expect(data.disposition).toBe("resolved");
    expect(data.source).toBe("review");
    expect(data.evidence).toBe("Fixed in the follow-up commit.");
    expect(finding.id).toBe("finding-1");
  });

  test("defaults `at` to clock.now() when the caller omits it", async () => {
    const prisma = makeFindingPrismaDouble(true);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.appendFinding("pr-1", {
      ref: "src/foo.ts:42",
      disposition: "rejected",
      source: "patch",
      evidence: "Not a real issue.",
    });

    const { data } = prisma._createCalls[0];
    expect(data.at).toBe(NOW.toISOString());
  });

  test("uses the caller-supplied `at` when provided, rather than clock.now()", async () => {
    const prisma = makeFindingPrismaDouble(true);
    const svc = new PullRequestService(prisma as never, clock);
    const explicitAt = "2026-06-01T00:00:00.000Z";

    await svc.appendFinding("pr-1", {
      ref: "src/foo.ts:42",
      disposition: "resolved",
      source: "review",
      evidence: "Fixed.",
      at: explicitAt,
    });

    const { data } = prisma._createCalls[0];
    expect(data.at).toBe(explicitAt);
  });

  test("throws NotFoundError and never calls prFinding.create() when the PR does not exist", async () => {
    const prisma = makeFindingPrismaDouble(false);
    const svc = new PullRequestService(prisma as never, clock);

    await expect(
      svc.appendFinding("missing-pr", {
        ref: "src/foo.ts:42",
        disposition: "resolved",
        source: "review",
        evidence: "Fixed.",
      }),
    ).rejects.toThrow(NotFoundError);

    expect(prisma._createCalls).toHaveLength(0);
  });

  test("includes agentId in the create() data when provided by the caller", async () => {
    const prisma = makeFindingPrismaDouble(true);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.appendFinding("pr-1", {
      ref: "src/foo.ts:42",
      disposition: "resolved",
      source: "review",
      evidence: "Fixed in the follow-up commit.",
      agentId: "agent-abc123",
    });

    const { data } = prisma._createCalls[0];
    expect(data.agentId).toBe("agent-abc123");
  });

  test("defaults `agentId` to null when the caller omits it", async () => {
    const prisma = makeFindingPrismaDouble(true);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.appendFinding("pr-1", {
      ref: "src/foo.ts:42",
      disposition: "resolved",
      source: "review",
      evidence: "Fixed in the follow-up commit.",
    });

    const { data } = prisma._createCalls[0];
    expect(data.agentId).toBe(null);
  });
});
