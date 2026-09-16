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
import { deriveOrigin } from "./pr-origin-derivation.ts";
import {
  MAX_CENSUS_ENTRIES,
  PullRequestService,
} from "./pull-request-service.ts";

// ─── Prisma double ────────────────────────────────────────────────────────────

interface UpdateCall {
  where: unknown;
  data: Record<string, unknown>;
}

interface EventCall {
  data: Record<string, unknown>;
}

/**
 * Attaches the PullRequestEvent audit-write stub (`pullRequestEvent.create`)
 * and a callback-form `$transaction` (invokes the callback with the composed
 * double itself as `tx`) to a Prisma double's `pullRequest`-stub base object.
 * Shared by makePrismaDouble and recordSkip()'s own double below so both wire
 * up PSA-1.2's event-recording surface identically instead of duplicating it.
 */
function attachEventStub<TBase extends Record<string, unknown>>(base: TBase) {
  const eventCalls: EventCall[] = [];
  const prisma = {
    ...base,
    pullRequestEvent: {
      create(args: EventCall): Promise<Record<string, unknown>> {
        eventCalls.push(args);
        return Promise.resolve({ id: "event-1", ...args.data });
      },
    },
    $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(prisma);
    },
    _eventCalls: eventCalls,
  };
  return prisma;
}

/**
 * makePrismaDouble — configurable findUnique return value, records update()
 * calls so tests can assert on the exact data payload passed to Prisma.
 *
 * Several mutation methods now wrap their update in this.prisma.$transaction()
 * and write PullRequestEvent audit rows inside it (PSA-1.2) — see
 * attachEventStub for that wiring.
 */
