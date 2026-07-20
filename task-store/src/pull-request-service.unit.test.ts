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

describe("PullRequestService.update() hitl/hitlNotifiedAt/blockedReason pass-through", () => {
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  const clock = FixedClock(NOW);

  test("update() persists hitl/hitlNotifiedAt/blockedReason and returns them", async () => {
    const prisma = makePrismaDouble({ id: "pr-1" } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    const result = await svc.update("pr-1", {
      hitl: true,
      hitlNotifiedAt: NOW.toISOString(),
      blockedReason: "no linked task",
    });

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect(data.hitl).toBe(true);
    expect(data.hitlNotifiedAt).toBe(NOW.toISOString());
    expect(data.blockedReason).toBe("no linked task");
    expect(result.hitl).toBe(true);
    expect(result.hitlNotifiedAt).toBe(NOW.toISOString());
    expect(result.blockedReason).toBe("no linked task");
  });

  test("update() omitting hitl/hitlNotifiedAt/blockedReason does not touch them", async () => {
    const prisma = makePrismaDouble({ id: "pr-1" } as Partial<PullRequest>);
    const svc = new PullRequestService(prisma as never, clock);

    await svc.update("pr-1", { commitSha: "sha-unrelated" });

    expect(prisma._updateCalls).toHaveLength(1);
    const { data } = prisma._updateCalls[0];
    expect("hitl" in data).toBe(false);
    expect("hitlNotifiedAt" in data).toBe(false);
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
