/**
 * task-store/src/tasks.integration.test.ts
 *
 * Integration tests for the task-store Prisma schema against a real Postgres DB.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { TaskService } from "./task-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    // TEST_DB is guaranteed set — the describe block is skipped otherwise.
    datasources: { db: { url: TEST_DB as string } },
  });
}

describeOrSkip("Task store schema (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.taskToken.deleteMany();
    await prisma.task.deleteMany();
  });

  // ─── Task round-trip ──────────────────────────────────────────────────────────

  it("creates a Task row and reads back all columns", async () => {
    const testMetadata = { key: "value", nested: { field: 123 } };
    const created = await prisma.task.create({
      data: {
        title: "Scaffold the task store",
        status: "pending",
        source: "plan-session",
        session: "TSS-1",
        repo: "shipwright",
        description: "Build the package",
        acceptanceCriteria: ["AC1", "AC2", "AC3"],
        layer: "Database",
        branch: "feat/tss-1-1",
        dependencies: ["TSS-0", "TSS-0b"],
        pr: 42,
        hours: 3.5,
        addedAt: "2026-06-22T10:00:00.000Z",
        startedAt: "2026-06-22T11:00:00.000Z",
        prCreatedAt: "2026-06-22T12:00:00.000Z",
        mergedAt: "2026-06-22T13:00:00.000Z",
        blockedAt: "2026-06-22T13:30:00.000Z",
        blockedReason: "waiting on review",
        note: "first scaffold",
        type: "feature",
        priority: "high",
        cancelledAt: "2026-06-22T14:00:00.000Z",
        completedAt: "2026-06-22T15:00:00.000Z",
        deployingAt: "2026-06-22T15:30:00.000Z",
        deployedAt: "2026-06-22T15:45:00.000Z",
        ciFixAttempts: 2,
        mergeCommit: "abc123",
        prUrl: "https://github.com/org/repo/pull/42",
        assignee: "dmcaulay",
        issue: "https://github.com/org/repo/issues/7",
        model: "sonnet",
        complexity: 3,
        hitl: false,
        hitlNotifiedAt: "2026-06-22T16:00:00.000Z",
        claimedBy: "agent-alpha",
        agentHint: "agent-beta",
        claimedAt: "2026-06-22T16:30:00.000Z",
        heartbeatAt: "2026-06-22T16:45:00.000Z",
        // Execution data columns
        simplifyTotal: 15,
        simplifyDry: 3,
        simplifyDeadCode: 2,
        simplifyNaming: 4,
        simplifyComplexity: 3,
        simplifyConsistency: 3,
        coverageDelta: 2.5,
        effortLevel: "medium",
        inputTokens: 50000,
        outputTokens: 25000,
        cacheReadTokens: 10000,
        cacheCreationTokens: 5000,
        costUsd: 1.25,
        metadata: testMetadata,
      },
    });

    const read = await prisma.task.findUnique({ where: { id: created.id } });
    expect(read).not.toBeNull();
    if (!read) return;

    expect(read.title).toBe("Scaffold the task store");
    expect(read.status).toBe("pending");
    expect(read.source).toBe("plan-session");
    expect(read.session).toBe("TSS-1");
    expect(read.repo).toBe("shipwright");
    expect(read.description).toBe("Build the package");
    expect(read.acceptanceCriteria).toEqual(["AC1", "AC2", "AC3"]);
    expect(read.layer).toBe("Database");
    expect(read.branch).toBe("feat/tss-1-1");
    expect(read.dependencies).toEqual(["TSS-0", "TSS-0b"]);
    expect(read.pr).toBe(42);
    expect(read.hours).toBe(3.5);
    expect(read.addedAt).toBe("2026-06-22T10:00:00.000Z");
    expect(read.startedAt).toBe("2026-06-22T11:00:00.000Z");
    expect(read.prCreatedAt).toBe("2026-06-22T12:00:00.000Z");
    expect(read.mergedAt).toBe("2026-06-22T13:00:00.000Z");
    expect(read.blockedAt).toBe("2026-06-22T13:30:00.000Z");
    expect(read.blockedReason).toBe("waiting on review");
    expect(read.note).toBe("first scaffold");
    expect(read.type).toBe("feature");
    expect(read.priority).toBe("high");
    expect(read.cancelledAt).toBe("2026-06-22T14:00:00.000Z");
    expect(read.completedAt).toBe("2026-06-22T15:00:00.000Z");
    expect(read.deployingAt).toBe("2026-06-22T15:30:00.000Z");
    expect(read.deployedAt).toBe("2026-06-22T15:45:00.000Z");
    expect(read.ciFixAttempts).toBe(2);
    expect(read.mergeCommit).toBe("abc123");
    expect(read.prUrl).toBe("https://github.com/org/repo/pull/42");
    expect(read.assignee).toBe("dmcaulay");
    expect(read.issue).toBe("https://github.com/org/repo/issues/7");
    expect(read.model).toBe("sonnet");
    expect(read.complexity).toBe(3);
    expect(read.hitl).toBe(false);
    expect(read.hitlNotifiedAt).toBe("2026-06-22T16:00:00.000Z");

    // New claim/liveness fields
    expect(read.claimedBy).toBe("agent-alpha");
    expect(read.agentHint).toBe("agent-beta");
    expect(read.claimedAt).toBe("2026-06-22T16:30:00.000Z");
    expect(read.heartbeatAt).toBe("2026-06-22T16:45:00.000Z");

    // Execution data columns
    expect(read.simplifyTotal).toBe(15);
    expect(read.simplifyDry).toBe(3);
    expect(read.simplifyDeadCode).toBe(2);
    expect(read.simplifyNaming).toBe(4);
    expect(read.simplifyComplexity).toBe(3);
    expect(read.simplifyConsistency).toBe(3);
    expect(read.coverageDelta).toBe(2.5);
    expect(read.effortLevel).toBe("medium");
    expect(read.inputTokens).toBe(50000);
    expect(read.outputTokens).toBe(25000);
    expect(read.cacheReadTokens).toBe(10000);
    expect(read.cacheCreationTokens).toBe(5000);
    expect(read.costUsd).toBe(1.25);
    expect(read.metadata).toEqual(testMetadata);

    // System-managed timestamps
    expect(read.createdAt).toBeInstanceOf(Date);
    expect(read.updatedAt).toBeInstanceOf(Date);
  });

  it("defaults optional fields to null/empty and applies all status values", async () => {
    const minimal = await prisma.task.create({
      data: { title: "Minimal", status: "in_progress" },
    });
    const read = await prisma.task.findUnique({ where: { id: minimal.id } });
    expect(read?.status).toBe("in_progress");
    expect(read?.source).toBeNull();
    expect(read?.acceptanceCriteria).toEqual([]);
    expect(read?.dependencies).toEqual([]);
    expect(read?.claimedBy).toBeNull();

    // Exercise the full status enum set.
    const statuses = [
      "pending",
      "in_progress",
      "pr_open",
      "approved",
      "merged",
      "done",
      "deploying",
      "deployed",
      "blocked",
      "cancelled",
    ] as const;
    for (const status of statuses) {
      const t = await prisma.task.create({ data: { title: status, status } });
      expect(t.status).toBe(status);
    }
  });

  // ─── TaskToken round-trip ─────────────────────────────────────────────────────

  it("creates a TaskToken row and reads back the hash + label", async () => {
    const created = await prisma.taskToken.create({
      data: {
        token: "a".repeat(64), // SHA-256 hex hash placeholder
        label: "ci-runner",
      },
    });

    const read = await prisma.taskToken.findUnique({
      where: { id: created.id },
    });
    expect(read).not.toBeNull();
    expect(read?.token).toBe("a".repeat(64));
    expect(read?.label).toBe("ci-runner");
    expect(read?.revokedAt).toBeNull();
    expect(read?.createdAt).toBeInstanceOf(Date);
  });

  it("enforces the unique constraint on TaskToken.token", async () => {
    const hash = "b".repeat(64);
    await prisma.taskToken.create({ data: { token: hash } });
    let threw = false;
    try {
      await prisma.taskToken.create({ data: { token: hash } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  // ─── TaskService.list() agentScope OR-query ────────────────────────────────

  it("list() with agentScope returns correct OR union: assigned tasks + pool tasks in repos", async () => {
    const taskService = new TaskService(prisma);

    // Task explicitly assigned to agent-1
    await prisma.task.create({
      data: {
        title: "Assigned to agent-1",
        status: "pending",
        assignee: "agent-1",
        repo: "app-vitals/other-repo",
      },
    });

    // Unassigned pool task in agent-1's scope
    await prisma.task.create({
      data: {
        title: "Pool task in scope",
        status: "pending",
        assignee: null,
        repo: "acme-inc/backend-api",
      },
    });

    // Unassigned pool task NOT in agent-1's scope
    await prisma.task.create({
      data: {
        title: "Pool task out of scope",
        status: "pending",
        assignee: null,
        repo: "app-vitals/shipwright",
      },
    });

    // Task assigned to a different agent
    await prisma.task.create({
      data: {
        title: "Assigned to agent-2",
        status: "pending",
        assignee: "agent-2",
        repo: "acme-inc/backend-api",
      },
    });

    const result = await taskService.list({
      agentScope: { agentId: "agent-1", repos: ["acme-inc/backend-api"] },
    });

    const titles = result.tasks.map((t) => t.title).sort();

    // Should include: explicitly assigned + pool task in scope
    expect(titles).toContain("Assigned to agent-1");
    expect(titles).toContain("Pool task in scope");

    // Should NOT include: pool task out of scope OR assigned to agent-2
    expect(titles).not.toContain("Pool task out of scope");
    expect(titles).not.toContain("Assigned to agent-2");

    expect(result.total).toBe(2);
  });

  it("list() with agentScope AND repo filter applies repo as additional AND condition", async () => {
    const taskService = new TaskService(prisma);

    // Assigned task in the filtered repo
    await prisma.task.create({
      data: {
        title: "Assigned in target repo",
        status: "pending",
        assignee: "agent-1",
        repo: "acme-inc/backend-api",
      },
    });

    // Assigned task in a different repo
    await prisma.task.create({
      data: {
        title: "Assigned in other repo",
        status: "pending",
        assignee: "agent-1",
        repo: "app-vitals/other-repo",
      },
    });

    // Pool task in the filtered repo
    await prisma.task.create({
      data: {
        title: "Pool task in target repo",
        status: "pending",
        assignee: null,
        repo: "acme-inc/backend-api",
      },
    });

    const result = await taskService.list({
      agentScope: { agentId: "agent-1", repos: ["acme-inc/backend-api"] },
      repo: "acme-inc/backend-api",
    });

    const titles = result.tasks.map((t) => t.title).sort();

    expect(titles).toContain("Assigned in target repo");
    expect(titles).toContain("Pool task in target repo");
    expect(titles).not.toContain("Assigned in other repo");
    expect(result.total).toBe(2);
  });
});
