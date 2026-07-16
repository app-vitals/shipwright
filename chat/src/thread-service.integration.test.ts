/**
 * chat/src/thread-service.integration.test.ts
 * Integration tests for ThreadService — Prisma-backed CRUD + stats aggregation.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_CHAT to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { FixedClock } from "./clock.ts";
import { ThreadService } from "./thread-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_CHAT;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    // TEST_DB is guaranteed set — the describe block is skipped otherwise.
    datasources: { db: { url: TEST_DB as string } },
  });
}

describeOrSkip("ThreadService (integration)", () => {
  let prisma: PrismaClient;
  let service: ThreadService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.message.deleteMany();
    await prisma.thread.deleteMany();
    service = new ThreadService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  // ─── create() ───────────────────────────────────────────────────────────────

  describe("create()", () => {
    it("persists a thread with defaults when optional fields are omitted", async () => {
      const created = await service.create({ agentId: "agent-1" });

      const read = await service.findById(created.id);
      expect(read).not.toBeNull();
      expect(read?.agentId).toBe("agent-1");
      expect(read?.memberId).toBeNull();
      expect(read?.title).toBeNull();
      expect(read?.createdAt).toBeInstanceOf(Date);
      expect(read?.updatedAt).toBeInstanceOf(Date);
    });

    it("persists a thread with all optional fields populated", async () => {
      const created = await service.create({
        agentId: "agent-1",
        memberId: "member-1",
        title: "Support request",
      });

      const read = await service.findById(created.id);
      expect(read).not.toBeNull();
      expect(read?.agentId).toBe("agent-1");
      expect(read?.memberId).toBe("member-1");
      expect(read?.title).toBe("Support request");
    });
  });

  // ─── findById() ─────────────────────────────────────────────────────────────

  describe("findById()", () => {
    it("returns null for a nonexistent id", async () => {
      const result = await service.findById("nonexistent-id");
      expect(result).toBeNull();
    });

    it("returns the full row for an existing thread", async () => {
      const created = await service.create({
        agentId: "agent-1",
        title: "find me",
      });

      const read = await service.findById(created.id);
      expect(read?.id).toBe(created.id);
      expect(read?.title).toBe("find me");
    });
  });

  // ─── list() ─────────────────────────────────────────────────────────────────

  describe("list()", () => {
    it("returns threads ordered by updatedAt desc", async () => {
      const first = await prisma.thread.create({
        data: {
          agentId: "agent-1",
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        },
      });
      const second = await prisma.thread.create({
        data: {
          agentId: "agent-1",
          updatedAt: new Date("2026-01-02T00:00:00Z"),
        },
      });
      const third = await prisma.thread.create({
        data: {
          agentId: "agent-1",
          updatedAt: new Date("2026-01-03T00:00:00Z"),
        },
      });

      const { threads } = await service.list();
      expect(threads.map((t) => t.id)).toEqual([third.id, second.id, first.id]);
    });

    it("filters by agentId", async () => {
      const matching = await prisma.thread.create({
        data: { agentId: "agent-1" },
      });
      await prisma.thread.create({ data: { agentId: "agent-2" } });

      const { threads, total } = await service.list({ agentId: "agent-1" });
      expect(threads.map((t) => t.id)).toEqual([matching.id]);
      expect(total).toBe(1);
    });

    it("filters by memberId", async () => {
      const matching = await prisma.thread.create({
        data: { agentId: "agent-1", memberId: "member-1" },
      });
      await prisma.thread.create({
        data: { agentId: "agent-1", memberId: "member-2" },
      });
      await prisma.thread.create({ data: { agentId: "agent-1" } });

      const { threads, total } = await service.list({ memberId: "member-1" });
      expect(threads.map((t) => t.id)).toEqual([matching.id]);
      expect(total).toBe(1);
    });

    it("respects limit/offset and returns an accurate total independent of pagination", async () => {
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const t = await prisma.thread.create({
          data: {
            agentId: "agent-1",
            updatedAt: new Date(2026, 0, i + 1),
          },
        });
        created.push(t.id);
      }
      // updatedAt desc: created[4], created[3], created[2], created[1], created[0]
      const page = await service.list({ limit: 2, offset: 1 });
      expect(page.threads.map((t) => t.id)).toEqual([created[3], created[2]]);
      expect(page.total).toBe(5);
    });

    it("caps limit at 200 and defaults to 50 when unspecified", async () => {
      const { threads: withDefault } = await service.list();
      expect(withDefault.length).toBeLessThanOrEqual(50);

      const { threads: withHugeLimit } = await service.list({ limit: 10000 });
      expect(withHugeLimit.length).toBeLessThanOrEqual(200);
    });
  });

  // ─── update() ───────────────────────────────────────────────────────────────

  describe("update()", () => {
    it("partial update only touches the fields passed and bumps updatedAt via the injected clock", async () => {
      const clock = FixedClock(new Date("2026-05-01T10:00:00Z"));
      const svc = new ThreadService(prisma, clock);
      const created = await svc.create({
        agentId: "agent-1",
        memberId: "member-1",
        title: "original title",
      });

      const updated = await svc.update(created.id, { title: "new title" });

      expect(updated?.title).toBe("new title");
      expect(updated?.memberId).toBe("member-1");
      expect(updated?.updatedAt).toEqual(new Date("2026-05-01T10:00:00Z"));
    });

    it("allows clearing memberId and title via explicit null", async () => {
      const created = await service.create({
        agentId: "agent-1",
        memberId: "member-1",
        title: "has title",
      });

      const updated = await service.update(created.id, {
        title: null,
        memberId: null,
      });

      expect(updated?.title).toBeNull();
      expect(updated?.memberId).toBeNull();
    });

    it("returns null for a nonexistent id", async () => {
      const result = await service.update("nonexistent-id", { title: "x" });
      expect(result).toBeNull();
    });
  });

  // ─── delete() ───────────────────────────────────────────────────────────────

  describe("delete()", () => {
    it("removes the row and returns the deleted record", async () => {
      const created = await service.create({
        agentId: "agent-1",
        title: "to be deleted",
      });

      const deleted = await service.delete(created.id);
      expect(deleted?.id).toBe(created.id);

      const read = await service.findById(created.id);
      expect(read).toBeNull();
    });

    it("returns null for a nonexistent id", async () => {
      const result = await service.delete("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  // ─── getStats() ─────────────────────────────────────────────────────────────

  describe("getStats()", () => {
    it("returns zeroed stats for a thread with no messages", async () => {
      const thread = await service.create({ agentId: "agent-1" });

      const stats = await service.getStats(thread);

      expect(stats.messageCount).toBe(0);
      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
      expect(stats.totalCostUsd).toBe(0);
    });

    it("aggregates message count, tokens, and cost across a thread's messages", async () => {
      const thread = await service.create({ agentId: "agent-1" });

      await prisma.message.create({
        data: {
          threadId: thread.id,
          role: "user",
          body: "hello",
          tokens: { input_tokens: 10, output_tokens: 0 },
          costUsd: 0.001,
        },
      });
      await prisma.message.create({
        data: {
          threadId: thread.id,
          role: "assistant",
          body: "hi there",
          tokens: { input_tokens: 5, output_tokens: 20 },
          costUsd: 0.004,
        },
      });
      // Message with no tokens/cost set — should contribute 0, not throw.
      await prisma.message.create({
        data: {
          threadId: thread.id,
          role: "user",
          body: "no metadata",
        },
      });

      const stats = await service.getStats(thread);

      expect(stats.messageCount).toBe(3);
      expect(stats.totalInputTokens).toBe(15);
      expect(stats.totalOutputTokens).toBe(20);
      expect(stats.totalCostUsd).toBeCloseTo(0.005);
    });

    it("only aggregates messages belonging to the given thread", async () => {
      const thread = await service.create({ agentId: "agent-1" });
      const otherThread = await service.create({ agentId: "agent-1" });

      await prisma.message.create({
        data: {
          threadId: thread.id,
          role: "user",
          body: "mine",
          tokens: { input_tokens: 1, output_tokens: 1 },
          costUsd: 0.01,
        },
      });
      await prisma.message.create({
        data: {
          threadId: otherThread.id,
          role: "user",
          body: "not mine",
          tokens: { input_tokens: 100, output_tokens: 100 },
          costUsd: 1,
        },
      });

      const stats = await service.getStats(thread);

      expect(stats.messageCount).toBe(1);
      expect(stats.totalInputTokens).toBe(1);
      expect(stats.totalOutputTokens).toBe(1);
      expect(stats.totalCostUsd).toBeCloseTo(0.01);
    });
  });
});