function makePrismaDouble(
  findUniqueResult: Partial<PullRequest> | null = null,
) {
  const updateCalls: UpdateCall[] = [];

  const prisma = attachEventStub({
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
  });

  return prisma as unknown as {
    pullRequest: {
      findUnique: (args: unknown) => Promise<Partial<PullRequest> | null>;
      update: (args: UpdateCall) => Promise<Partial<PullRequest>>;
    };
    pullRequestEvent: {
      create: (args: EventCall) => Promise<Record<string, unknown>>;
    };
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
    _updateCalls: UpdateCall[];
    _eventCalls: EventCall[];
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PullRequestService.patch()", () => {
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  const clock = FixedClock(NOW);

  test("commitSha omitted — unconditionally resets reviewState=pending (backward compat)", async () => {
    // patch() now always reads the before-state (for the audit diff), so even
    // the no-arg path needs an existing record; a missing one is a 404.
    const prisma = makePrismaDouble({ id: "pr-1" } as Partial<PullRequest>);
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

  /** Shape of a joined Task row the blocked filter selects (PTL-3.1). */
  type BlockedJoinTask = {
    repo: string | null;
    pr: number | null;
    status: string;
  };

  /**
   * Prisma double for the blocked-filter branch of list(): captures the
   * candidates findMany() result and the joined task.findMany() lookup,
   * mirroring the non-transactional shape list({ blocked: true }) actually
   * issues (see pull-request-service.ts's `if (filters.blocked)` branch).
   *
   * PTL-3.1: the join is now by (repo, prNumber) — the stored
   * PullRequest.taskId column is gone — so the task rows carry repo/pr
   * rather than an id to match against.
   */
  function makeBlockedListPrismaDouble(
    candidates: Partial<PullRequest>[],
    tasks: BlockedJoinTask[] = [],
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
      task: { findMany: () => Promise<BlockedJoinTask[]> };
    };
  }

  const REPO = "app-vitals/shipwright";

  test("list({ blocked: true }) returns a PR with pr.blocked === true", async () => {
    const prisma = makeBlockedListPrismaDouble([
      {
        id: "pr-1",
        repo: REPO,
        prNumber: 1,
        blocked: true,
      } as Partial<PullRequest>,
    ]);
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.list({ blocked: true });

    expect(result.prs.map((p) => p.id)).toEqual(["pr-1"]);
    expect(result.total).toBe(1);
  });

  test("list({ blocked: true }) returns a PR whose linked task (matched live by repo+prNumber) has status === 'blocked'", async () => {
    const prisma = makeBlockedListPrismaDouble(
      [
        {
          id: "pr-1",
          repo: REPO,
          prNumber: 1,
          blocked: false,
        } as Partial<PullRequest>,
      ],
      [{ repo: REPO, pr: 1, status: "blocked" }],
    );
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.list({ blocked: true });

    expect(result.prs.map((p) => p.id)).toEqual(["pr-1"]);
    expect(result.total).toBe(1);
  });

  test("list({ blocked: true }) returns a bundle PR when any one of the several tasks sharing it is blocked", async () => {
    const prisma = makeBlockedListPrismaDouble(
      [
        {
          id: "pr-1",
          repo: REPO,
          prNumber: 7,
          blocked: false,
        } as Partial<PullRequest>,
      ],
      [
        { repo: REPO, pr: 7, status: "pr_open" },
        { repo: REPO, pr: 7, status: "blocked" },
      ],
    );
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.list({ blocked: true });

    expect(result.prs.map((p) => p.id)).toEqual(["pr-1"]);
  });

  test("list({ blocked: true }) does not match a same-numbered task in a different repo", async () => {
    const prisma = makeBlockedListPrismaDouble(
      [
        {
          id: "pr-1",
          repo: REPO,
          prNumber: 1,
          blocked: false,
        } as Partial<PullRequest>,
      ],
      [{ repo: "other-org/other-repo", pr: 1, status: "blocked" }],
    );
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.list({ blocked: true });

    expect(result.prs).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("list({ blocked: true }) excludes a PR whose linked task has hitl:true but status not 'blocked' (task.hitl branch removed)", async () => {
    // Task double intentionally includes a legacy `hitl` field to prove
    // isPrBlocked no longer reads it.
    const taskWithHitl = {
      repo: REPO,
      pr: 1,
      status: "in_progress",
      hitl: true,
    };
    const prisma = makeBlockedListPrismaDouble(
      [
        {
          id: "pr-1",
          repo: REPO,
          prNumber: 1,
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
          repo: REPO,
          prNumber: 1,
          blocked: false,
        } as Partial<PullRequest>,
      ],
      [{ repo: REPO, pr: 1, status: "pr_open" }],
    );
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.list({ blocked: true });

    expect(result.prs).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("list({ blocked: true }) evaluates a PR with no linked task on pr.blocked alone (no crash/false-positive)", async () => {
    const prisma = makeBlockedListPrismaDouble([
      {
        id: "pr-1",
        repo: REPO,
        prNumber: 1,
        blocked: false,
      } as Partial<PullRequest>,
      {
        id: "pr-2",
        repo: REPO,
        prNumber: 2,
        blocked: true,
      } as Partial<PullRequest>,
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

    const prisma = attachEventStub({
      pullRequest: {
        // recordSkip() now snapshots the before-state via findUnique inside the
        // transaction. Return the current mutable record so the audit diff sees
        // the pre-update values.
        findUnique(_args: unknown): Promise<Partial<PullRequest> | null> {
          return Promise.resolve({ ...record });
        },
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
    });

    return prisma as unknown as {
      pullRequest: {
        findUnique: (args: unknown) => Promise<Partial<PullRequest> | null>;
        update: (args: UpdateCall) => Promise<Partial<PullRequest>>;
      };
      pullRequestEvent: {
        create: (args: EventCall) => Promise<Record<string, unknown>>;
      };
      $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
      _updateCalls: UpdateCall[];
      _eventCalls: EventCall[];
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

// ─── recordTransition() audit wiring ──────────────────────────────────────────
//
// These assert the PullRequestEvent rows written through the shared
// recordTransition() helper (PSA-1.2). Integration tests
// (pull-request-service.integration.test.ts) cover the real-Postgres landing;
// these cover the in-process wiring against the hand-built double's captured
// _eventCalls (populated by its pullRequestEvent.create stub).

describe("PullRequestService recordTransition() audit events", () => {
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  const clock = FixedClock(NOW);

  test("heartbeat() writes zero event rows (bare liveness ping)", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      claimedBy: "agent-a",
      heartbeatAt: "2026-07-10T11:00:00.000Z",
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.heartbeat("pr-1");

    expect(prisma._eventCalls).toHaveLength(0);
  });

  test("complete() writes one event per changed non-heartbeat field, actor = prior claimant", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      reviewState: "in_progress",
      reviewCycles: 0,
      claimedBy: "agent-a",
      claimedAt: "2026-07-10T10:00:00.000Z",
      heartbeatAt: "2026-07-10T11:00:00.000Z",
      phase: "review",
      reviewedAt: null,
      readyForPatchAt: null,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.complete("pr-1");

    const fields = prisma._eventCalls.map((c) => c.data.field);
    // heartbeatAt changed too (11:00 → null) but must NOT be logged.
    expect(fields).not.toContain("heartbeatAt");
    // The real transitions are all audited.
    expect(fields).toEqual(
      expect.arrayContaining([
        "reviewState",
        "reviewCycles",
        "reviewedAt",
        "readyForPatchAt",
        "claimedBy",
        "claimedAt",
        "phase",
      ]),
    );
    // Every row carries the method, actor, and a matching old/new value.
    for (const call of prisma._eventCalls) {
      expect(call.data.method).toBe("complete");
      expect(call.data.actor).toBe("agent-a");
      expect(call.data.at).toBe(NOW.toISOString());
    }
    const claimedByEvent = prisma._eventCalls.find(
      (c) => c.data.field === "claimedBy",
    );
    expect(claimedByEvent?.data.oldValue).toBe("agent-a");
    expect(claimedByEvent?.data.newValue).toBeNull();
  });

  test("patch() records the reviewState + commitSha transition with old/new values", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      commitSha: "old-sha",
      reviewState: "posted",
      claimedBy: "agent-b",
      patchCycles: 0,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.patch("pr-1", "new-sha");

    const byField = Object.fromEntries(
      prisma._eventCalls.map((c) => [c.data.field, c.data]),
    );
    expect(byField.commitSha).toMatchObject({
      oldValue: "old-sha",
      newValue: "new-sha",
      method: "patch",
      actor: "agent-b",
    });
    expect(byField.reviewState).toMatchObject({
      oldValue: "posted",
      newValue: "pending",
    });
    expect("heartbeatAt" in byField).toBe(false);
  });

  test("recordSkip() on an unclaimed PR attributes the actor to 'system'", async () => {
    const prisma = makePrismaDouble({
      id: "pr-1",
      skipCount: 0,
      claimedBy: null,
    } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.recordSkip("pr-1");

    const skipEvent = prisma._eventCalls.find(
      (c) => c.data.field === "skipCount",
    );
    expect(skipEvent).toBeDefined();
    expect(skipEvent?.data.actor).toBe("system");
    expect(skipEvent?.data.method).toBe("recordSkip");
  });

  // ─── release()/resetSkip() in-tx before-snapshot ──────────────────────────
  //
  // release() and resetSkip() do a pre-transaction findUnique() purely to
  // preserve the synchronous NotFoundError-before-any-write contract, then
  // must re-read the before-state INSIDE the $transaction and use THAT read
  // (not the pre-tx one) as recordTransition()'s `before` snapshot — closing
  // the concurrent-write race window a stale outside-tx snapshot would leave
  // open. This double returns a different row on each successive
  // findUnique() call to simulate a concurrent write landing between the
  // outside-tx existence check and the in-tx read, so these tests fail if
  // the stale (first) snapshot is ever used for the audit event.

  interface SequencedEventCall {
    data: Record<string, unknown>;
  }

  function makeSequencedPrismaDouble(
    findUniqueResults: (Partial<PullRequest> | null)[],
  ) {
    let call = 0;
    const updateCalls: UpdateCall[] = [];
    const eventCalls: SequencedEventCall[] = [];

    const prisma = {
      pullRequest: {
        findUnique(_args: unknown): Promise<Partial<PullRequest> | null> {
          const result =
            findUniqueResults[Math.min(call, findUniqueResults.length - 1)];
          call += 1;
          return Promise.resolve(result);
        },
        update(args: UpdateCall): Promise<Partial<PullRequest>> {
          updateCalls.push(args);
          const latest = findUniqueResults[findUniqueResults.length - 1];
          return Promise.resolve({
            id: "pr-1",
            ...(latest ?? {}),
            ...args.data,
          } as Partial<PullRequest>);
        },
      },
      pullRequestEvent: {
        create(args: SequencedEventCall): Promise<Record<string, unknown>> {
          eventCalls.push(args);
          return Promise.resolve({ id: "event-1", ...args.data });
        },
      },
      $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(prisma);
      },
      _updateCalls: updateCalls,
      _eventCalls: eventCalls,
    };

    return prisma as unknown as {
      pullRequest: {
        findUnique: (args: unknown) => Promise<Partial<PullRequest> | null>;
        update: (args: UpdateCall) => Promise<Partial<PullRequest>>;
      };
      pullRequestEvent: {
        create: (args: SequencedEventCall) => Promise<Record<string, unknown>>;
      };
      $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
      _updateCalls: UpdateCall[];
      _eventCalls: SequencedEventCall[];
    };
  }

  test("release() audits the before-snapshot read INSIDE the transaction, not the pre-tx existence check", async () => {
    // Simulates a concurrent claimedBy change landing between release()'s
    // outside-tx existence check and its in-tx before-read: the outside-tx
    // read still shows the old claimant, but the in-tx read (which must be
    // the one recordTransition() uses) shows the new one.
    const prisma = makeSequencedPrismaDouble([
      {
        id: "pr-1",
        reviewState: "in_progress",
        claimedBy: "agent-stale",
      } as Partial<PullRequest>,
      {
        id: "pr-1",
        reviewState: "in_progress",
        claimedBy: "agent-fresh",
      } as Partial<PullRequest>,
    ]);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.release("pr-1");

    const claimedByEvent = prisma._eventCalls.find(
      (c) => c.data.field === "claimedBy",
    );
    expect(claimedByEvent?.data.oldValue).toBe("agent-fresh");
    expect(claimedByEvent?.data.actor).toBe("agent-fresh");
  });

  test("resetSkip() audits the before-snapshot read INSIDE the transaction, not the pre-tx existence check", async () => {
    // Simulates a concurrent skipCount increment landing between
    // resetSkip()'s outside-tx existence check and its in-tx before-read.
    const prisma = makeSequencedPrismaDouble([
      { id: "pr-1", skipCount: 1 } as Partial<PullRequest>,
      { id: "pr-1", skipCount: 2 } as Partial<PullRequest>,
    ]);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.resetSkip("pr-1");

    const skipEvent = prisma._eventCalls.find(
      (c) => c.data.field === "skipCount",
    );
    expect(skipEvent?.data.oldValue).toBe("2");
    expect(skipEvent?.data.newValue).toBe("0");
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
    pullRequest: {
      findUnique: (args: unknown) => Promise<{ id: string } | null>;
    };
    prFinding: {
      create: (args: CreateFindingCall) => Promise<Record<string, unknown>>;
    };
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

// ─── getEvents() ────────────────────────────────────────────────────────────
//
// Unlike the DB-backed ordering test in pull-request-service.integration.test.ts
// (which requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST and self-skips
// without it), this exercises getEvents()'s own two code paths — the
// existence check and the findMany/count $transaction — against a hand-built
// Prisma double, no real Postgres required. Mirrors makeListPrismaDouble
// above but scoped to the pullRequestEvent model.

function makeEventsPrismaDouble(
  prExists: boolean,
  events: Array<Record<string, unknown>> = [],
) {
  const findManyCalls: Array<{
    where?: unknown;
    orderBy?: unknown;
    take?: unknown;
    skip?: unknown;
  }> = [];

  const prisma = {
    pullRequest: {
      findUnique(_args: unknown): Promise<{ id: string } | null> {
        return Promise.resolve(prExists ? { id: "pr-1" } : null);
      },
    },
    pullRequestEvent: {
      findMany(args: {
        where?: unknown;
        orderBy?: unknown;
        take?: unknown;
        skip?: unknown;
      }) {
        findManyCalls.push(args);
        return Promise.resolve(events);
      },
      count() {
        return Promise.resolve(events.length);
      },
    },
    $transaction(ops: Promise<unknown>[]) {
      return Promise.all(ops);
    },
    _findManyCalls: findManyCalls,
  };

  return prisma as unknown as {
    pullRequest: {
      findUnique: (args: unknown) => Promise<{ id: string } | null>;
    };
    pullRequestEvent: {
      findMany: (args: {
        where?: unknown;
        orderBy?: unknown;
        take?: unknown;
        skip?: unknown;
      }) => Promise<unknown[]>;
      count: () => Promise<number>;
    };
    $transaction: (ops: Promise<unknown>[]) => Promise<unknown[]>;
    _findManyCalls: Array<{
      where?: unknown;
      orderBy?: unknown;
      take?: unknown;
      skip?: unknown;
    }>;
  };
}

describe("PullRequestService.getEvents()", () => {
  const NOW = new Date("2026-08-19T00:00:00.000Z");
  const clock = FixedClock(NOW);

  test("throws NotFoundError and never queries events when the PR does not exist", async () => {
    const prisma = makeEventsPrismaDouble(false);
    const svc = new PullRequestService(prisma as never, clock);

    await expect(svc.getEvents("missing-pr")).rejects.toThrow(NotFoundError);
    expect(prisma._findManyCalls).toHaveLength(0);
  });

  test("queries pullRequestEvent scoped to prRecordId, ordered by `at` ascending", async () => {
    const prisma = makeEventsPrismaDouble(true);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.getEvents("pr-1");

    expect(prisma._findManyCalls).toHaveLength(1);
    const call = prisma._findManyCalls[0];
    expect(call.where).toEqual({ prRecordId: "pr-1" });
    expect(call.orderBy).toEqual({ at: "asc" });
  });

  test("defaults limit to 50 and offset to 0 when the caller omits opts", async () => {
    const prisma = makeEventsPrismaDouble(true);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.getEvents("pr-1");

    const call = prisma._findManyCalls[0];
    expect(call.take).toBe(50);
    expect(call.skip).toBe(0);
  });

  test("forwards caller-supplied limit/offset to the findMany() call", async () => {
    const prisma = makeEventsPrismaDouble(true);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.getEvents("pr-1", { limit: 10, offset: 5 });

    const call = prisma._findManyCalls[0];
    expect(call.take).toBe(10);
    expect(call.skip).toBe(5);
  });

  test("returns events and total from the underlying findMany()/count() results", async () => {
    const events = [
      { id: "event-1", prRecordId: "pr-1", at: "2026-08-17T00:00:00.000Z" },
      { id: "event-2", prRecordId: "pr-1", at: "2026-08-17T01:00:00.000Z" },
    ];
    const prisma = makeEventsPrismaDouble(true, events);
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.getEvents("pr-1");

    expect(result.events).toEqual(events as never);
    expect(result.total).toBe(2);
  });

  test("returns an empty array and total 0 when the PR has no events", async () => {
    const prisma = makeEventsPrismaDouble(true, []);
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.getEvents("pr-1");

    expect(result.events).toEqual([]);
    expect(result.total).toBe(0);
  });
});

// ─── PullRequestService.stampOrigin() / census() (POM-1.1) ────────────────────

/**
 * A small in-memory Prisma double supporting exactly what stampOrigin()/
 * census() need: findUnique by the (repo, prNumber) unique key, update by id,
 * create, and a callback-form $transaction that invokes the callback with
 * the double itself as `tx` — mirrors attachEventStub's $transaction shape
 * above, extended with a `pullRequest` table keyed by (repo, prNumber)
 * instead of a single fixed findUniqueResult.
 */
function makeOriginPrismaDouble(seed: Partial<PullRequest>[] = []) {
  const rows = new Map<string, Partial<PullRequest>>();
  for (const row of seed) {
    rows.set(`${row.repo}#${row.prNumber}`, { ...row });
  }
  let nextId = rows.size;
  const createCalls: Record<string, unknown>[] = [];
  const updateCalls: {
    where: { id: string };
    data: Record<string, unknown>;
  }[] = [];

  const prisma = {
    pullRequest: {
      findUnique({
        where,
      }: {
        where: { repo_prNumber: { repo: string; prNumber: number } };
      }) {
        const { repo, prNumber } = where.repo_prNumber;
        return Promise.resolve(rows.get(`${repo}#${prNumber}`) ?? null);
      },
      update({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) {
        updateCalls.push({ where, data });
        for (const [key, row] of rows) {
          if (row.id === where.id) {
            const updated = { ...row, ...data };
            rows.set(key, updated);
            return Promise.resolve(updated);
          }
        }
        return Promise.reject(new Error(`row ${where.id} not found`));
      },
      create({ data }: { data: Record<string, unknown> }) {
        createCalls.push(data);
        nextId += 1;
        const record = { id: `pr-${nextId}`, ...data };
        rows.set(`${data.repo}#${data.prNumber}`, record);
        return Promise.resolve(record);
      },
      findFirst({
        where,
        orderBy: _orderBy,
      }: {
        where: {
          repo: string;
          origin?: { not: null };
          mergedAt?: { not: null };
        };
        orderBy?: unknown;
      }) {
        const candidates = Array.from(rows.values())
          .filter((r) => r.repo === where.repo)
          .filter((r) => (where.origin ? r.origin !== null : true))
          .filter((r) => (where.mergedAt ? r.mergedAt !== null : true))
          .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
        return Promise.resolve(candidates[0] ?? null);
      },
    },
    $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(prisma);
    },
    _rows: rows,
    _createCalls: createCalls,
    _updateCalls: updateCalls,
  };
  return prisma;
}

describe("PullRequestService.stampOrigin() (POM-1.1)", () => {
  const NOW = new Date("2026-09-16T00:00:00.000Z");
  const clock = FixedClock(NOW);

  test("creates a new row when none exists, writing the supplied fields", async () => {
    const prisma = makeOriginPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    const record = await svc.stampOrigin("org/repo", 42, {
      origin: "shipwright",
      authorLogin: "octocat",
      headRef: "feat/x",
      title: "Add X",
    });

    expect(record.origin).toBe("shipwright" as never);
    expect(prisma._createCalls).toHaveLength(1);
    expect(prisma._createCalls[0]).toMatchObject({
      repo: "org/repo",
      prNumber: 42,
      origin: "shipwright",
      authorLogin: "octocat",
      headRef: "feat/x",
      title: "Add X",
    });
  });

  test("first-write-wins: does not overwrite an existing non-null origin", async () => {
    const prisma = makeOriginPrismaDouble([
      {
        id: "pr-existing",
        repo: "org/repo",
        prNumber: 42,
        origin: "human" as never,
      },
    ]);
    const svc = new PullRequestService(prisma as never, clock);

    const record = await svc.stampOrigin("org/repo", 42, {
      origin: "shipwright",
    });

    // No other field was supplied, and origin is blocked by first-write-wins
    // — the update payload is empty, so no write happens at all (a pure
    // no-op) and the pre-existing row is returned unchanged.
    expect(prisma._updateCalls).toHaveLength(0);
    expect(record.origin).toBe("human" as never);
    expect(prisma._rows.get("org/repo#42")?.origin).toBe("human" as never);
  });

  test("first-write-wins: applies origin when the existing row's origin is currently null", async () => {
    const prisma = makeOriginPrismaDouble([
      { id: "pr-existing", repo: "org/repo", prNumber: 42, origin: null },
    ]);
    const svc = new PullRequestService(prisma as never, clock);

    const record = await svc.stampOrigin("org/repo", 42, {
      origin: "ci",
    });

    expect(record.origin).toBe("ci" as never);
    expect(prisma._updateCalls[0].data.origin).toBe("ci");
  });

  test("writes authorLogin/headRef/title unconditionally on an existing row, leaving omitted fields untouched", async () => {
    const prisma = makeOriginPrismaDouble([
      {
        id: "pr-existing",
        repo: "org/repo",
        prNumber: 42,
        origin: "human" as never,
        authorLogin: "old-login",
        headRef: "old-ref",
        title: "old title",
      },
    ]);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.stampOrigin("org/repo", 42, { authorLogin: "new-login" });

    const { data } = prisma._updateCalls[0];
    expect(data.authorLogin).toBe("new-login");
    // headRef/title were omitted from this call — untouched (not forced to
    // null, not present in the update payload at all).
    expect(data.headRef).toBeUndefined();
    expect(data.title).toBeUndefined();
    expect(prisma._rows.get("org/repo#42")?.headRef).toBe("old-ref");
    expect(prisma._rows.get("org/repo#42")?.title).toBe("old title");
  });

  test("an explicit null authorLogin clears it (distinct from omitting the field)", async () => {
    const prisma = makeOriginPrismaDouble([
      {
        id: "pr-existing",
        repo: "org/repo",
        prNumber: 42,
        authorLogin: "old-login",
      },
    ]);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.stampOrigin("org/repo", 42, { authorLogin: null });

    expect(prisma._rows.get("org/repo#42")?.authorLogin).toBeNull();
  });

  test("runs against a supplied tx client directly (no nested transaction) when `client` is provided", async () => {
    const prisma = makeOriginPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);
    let transactionCalls = 0;
    const txSpy = {
      pullRequest: prisma.pullRequest,
    };
    const originalTransaction = prisma.$transaction;
    prisma.$transaction = (fn: (tx: unknown) => unknown) => {
      transactionCalls += 1;
      return originalTransaction(fn as never);
    };

    await svc.stampOrigin("org/repo", 7, { origin: "unknown" }, txSpy as never);

    expect(transactionCalls).toBe(0);
    expect(prisma._rows.get("org/repo#7")?.origin).toBe("unknown" as never);
  });
});

describe("PullRequestService.census() (POM-1.1)", () => {
  const NOW = new Date("2026-09-16T00:00:00.000Z");
  const clock = FixedClock(NOW);

  test("creates a new row with phase=null/reviewState=pending/staged=false left absent (schema defaults apply) and writes the supplied fields", async () => {
    const prisma = makeOriginPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    const [record] = await svc.census([
      {
        repo: "org/repo",
        prNumber: 100,
        origin: "ci",
        authorLogin: "renovate[bot]",
        state: "merged",
        mergedAt: "2026-01-05T00:00:00.000Z",
      },
    ]);

    expect(record.origin).toBe("ci" as never);
    const created = prisma._createCalls[0];
    // create() never sets phase/reviewState/staged explicitly — the schema's
    // own defaults (phase=null, reviewState='pending', staged=false) apply.
    expect(created.phase).toBeUndefined();
    expect(created.reviewState).toBeUndefined();
    expect(created.staged).toBeUndefined();
    expect(created.state).toBe("merged");
    expect(created.mergedAt).toBe("2026-01-05T00:00:00.000Z");
  });

  test("on an existing row, writes authorLogin/headRef/title/state/mergedAt/prCreatedAt unconditionally but never touches claim/phase/review/patch/blocked fields", async () => {
    const prisma = makeOriginPrismaDouble([
      {
        id: "pr-existing",
        repo: "org/repo",
        prNumber: 42,
        origin: "human" as never,
        claimedBy: "agent-x",
        claimedAt: "2026-01-01T00:00:00.000Z",
        heartbeatAt: "2026-01-01T00:00:00.000Z",
        phase: "review" as never,
        reviewState: "in_progress" as never,
        patchCycles: 3,
        reviewCycles: 2,
        blocked: true,
        blockedReason: "stuck",
      },
    ]);
    const svc = new PullRequestService(prisma as never, clock);

    const [record] = await svc.census([
      {
        repo: "org/repo",
        prNumber: 42,
        authorLogin: "new-login",
        headRef: "feat/y",
        title: "New title",
        state: "merged",
        mergedAt: "2026-02-01T00:00:00.000Z",
        prCreatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(record.authorLogin).toBe("new-login");
    expect(record.headRef).toBe("feat/y");
    expect(record.title).toBe("New title");
    expect(record.state).toBe("merged" as never);
    expect(record.mergedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(record.prCreatedAt).toBe("2026-01-01T00:00:00.000Z");
    // Never touched:
    expect(record.claimedBy).toBe("agent-x");
    expect(record.claimedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(record.heartbeatAt).toBe("2026-01-01T00:00:00.000Z");
    expect(record.phase).toBe("review" as never);
    expect(record.reviewState).toBe("in_progress" as never);
    expect(record.patchCycles).toBe(3);
    expect(record.reviewCycles).toBe(2);
    expect(record.blocked).toBe(true);
    expect(record.blockedReason).toBe("stuck");
    // Origin left unchanged (already non-null).
    expect(record.origin).toBe("human" as never);
  });

  test("rejects a batch of more than MAX_CENSUS_ENTRIES with BadRequestError, before any write", async () => {
    const prisma = makeOriginPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    const entries = Array.from({ length: MAX_CENSUS_ENTRIES + 1 }, (_, i) => ({
      repo: "org/repo",
      prNumber: i + 1,
    }));

    await expect(svc.census(entries)).rejects.toThrow(BadRequestError);
    expect(prisma._createCalls).toHaveLength(0);
  });

  test("upserts multiple entries in one call", async () => {
    const prisma = makeOriginPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    const records = await svc.census([
      { repo: "org/repo", prNumber: 1, origin: "human" },
      { repo: "org/repo", prNumber: 2, origin: "ci" },
    ]);

    expect(records).toHaveLength(2);
    expect(prisma._rows.get("org/repo#1")?.origin).toBe("human" as never);
    expect(prisma._rows.get("org/repo#2")?.origin).toBe("ci" as never);
  });
});

describe("PullRequestService.getCensusCursor() (POM-1.1)", () => {
  const NOW = new Date("2026-09-16T00:00:00.000Z");
  const clock = FixedClock(NOW);

  test("returns the max mergedAt among rows scoped to repo with a non-null origin", async () => {
    const prisma = makeOriginPrismaDouble([
      {
        id: "pr-1",
        repo: "org/repo",
        prNumber: 1,
        origin: "shipwright" as never,
        mergedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "pr-2",
        repo: "org/repo",
        prNumber: 2,
        origin: "ci" as never,
        mergedAt: "2026-03-01T00:00:00.000Z",
      },
    ]);
    const svc = new PullRequestService(prisma as never, clock);

    const cursor = await svc.getCensusCursor("org/repo");

    expect(cursor).toBe("2026-03-01T00:00:00.000Z");
  });

  test("returns null when no row has a non-null origin", async () => {
    const prisma = makeOriginPrismaDouble([
      {
        id: "pr-1",
        repo: "org/repo",
        prNumber: 1,
        origin: null,
        mergedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const svc = new PullRequestService(prisma as never, clock);

    const cursor = await svc.getCensusCursor("org/repo");

    expect(cursor).toBeNull();
  });
});

// ─── deriveOrigin() (POM-1.2) ───────────────────────────────────────────────

describe("deriveOrigin() (POM-1.2)", () => {
  test("authorLogin 'github-actions[bot]' -> ci", () => {
    expect(
      deriveOrigin({ hasLinkedTask: false, authorLogin: "github-actions[bot]" }),
    ).toBe("ci");
  });

  test("headRef matching chore/chart-v* with no matching author -> ci", () => {
    expect(
      deriveOrigin({
        hasLinkedTask: false,
        authorLogin: "someone",
        headRef: "chore/chart-v1.2.3",
      }),
    ).toBe("ci");
  });

  test("headRef matching chore/plugin-version-v* -> ci", () => {
    expect(
      deriveOrigin({
        hasLinkedTask: false,
        headRef: "chore/plugin-version-v1.0.0",
      }),
    ).toBe("ci");
  });

  test("a headRef that merely contains, but doesn't start with, the chore/chart-v prefix does not match", () => {
    expect(
      deriveOrigin({
        hasLinkedTask: false,
        authorLogin: "octocat",
        headRef: "feat/chore/chart-v1.2.3",
      }),
    ).toBe("human");
  });

  test("authorLogin 'renovate[bot]' -> dependency_bot", () => {
    expect(
      deriveOrigin({ hasLinkedTask: false, authorLogin: "renovate[bot]" }),
    ).toBe("dependency_bot");
  });

  test("authorLogin 'dependabot[bot]' -> dependency_bot", () => {
    expect(
      deriveOrigin({ hasLinkedTask: false, authorLogin: "dependabot[bot]" }),
    ).toBe("dependency_bot");
  });

  test("a task-row match with a human authorLogin -> shipwright", () => {
    expect(
      deriveOrigin({ hasLinkedTask: true, authorLogin: "octocat" }),
    ).toBe("shipwright");
  });

  test("a human login with no task-row match -> human", () => {
    expect(
      deriveOrigin({ hasLinkedTask: false, authorLogin: "octocat" }),
    ).toBe("human");
  });

  test("missing authorLogin and no task-row match -> unknown", () => {
    expect(deriveOrigin({ hasLinkedTask: false })).toBe("unknown");
    expect(deriveOrigin({ hasLinkedTask: false, authorLogin: null })).toBe(
      "unknown",
    );
    expect(deriveOrigin({ hasLinkedTask: false, authorLogin: "" })).toBe(
      "unknown",
    );
  });

  test("a task-row match takes precedence over an authorLogin that would otherwise say 'ci'", () => {
    expect(
      deriveOrigin({
        hasLinkedTask: true,
        authorLogin: "github-actions[bot]",
      }),
    ).toBe("shipwright");
  });

  test("a task-row match takes precedence over an authorLogin that would otherwise say 'dependency_bot'", () => {
    expect(
      deriveOrigin({ hasLinkedTask: true, authorLogin: "renovate[bot]" }),
    ).toBe("shipwright");
  });
});

// ─── PullRequestService.claim() origin stamping (POM-1.2) ──────────────────

interface ClaimPrismaSeedRow extends Partial<PullRequest> {
  id: string;
  repo: string;
  prNumber: number;
}

/**
 * A hand-built Prisma double for exercising claim()'s POM-1.2 origin-stamping
 * tail call end-to-end: findUnique/update/create on `pullRequest` (the
 * conflict-detection WHERE guard is intentionally not simulated — these tests
 * only exercise the origin-stamping behavior tacked on after a successful
 * write, not the CRF-1.1 race-detection logic covered elsewhere), a no-op
 * `pullRequestEvent.create` audit stub, a `task.findFirst` stub backed by a
 * caller-supplied list of linked-task rows, and a callback-form
 * `$transaction`. Mirrors makeOriginPrismaDouble's conventions, extended with
 * the `task` table claim()'s origin derivation now needs.
 */
function makeClaimPrismaDouble(
  seed: ClaimPrismaSeedRow[] = [],
  taskRows: { repo: string; pr: number }[] = [],
) {
  const rows = new Map<string, Partial<PullRequest>>();
  for (const row of seed) {
    rows.set(`${row.repo}#${row.prNumber}`, { ...row });
  }
  let nextId = rows.size;

  const prisma = {
    pullRequest: {
      findUnique({
        where,
      }: {
        where: { repo_prNumber: { repo: string; prNumber: number } };
      }) {
        const { repo, prNumber } = where.repo_prNumber;
        return Promise.resolve(rows.get(`${repo}#${prNumber}`) ?? null);
      },
      update({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) {
        for (const [key, row] of rows) {
          if (row.id === where.id) {
            const updated = { ...row, ...data };
            rows.set(key, updated);
            return Promise.resolve(updated);
          }
        }
        return Promise.reject(new Error(`row ${where.id} not found`));
      },
      create({ data }: { data: Record<string, unknown> }) {
        nextId += 1;
        // Mirror Prisma's own behavior for an omitted nullable column
        // (`origin PrOrigin?` has no explicit default): the stored value is
        // `null`, not simply absent — matters because upsertOriginFields'
        // first-write-wins check tests `existing.origin === null` and would
        // otherwise wrongly treat an omitted key as "already has an origin".
        const record = { id: `pr-${nextId}`, origin: null, ...data };
        rows.set(`${data.repo}#${data.prNumber}`, record);
        return Promise.resolve(record);
      },
    },
    pullRequestEvent: {
      create(_args: unknown) {
        return Promise.resolve({ id: "event-1" });
      },
    },
    task: {
      findFirst({ where }: { where: { repo: string; pr: number } }) {
        const match = taskRows.find(
          (t) => t.repo === where.repo && t.pr === where.pr,
        );
        return Promise.resolve(match ? { id: `task-${match.repo}-${match.pr}` } : null);
      },
    },
    $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(prisma);
    },
    _rows: rows,
  };
  return prisma;
}

describe("PullRequestService.claim() origin stamping (POM-1.2)", () => {
  const NOW = new Date("2026-09-16T00:00:00.000Z");
  const clock = FixedClock(NOW);

  test("creates a new row and stamps origin derived from authorLogin/headRef/title", async () => {
    const prisma = makeClaimPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    const { status, record } = await svc.claim(
      "org/repo",
      42,
      "sha1",
      "agent-a",
      "review",
      undefined,
      "octocat",
      "feat/x",
      "Add X",
    );

    expect(status).toBe(201);
    expect(record.origin).toBe("human" as never);
    expect(record.authorLogin).toBe("octocat");
    expect(record.headRef).toBe("feat/x");
    expect(record.title).toBe("Add X");
  });

  test("a task-row match derives origin='shipwright' on create, even when authorLogin looks like a bot", async () => {
    const prisma = makeClaimPrismaDouble([], [{ repo: "org/repo", pr: 42 }]);
    const svc = new PullRequestService(prisma as never, clock);

    const { record } = await svc.claim(
      "org/repo",
      42,
      "sha1",
      "agent-a",
      "review",
      undefined,
      "github-actions[bot]",
    );

    expect(record.origin).toBe("shipwright" as never);
  });

  test("existing claim() callers with the old positional argument count still work (authorLogin/headRef/title omitted -> unknown)", async () => {
    const prisma = makeClaimPrismaDouble();
    const svc = new PullRequestService(prisma as never, clock);

    const { status, record } = await svc.claim(
      "org/repo",
      7,
      "sha1",
      "agent-a",
    );

    expect(status).toBe(201);
    expect(record.origin).toBe("unknown" as never);
  });

  test("claim() on an existing row with a non-null origin does not change origin, but still updates authorLogin/headRef/title/commitSha/claimedBy/claimedAt/heartbeatAt/phase", async () => {
    const prisma = makeClaimPrismaDouble([
      {
        id: "pr-existing",
        repo: "org/repo",
        prNumber: 42,
        origin: "human" as never,
        authorLogin: "old-login",
        headRef: "old-ref",
        title: "old title",
        commitSha: "old-sha",
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
        phase: null,
        reviewState: "pending" as never,
      },
    ]);
    const svc = new PullRequestService(prisma as never, clock);

    const { status, record } = await svc.claim(
      "org/repo",
      42,
      "new-sha",
      "agent-b",
      "review",
      undefined,
      // Would derive "ci" if origin weren't already set — proves
      // first-write-wins holds through claim(), not just stampOrigin().
      "github-actions[bot]",
      "new-ref",
      "new title",
    );

    expect(status).toBe(200);
    expect(record.origin).toBe("human" as never);
    expect(record.authorLogin).toBe("github-actions[bot]");
    expect(record.headRef).toBe("new-ref");
    expect(record.title).toBe("new title");
    expect(record.commitSha).toBe("new-sha");
    expect(record.claimedBy).toBe("agent-b");
    expect(record.claimedAt).toBe(NOW.toISOString());
    expect(record.heartbeatAt).toBe(NOW.toISOString());
    expect(record.phase).toBe("review" as never);
  });
});
