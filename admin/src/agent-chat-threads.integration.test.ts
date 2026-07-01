/**
 * admin/src/agent-chat-threads.integration.test.ts
 * Integration tests for Thread and Message models against a real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    // TEST_DB is guaranteed set — the describe block is skipped otherwise.
    datasources: { db: { url: TEST_DB as string } },
  });
}

async function createAgent(
  prisma: PrismaClient,
  name = "Test Agent",
): Promise<string> {
  const agent = await prisma.agent.create({ data: { name } });
  return agent.id;
}

describeOrSkip("Thread + Message models (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    // Clean up in dependency order
    await prisma.message.deleteMany();
    await prisma.thread.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agentChatTokenUsageDaily.deleteMany();
    await prisma.agent.deleteMany();
  });

  // ─── Thread CRUD ────────────────────────────────────────────────────────────

  it("creates a Thread linked to an Agent", async () => {
    const agentId = await createAgent(prisma);
    const thread = await prisma.thread.create({
      data: {
        agentId,
        memberId: "alice@example.com",
        title: "First thread",
      },
    });
    expect(thread.id).toBeTruthy();
    expect(thread.agentId).toBe(agentId);
    expect(thread.memberId).toBe("alice@example.com");
    expect(thread.title).toBe("First thread");
    expect(thread.createdAt).toBeInstanceOf(Date);
    expect(thread.updatedAt).toBeInstanceOf(Date);
  });

  it("reads a Thread by id", async () => {
    const agentId = await createAgent(prisma);
    const created = await prisma.thread.create({
      data: { agentId, memberId: "alice@example.com", title: "Hello" },
    });
    const found = await prisma.thread.findUnique({ where: { id: created.id } });
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
  });

  it("updates a Thread title", async () => {
    const agentId = await createAgent(prisma);
    const thread = await prisma.thread.create({
      data: { agentId, memberId: "alice@example.com", title: "Old title" },
    });
    const updated = await prisma.thread.update({
      where: { id: thread.id },
      data: { title: "New title" },
    });
    expect(updated.title).toBe("New title");
  });

  // ─── Message CRUD ───────────────────────────────────────────────────────────

  it("creates Messages linked to a Thread", async () => {
    const agentId = await createAgent(prisma);
    const thread = await prisma.thread.create({
      data: { agentId, memberId: "alice@example.com", title: "Chat" },
    });
    const userMsg = await prisma.message.create({
      data: {
        threadId: thread.id,
        role: "user",
        body: "Hello!",
      },
    });
    const assistantMsg = await prisma.message.create({
      data: {
        threadId: thread.id,
        role: "assistant",
        body: "Hi there!",
        tokens: JSON.stringify({ inputTokens: 10, outputTokens: 20 }),
      },
    });
    expect(userMsg.threadId).toBe(thread.id);
    expect(userMsg.role).toBe("user");
    expect(userMsg.body).toBe("Hello!");
    expect(userMsg.tokens).toBeNull();
    expect(userMsg.attachmentFilename).toBeNull();
    expect(userMsg.attachmentSize).toBeNull();

    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.tokens).toBe(
      JSON.stringify({ inputTokens: 10, outputTokens: 20 }),
    );
  });

  it("creates a Message with attachment fields", async () => {
    const agentId = await createAgent(prisma);
    const thread = await prisma.thread.create({
      data: { agentId, memberId: "alice@example.com", title: "Attachments" },
    });
    const msg = await prisma.message.create({
      data: {
        threadId: thread.id,
        role: "user",
        body: "See attached",
        attachmentFilename: "report.pdf",
        attachmentSize: 204800,
      },
    });
    expect(msg.attachmentFilename).toBe("report.pdf");
    expect(msg.attachmentSize).toBe(204800);
  });

  // ─── Member scoping ─────────────────────────────────────────────────────────

  it("filters threads by memberId", async () => {
    const agentId = await createAgent(prisma);
    await prisma.thread.create({
      data: { agentId, memberId: "alice@example.com", title: "Alice thread" },
    });
    await prisma.thread.create({
      data: { agentId, memberId: "bob@example.com", title: "Bob thread" },
    });
    await prisma.thread.create({
      data: { agentId, memberId: "alice@example.com", title: "Alice thread 2" },
    });

    const aliceThreads = await prisma.thread.findMany({
      where: { agentId, memberId: "alice@example.com" },
    });
    expect(aliceThreads).toHaveLength(2);
    expect(aliceThreads.every((t) => t.memberId === "alice@example.com")).toBe(
      true,
    );

    const bobThreads = await prisma.thread.findMany({
      where: { agentId, memberId: "bob@example.com" },
    });
    expect(bobThreads).toHaveLength(1);
  });

  // ─── Ordering by updatedAt DESC ─────────────────────────────────────────────

  it("orders threads by updatedAt DESC", async () => {
    const agentId = await createAgent(prisma);
    const memberId = "alice@example.com";

    const t1 = await prisma.thread.create({
      data: { agentId, memberId, title: "First" },
    });
    // Small delay to ensure distinct updatedAt
    await new Promise((r) => setTimeout(r, 10));
    const t2 = await prisma.thread.create({
      data: { agentId, memberId, title: "Second" },
    });
    await new Promise((r) => setTimeout(r, 10));
    // Touch t1 to make it the most recent
    await prisma.thread.update({
      where: { id: t1.id },
      data: { title: "First (updated)" },
    });

    const threads = await prisma.thread.findMany({
      where: { agentId, memberId },
      orderBy: { updatedAt: "desc" },
    });
    expect(threads[0].id).toBe(t1.id);
    expect(threads[1].id).toBe(t2.id);
  });

  // ─── Cascade: Agent → Threads → Messages ────────────────────────────────────

  it("cascades delete from Agent to Threads and Messages", async () => {
    const agentId = await createAgent(prisma);
    const thread = await prisma.thread.create({
      data: { agentId, memberId: "alice@example.com", title: "Cascade test" },
    });
    await prisma.message.create({
      data: { threadId: thread.id, role: "user", body: "Should be deleted" },
    });

    // Delete the agent — should cascade to Thread and then Message
    await prisma.agent.delete({ where: { id: agentId } });

    const threads = await prisma.thread.findMany({ where: { agentId } });
    expect(threads).toHaveLength(0);

    const messages = await prisma.message.findMany({
      where: { threadId: thread.id },
    });
    expect(messages).toHaveLength(0);
  });

  // ─── Cascade: Thread → Messages ─────────────────────────────────────────────

  it("cascades delete from Thread to Messages", async () => {
    const agentId = await createAgent(prisma);
    const thread = await prisma.thread.create({
      data: { agentId, memberId: "alice@example.com", title: "Thread cascade" },
    });
    await prisma.message.create({
      data: { threadId: thread.id, role: "user", body: "Msg 1" },
    });
    await prisma.message.create({
      data: { threadId: thread.id, role: "assistant", body: "Msg 2" },
    });

    await prisma.thread.delete({ where: { id: thread.id } });

    const messages = await prisma.message.findMany({
      where: { threadId: thread.id },
    });
    expect(messages).toHaveLength(0);
  });
});
