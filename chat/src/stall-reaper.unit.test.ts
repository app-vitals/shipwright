/**
 * chat/src/stall-reaper.unit.test.ts
 *
 * Unit tests for StallReaper. Uses a Prisma double (a `findMany` stub
 * returning canned candidate rows) + a spy MessageServiceLike + FixedClock
 * for deterministic time — no mock.module, no global overrides.
 */

import { describe, expect, test } from "bun:test";
import { FixedClock } from "./clock.ts";
import type { PrismaClient } from "./index.ts";
import type {
  JsonValue,
  Message,
  MessageServiceLike,
} from "./message-service.ts";
import { DEFAULT_STALLED_AFTER_MS, StallReaper } from "./stall-reaper.ts";

// ─── Prisma double ────────────────────────────────────────────────────────────

interface FindManyCall {
  where: unknown;
}

function makePrismaDouble(candidates: Message[]) {
  const calls: FindManyCall[] = [];
  const prisma = {
    message: {
      findMany: (args: { where: unknown }): Promise<Message[]> => {
        calls.push({ where: args.where });
        return Promise.resolve(candidates);
      },
    },
    _calls: calls,
  };
  return prisma as unknown as PrismaClient & { _calls: FindManyCall[] };
}

// ─── MessageService spy ───────────────────────────────────────────────────────

interface ReplyCall {
  id: string;
  data: {
    body: string;
    tokens?: JsonValue;
    costUsd?: number;
    errorKind?: string | null;
  };
}

function makeMessageServiceSpy(
  replyResults: Record<string, "ok" | "null" | Error> = {},
) {
  const replyCalls: ReplyCall[] = [];
  const svc: MessageServiceLike = {
    create: async () => {
      throw new Error("not implemented");
    },
    findById: async () => null,
    list: async () => ({ messages: [], total: 0 }),
    update: async () => null,
    delete: async () => null,
    clearAttachmentBytes: async () => null,
    claim: async () => null,
    heartbeat: async () => null,
    async reply(id, data) {
      replyCalls.push({ id, data });
      const outcome = replyResults[id] ?? "ok";
      if (outcome instanceof Error) throw outcome;
      if (outcome === "null") return null;
      return {
        userMessage: makeMessage({ id, repliedAt: new Date() }),
        assistantMessage: makeMessage({
          id: `${id}-reply`,
          role: "assistant",
          errorKind: data.errorKind ?? null,
        }),
      };
    },
    requestCancel: async () => null,
  };
  return { svc, replyCalls };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    threadId: "thread-1",
    role: "user",
    body: "hello",
    tokens: null,
    costUsd: null,
    attachmentFilename: null,
    attachmentSize: null,
    attachmentBytes: null,
    claimed: true,
    claimedAt: new Date("2026-06-24T11:00:00.000Z"),
    claimedBy: "agent-1",
    heartbeatAt: null,
    progressPhase: null,
    progressSeq: 0,
    cancelRequestedAt: null,
    repliedAt: null,
    errorKind: null,
    createdAt: new Date("2026-06-24T10:59:00.000Z"),
    ...overrides,
  } as Message;
}

