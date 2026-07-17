/**
 * chat/src/message-service.integration.test.ts
 * Integration tests for MessageService — Prisma-backed CRUD + claim/reply queue.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_CHAT to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { FixedClock } from "./clock.ts";
import { MessageService } from "./message-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_CHAT;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    // TEST_DB is guaranteed set — the describe block is skipped otherwise.
    datasources: { db: { url: TEST_DB as string } },
  });
}

async function createThread(prisma: PrismaClient, agentId = "agent-1"): Promise<string> {
  const thread = await prisma.thread.create({ data: { agentId } });
  return thread.id;
}

describeOrSkip("MessageService (integration)", () => {
  let prisma: PrismaClient;
  let service: MessageService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.message.deleteMany();
    await prisma.thread.deleteMany();
    service = new MessageService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  // ─── create() ───────────────────────────────────────────────────────────────

  describe("create()", () => {
    it("persists a message with defaults when optional fields are omitted", async () => {
      const threadId = await createThread(prisma);

      const created = await service.create(threadId, {
        role: "user",
        body: "hello there",
      });

      const read = await service.findById(created.id);
      expect(read).not.toBeNull();
      expect(read?.threadId).toBe(threadId);
      expect(read?.role).toBe("user");
      expect(read?.body).toBe("hello there");
      expect(read?.tokens).toBeNull();
      expect(read?.costUsd).toBeNull();
      expect(read?.attachmentFilename).toBeNull();
      expect(read?.attachmentSize).toBeNull();
      expect(read?.attachmentBytes).toBeNull();
      expect(read?.claimed).toBe(false);
      expect(read?.claimedAt).toBeNull();
      expect(read?.claimedBy).toBeNull();
      expect(read?.repliedAt).toBeNull();
      expect(read?.errorKind).toBeNull();
      expect(read?.createdAt).toBeInstanceOf(Date);
    });

    it("persists a message with all optional fields populated", async () => {
      const threadId = await createThread(prisma);
      const tokens = { input: 10, output: 20 };
      const attachmentBytes = new Uint8Array([1, 2, 3, 4]);

      const created = await service.create(threadId, {
        role: "assistant",
        body: "here's the reply",
        tokens,
        costUsd: 0.0042,
        attachmentFilename: "notes.txt",
        attachmentSize: 4,
        attachmentBytes,
      });

      const read = await service.findById(created.id);
      expect(read).not.toBeNull();
      expect(read?.tokens).toEqual(tokens);
      expect(read?.costUsd).toBeCloseTo(0.0042);
      expect(read?.attachmentFilename).toBe("notes.txt");
      expect(read?.attachmentSize).toBe(4);
      expect(Buffer.from(read?.attachmentBytes as Uint8Array)).toEqual(
        Buffer.from(attachmentBytes),
      );
    });
  });

  // ─── findById() ─────────────────────────────────────────────────────────────

  describe("findById()", () => {
    it("returns null for a nonexistent id", async () => {
      const result = await service.findById("nonexistent-id");
      expect(result).toBeNull();
    });

    it("returns the full row for an existing message", async () => {
      const threadId = await createThread(prisma);
      const created = await service.create(threadId, {
        role: "user",
        body: "find me",
      });

      const read = await service.findById(created.id);
      expect(read?.id).toBe(created.id);
      expect(read?.body).toBe("find me");
    });
  });

  // ─── list() ─────────────────────────────────────────────────────────────────

  describe("list()", () => {
    it("returns messages for a thread ordered oldest-first", async () => {
      const threadId = await createThread(prisma);
      const first = await prisma.message.create({
        data: {
          threadId,
          role: "user",
          body: "first",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      });
      const second = await prisma.message.create({
        data: {
          threadId,
          role: "assistant",
          body: "second",
          createdAt: new Date("2026-01-02T00:00:00Z"),
        },
      });
      const third = await prisma.message.create({
        data: {
          threadId,
          role: "user",
          body: "third",
          createdAt: new Date("2026-01-03T00:00:00Z"),
        },
      });

      const { messages } = await service.list(threadId);
      expect(messages.map((m) => m.id)).toEqual([first.id, second.id, third.id]);
    });

    it("respects limit/offset and returns an accurate total independent of pagination", async () => {
      const threadId = await createThread(prisma);
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const m = await prisma.message.create({
          data: {
            threadId,
            role: "user",
            body: `msg-${i}`,
            createdAt: new Date(2026, 0, i + 1),
          },
        });
        created.push(m.id);
      }

      const page = await service.list(threadId, { limit: 2, offset: 1 });
      expect(page.messages.map((m) => m.id)).toEqual([created[1], created[2]]);
      expect(page.total).toBe(5);
    });
  });

  // ─── update() ───────────────────────────────────────────────────────────────

  describe("update()", () => {
    it("partial update only touches the fields passed", async () => {
      const threadId = await createThread(prisma);
      const created = await service.create(threadId, {
        role: "user",
        body: "original body",
        tokens: { input: 1 },
        costUsd: 0.01,
      });

      const updated = await service.update(created.id, { body: "new body" });

      expect(updated?.body).toBe("new body");
      expect(updated?.tokens).toEqual({ input: 1 });
      expect(updated?.costUsd).toBeCloseTo(0.01);
    });

    it("returns null for a nonexistent id", async () => {
      const result = await service.update("nonexistent-id", { body: "x" });
      expect(result).toBeNull();
    });
  });

  // ─── delete() ───────────────────────────────────────────────────────────────

  describe("delete()", () => {
    it("removes the row and returns the deleted record", async () => {
      const threadId = await createThread(prisma);
      const created = await service.create(threadId, {
        role: "user",
        body: "to be deleted",
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

  // ─── clearAttachmentBytes() ─────────────────────────────────────────────────

  describe("clearAttachmentBytes()", () => {
    it("nulls attachmentBytes while preserving other attachment metadata", async () => {
      const threadId = await createThread(prisma);
      const created = await service.create(threadId, {
        role: "user",
        body: "has attachment",
        attachmentFilename: "file.bin",
        attachmentSize: 3,
        attachmentBytes: new Uint8Array([9, 9, 9]),
      });

      const cleared = await service.clearAttachmentBytes(created.id);
      expect(cleared?.attachmentBytes).toBeNull();
      expect(cleared?.attachmentFilename).toBe("file.bin");
      expect(cleared?.attachmentSize).toBe(3);
    });

    it("returns null for a nonexistent id", async () => {
      const result = await service.clearAttachmentBytes("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  // ─── claim() ────────────────────────────────────────────────────────────────

  describe("claim()", () => {
    it("claims the oldest unclaimed user message in a thread", async () => {
      const threadId = await createThread(prisma);
      const clock = FixedClock(new Date("2026-03-01T12:00:00Z"));
      const svc = new MessageService(prisma, clock);

      const older = await prisma.message.create({
        data: {
          threadId,
          role: "user",
          body: "older",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      });
      await prisma.message.create({
        data: {
          threadId,
          role: "user",
          body: "newer",
          createdAt: new Date("2026-01-02T00:00:00Z"),
        },
      });

      const claimed = await svc.claim(threadId, "worker-1");

      expect(claimed?.id).toBe(older.id);
      expect(claimed?.claimed).toBe(true);
      expect(claimed?.claimedAt).toEqual(new Date("2026-03-01T12:00:00Z"));
      expect(claimed?.claimedBy).toBe("worker-1");
    });

    it("ignores assistant messages and already-claimed messages", async () => {
      const threadId = await createThread(prisma);

      await prisma.message.create({
        data: {
          threadId,
          role: "assistant",
          body: "assistant msg",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      });
      await prisma.message.create({
        data: {
          threadId,
          role: "user",
          body: "already claimed",
          claimed: true,
          createdAt: new Date("2026-01-02T00:00:00Z"),
        },
      });
      const claimable = await prisma.message.create({
        data: {
          threadId,
          role: "user",
          body: "claimable",
          createdAt: new Date("2026-01-03T00:00:00Z"),
        },
      });

      const claimed = await service.claim(threadId, "worker-1");
      expect(claimed?.id).toBe(claimable.id);
    });

    it("returns null when no unclaimed user message exists", async () => {
      const threadId = await createThread(prisma);
      await prisma.message.create({
        data: { threadId, role: "assistant", body: "assistant only" },
      });

      const claimed = await service.claim(threadId, "worker-1");
      expect(claimed).toBeNull();
    });

    it("a second claim() call returns the next-oldest remaining unclaimed message", async () => {
      const threadId = await createThread(prisma);

      const first = await prisma.message.create({
        data: {
          threadId,
          role: "user",
          body: "first",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      });
      const second = await prisma.message.create({
        data: {
          threadId,
          role: "user",
          body: "second",
          createdAt: new Date("2026-01-02T00:00:00Z"),
        },
      });

      const claimedFirst = await service.claim(threadId, "worker-1");
      expect(claimedFirst?.id).toBe(first.id);

      const claimedSecond = await service.claim(threadId, "worker-2");
      expect(claimedSecond?.id).toBe(second.id);
    });
  });

  // ─── reply() ────────────────────────────────────────────────────────────────

  describe("reply()", () => {
    it("creates an assistant message and sets repliedAt on the user message", async () => {
      const threadId = await createThread(prisma);
      const clock = FixedClock(new Date("2026-04-01T09:30:00Z"));
      const svc = new MessageService(prisma, clock);

      const userMessage = await prisma.message.create({
        data: { threadId, role: "user", body: "question" },
      });

      const result = await svc.reply(userMessage.id, {
        body: "answer",
        tokens: { output: 5 },
        costUsd: 0.002,
      });

      expect(result).not.toBeNull();
      expect(result?.userMessage.id).toBe(userMessage.id);
      expect(result?.userMessage.repliedAt).toEqual(new Date("2026-04-01T09:30:00Z"));
      expect(result?.assistantMessage.role).toBe("assistant");
      expect(result?.assistantMessage.body).toBe("answer");
      expect(result?.assistantMessage.threadId).toBe(threadId);
      expect(result?.assistantMessage.tokens).toEqual({ output: 5 });
      expect(result?.assistantMessage.costUsd).toBeCloseTo(0.002);
    });

    it("returns null for a nonexistent messageId", async () => {
      const result = await service.reply("nonexistent-id", { body: "answer" });
      expect(result).toBeNull();
    });

    it("returns null if the user message's repliedAt is already set (no double-reply)", async () => {
      const threadId = await createThread(prisma);
      const userMessage = await prisma.message.create({
        data: {
          threadId,
          role: "user",
          body: "already replied",
          repliedAt: new Date("2026-01-01T00:00:00Z"),
        },
      });

      const result = await service.reply(userMessage.id, { body: "second answer" });
      expect(result).toBeNull();
    });
  });
});
