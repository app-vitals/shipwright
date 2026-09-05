/**
 * admin/src/agent-work-queue.integration.test.ts
 * Integration tests for AgentWorkQueueService — push/get.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { AgentWorkQueueService } from "./agent-work-queue.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
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

describeOrSkip("AgentWorkQueueService (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentWorkQueueService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentWorkQueueSnapshot.deleteMany();
    await prisma.agentChatTokenUsageDailyByModel.deleteMany();
    await prisma.agentCronRun.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agent.deleteMany();
    service = new AgentWorkQueueService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  // ─── push(): happy-path snapshot-write ──────────────────────────────────────

  it("push() creates a snapshot and get() reads it back", async () => {
    const agentId = await createAgent(prisma);
    const computedAt = new Date("2026-01-15T12:00:00.000Z");
    const items = [
      { id: "task-1", title: "Fix flaky test", score: 0.9 },
      { id: "task-2", title: "Add coverage", score: 0.5 },
    ];

    const written = await service.push(agentId, { computedAt, items });

    expect(written.agentId).toBe(agentId);
    expect(written.computedAt).toEqual(computedAt);
    expect(written.items).toEqual(items);
    expect(written.id).toBeTruthy();
    expect(written.createdAt).toBeInstanceOf(Date);

    const read = await service.get(agentId);

    expect(read).not.toBeNull();
    expect(read?.id).toBe(written.id);
    expect(read?.agentId).toBe(agentId);
    expect(read?.computedAt).toEqual(computedAt);
    expect(read?.items).toEqual(items);
  });

  // ─── get(): no-snapshot-yet-read ────────────────────────────────────────────

  it("get() returns null for an agent that has never pushed a snapshot", async () => {
    const agentId = await createAgent(prisma);

    const read = await service.get(agentId);

    expect(read).toBeNull();
  });

  // ─── push(): overwrite behavior ─────────────────────────────────────────────

  it("push() overwrites the prior snapshot instead of creating a second row", async () => {
    const agentId = await createAgent(prisma);

    const first = await service.push(agentId, {
      computedAt: new Date("2026-01-15T12:00:00.000Z"),
      items: [{ id: "task-1", title: "First pass", score: 0.9 }],
    });

    const second = await service.push(agentId, {
      computedAt: new Date("2026-01-16T09:30:00.000Z"),
      items: [{ id: "task-2", title: "Second pass", score: 0.7 }],
    });

    expect(second.id).toBe(first.id);
    expect(second.items).toEqual([
      { id: "task-2", title: "Second pass", score: 0.7 },
    ]);

    const read = await service.get(agentId);
    expect(read?.id).toBe(first.id);
    expect(read?.items).toEqual([
      { id: "task-2", title: "Second pass", score: 0.7 },
    ]);

    const count = await prisma.agentWorkQueueSnapshot.count({
      where: { agentId },
    });
    expect(count).toBe(1);
  });

  // ─── getMany(): batch-fetch snapshots ──────────────────────────────────────

  it("getMany() returns snapshots for all agents that have pushed one", async () => {
    // Create 3 agents: 2 with snapshots, 1 without
    const agent1Id = await createAgent(prisma, "Agent 1");
    const agent2Id = await createAgent(prisma, "Agent 2");
    const agent3Id = await createAgent(prisma, "Agent 3 (no snapshot)");

    const snapshot1 = await service.push(agent1Id, {
      computedAt: new Date("2026-01-15T12:00:00.000Z"),
      items: [{ id: "task-1", title: "Task for agent 1", score: 0.9 }],
    });

    const snapshot2 = await service.push(agent2Id, {
      computedAt: new Date("2026-01-15T13:00:00.000Z"),
      items: [{ id: "task-2", title: "Task for agent 2", score: 0.8 }],
    });

    // agent3Id has no snapshot pushed

    // Request all three agents; should return exactly the two that have snapshots
    const results = await service.getMany([agent1Id, agent2Id, agent3Id]);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.agentId).sort()).toEqual(
      [agent1Id, agent2Id].sort(),
    );

    // Verify the content matches what was pushed
    const result1 = results.find((r) => r.agentId === agent1Id);
    expect(result1?.id).toBe(snapshot1.id);
    expect(result1?.items).toEqual([
      { id: "task-1", title: "Task for agent 1", score: 0.9 },
    ]);

    const result2 = results.find((r) => r.agentId === agent2Id);
    expect(result2?.id).toBe(snapshot2.id);
    expect(result2?.items).toEqual([
      { id: "task-2", title: "Task for agent 2", score: 0.8 },
    ]);
  });

  it("getMany() returns empty array when no agents have snapshots", async () => {
    const agent1Id = await createAgent(prisma, "Agent 1");
    const agent2Id = await createAgent(prisma, "Agent 2");

    // No snapshots pushed for either agent

    const results = await service.getMany([agent1Id, agent2Id]);

    expect(results).toEqual([]);
  });

  it("getMany() with empty agent IDs array returns empty array", async () => {
    const results = await service.getMany([]);

    expect(results).toEqual([]);
  });

  it("getMany() omits agents with no snapshot and includes only those that have one", async () => {
    const agentWithSnapshotId = await createAgent(prisma, "Agent with snapshot");
    const agentWithoutSnapshotId = await createAgent(
      prisma,
      "Agent without snapshot",
    );
    const nonExistentAgentId = "nonexistent-agent-id";

    await service.push(agentWithSnapshotId, {
      computedAt: new Date("2026-01-15T12:00:00.000Z"),
      items: [{ id: "task", title: "Some task", score: 0.5 }],
    });

    // Request mix of agent with snapshot, agent without snapshot, and non-existent
    const results = await service.getMany([
      agentWithSnapshotId,
      agentWithoutSnapshotId,
      nonExistentAgentId,
    ]);

    // Should return only the one agent with a snapshot
    expect(results).toHaveLength(1);
    expect(results[0]?.agentId).toBe(agentWithSnapshotId);
  });
});