/** Build a Date that is `offsetMs` milliseconds before `now`. */
function msAgo(now: Date, offsetMs: number): Date {
  return new Date(now.getTime() - offsetMs);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("StallReaper", () => {
  const NOW = new Date("2026-06-24T12:00:00.000Z");
  const clock = FixedClock(NOW);

  test("reaps a claimed, unreplied message with heartbeatAt older than cutoff", async () => {
    const stale = makeMessage({
      id: "msg-stale",
      heartbeatAt: msAgo(NOW, DEFAULT_STALLED_AFTER_MS + 1_000),
    });
    const prisma = makePrismaDouble([stale]);
    const { svc, replyCalls } = makeMessageServiceSpy();
    const reaper = new StallReaper(prisma, svc, clock);

    const count = await reaper.reap();

    expect(count).toBe(1);
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]?.id).toBe("msg-stale");
    expect(replyCalls[0]?.data.errorKind).toBe("stalled");
  });

  test("does not query for a message with heartbeatAt inside the cutoff window (query excludes it)", async () => {
    // The Prisma double just returns whatever candidates we give it — a fresh
    // heartbeat message would never be returned by a correct WHERE clause, so
    // simulate that by returning an empty candidate list and asserting no reply.
    const prisma = makePrismaDouble([]);
    const { svc, replyCalls } = makeMessageServiceSpy();
    const reaper = new StallReaper(prisma, svc, clock);

    const count = await reaper.reap();

    expect(count).toBe(0);
    expect(replyCalls).toHaveLength(0);
  });

  test("query WHERE clause matches heartbeatAt < cutoff OR (heartbeatAt null AND claimedAt < cutoff)", async () => {
    const prisma = makePrismaDouble([]);
    const { svc } = makeMessageServiceSpy();
    const reaper = new StallReaper(prisma, svc, clock);

    await reaper.reap();

    const call = prisma._calls[0];
    expect(call).toBeDefined();
    const where = call?.where as Record<string, unknown>;
    expect(where.role).toBe("user");
    expect(where.claimed).toBe(true);
    expect(where.repliedAt).toBeNull();
    expect(Array.isArray(where.OR)).toBe(true);
    const or = where.OR as Array<Record<string, unknown>>;
    expect(or).toHaveLength(2);

    const expectedCutoff = msAgo(NOW, DEFAULT_STALLED_AFTER_MS);
    const heartbeatClause = or[0] as { heartbeatAt: { lt: Date } };
    expect(heartbeatClause.heartbeatAt.lt.getTime()).toBe(
      expectedCutoff.getTime(),
    );
    const fallbackClause = or[1] as {
      heartbeatAt: null;
      claimedAt: { lt: Date };
    };
    expect(fallbackClause.heartbeatAt).toBeNull();
    expect(fallbackClause.claimedAt.lt.getTime()).toBe(
      expectedCutoff.getTime(),
    );
  });

  test("reaps a message with heartbeatAt=null but claimedAt older than cutoff (fallback case)", async () => {
    const stale = makeMessage({
      id: "msg-fallback",
      heartbeatAt: null,
      claimedAt: msAgo(NOW, DEFAULT_STALLED_AFTER_MS + 1_000),
    });
    const prisma = makePrismaDouble([stale]);
    const { svc, replyCalls } = makeMessageServiceSpy();
    const reaper = new StallReaper(prisma, svc, clock);

    const count = await reaper.reap();

    expect(count).toBe(1);
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]?.id).toBe("msg-fallback");
    expect(replyCalls[0]?.data.errorKind).toBe("stalled");
  });

  test("does not reap when heartbeatAt=null and claimedAt is inside the cutoff (not a candidate)", async () => {
    // A correct query would never return this row; simulate via empty candidates.
    const prisma = makePrismaDouble([]);
    const { svc, replyCalls } = makeMessageServiceSpy();
    const reaper = new StallReaper(prisma, svc, clock);

    const count = await reaper.reap();

    expect(count).toBe(0);
    expect(replyCalls).toHaveLength(0);
  });

  test("is idempotent: reply() returning null (already replied) does not throw and does not count as reaped", async () => {
    const stale = makeMessage({
      id: "msg-resumed",
      heartbeatAt: msAgo(NOW, DEFAULT_STALLED_AFTER_MS + 1_000),
    });
    const prisma = makePrismaDouble([stale]);
    const { svc, replyCalls } = makeMessageServiceSpy({
      "msg-resumed": "null",
    });
    const reaper = new StallReaper(prisma, svc, clock);

    const count = await reaper.reap();

    expect(count).toBe(0);
    expect(replyCalls).toHaveLength(1);
  });

  test("one bad row does not abort the sweep — remaining candidates still get reaped", async () => {
    const bad = makeMessage({
      id: "msg-bad",
      heartbeatAt: msAgo(NOW, DEFAULT_STALLED_AFTER_MS + 1_000),
    });
    const good1 = makeMessage({
      id: "msg-good-1",
      heartbeatAt: msAgo(NOW, DEFAULT_STALLED_AFTER_MS + 2_000),
    });
    const good2 = makeMessage({
      id: "msg-good-2",
      heartbeatAt: msAgo(NOW, DEFAULT_STALLED_AFTER_MS + 3_000),
    });
    const prisma = makePrismaDouble([bad, good1, good2]);
    const { svc, replyCalls } = makeMessageServiceSpy({
      "msg-bad": new Error("boom"),
    });
    const reaper = new StallReaper(prisma, svc, clock);

    const count = await reaper.reap();

    expect(count).toBe(2);
    expect(replyCalls).toHaveLength(3);
    expect(replyCalls.map((c) => c.id)).toEqual([
      "msg-bad",
      "msg-good-1",
      "msg-good-2",
    ]);
  });

  test("custom stalledAfterMs override changes the cutoff used in the query", async () => {
    const prisma = makePrismaDouble([]);
    const { svc } = makeMessageServiceSpy();
    const customMs = 60_000;
    const reaper = new StallReaper(prisma, svc, clock, customMs);

    await reaper.reap();

    const call = prisma._calls[0];
    const where = call?.where as { OR: Array<Record<string, unknown>> };
    const heartbeatClause = where.OR[0] as { heartbeatAt: { lt: Date } };
    const expectedCutoff = msAgo(NOW, customMs);
    expect(heartbeatClause.heartbeatAt.lt.getTime()).toBe(
      expectedCutoff.getTime(),
    );
  });

  test("reap() body message is stable, non-empty copy consistent with sibling errorKind bodies", async () => {
    const stale = makeMessage({
      id: "msg-stale-copy",
      heartbeatAt: msAgo(NOW, DEFAULT_STALLED_AFTER_MS + 1_000),
    });
    const prisma = makePrismaDouble([stale]);
    const { svc, replyCalls } = makeMessageServiceSpy();
    const reaper = new StallReaper(prisma, svc, clock);

    await reaper.reap();

    expect(replyCalls[0]?.data.body.length).toBeGreaterThan(0);
    expect(replyCalls[0]?.data.errorKind).toBe("stalled");
  });

  test("returns 0 when there are no candidates", async () => {
    const prisma = makePrismaDouble([]);
    const { svc, replyCalls } = makeMessageServiceSpy();
    const reaper = new StallReaper(prisma, svc, clock);

    const count = await reaper.reap();

    expect(count).toBe(0);
    expect(replyCalls).toHaveLength(0);
  });
});
