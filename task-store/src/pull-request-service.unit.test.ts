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
import { NotFoundError } from "./errors.ts";
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
function makePrismaDouble(findUniqueResult: Partial<PullRequest> | null = null) {
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
