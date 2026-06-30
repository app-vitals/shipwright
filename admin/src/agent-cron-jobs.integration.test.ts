/**
 * agent/src/agent-cron-jobs.integration.test.ts
 * Integration tests for AgentCronJobService against a real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { NotFoundError, UnprocessableEntityError } from "./errors.ts";

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

describeOrSkip("AgentCronJobService (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentCronJobService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    service = new AgentCronJobService(prisma);
  });

  // ─── create ─────────────────────────────────────────────────────────────────

  it("create() creates a cron job with channel target", async () => {
    const agentId = await createAgent(prisma);
    const job = await service.create(agentId, {
      schedule: "0 9 * * *",
      prompt: "Good morning",
      channel: "C123456",
    });
    expect(job.agentId).toBe(agentId);
    expect(job.schedule).toBe("0 9 * * *");
    expect(job.channel).toBe("C123456");
    expect(job.user).toBeNull();
    expect(job.silent).toBe(false);
    expect(job.enabled).toBe(true);
  });

  it("create() creates a cron job with user target", async () => {
    const agentId = await createAgent(prisma);
    const job = await service.create(agentId, {
      schedule: "*/5 * * * *",
      prompt: "Check status",
      user: "U123456",
    });
    expect(job.user).toBe("U123456");
    expect(job.channel).toBeNull();
  });

  it("create() creates a silent cron job with no channel/user", async () => {
    const agentId = await createAgent(prisma);
    const job = await service.create(agentId, {
      schedule: "0 * * * *",
      prompt: "Silent task",
      silent: true,
    });
    expect(job.silent).toBe(true);
    expect(job.channel).toBeNull();
    expect(job.user).toBeNull();
  });

  it("create() throws UnprocessableEntityError for invalid cron expression", async () => {
    const agentId = await createAgent(prisma);
    await expect(
      service.create(agentId, {
        schedule: "not-a-cron",
        prompt: "Bad cron",
        channel: "C123",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
  });

  it("create() throws UnprocessableEntityError when both channel and user are set", async () => {
    const agentId = await createAgent(prisma);
    await expect(
      service.create(agentId, {
        schedule: "0 9 * * *",
        prompt: "Ambiguous target",
        channel: "C123456",
        user: "U123456",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
  });

  it("create() throws UnprocessableEntityError when neither channel nor user set and not silent", async () => {
    const agentId = await createAgent(prisma);
    await expect(
      service.create(agentId, {
        schedule: "0 9 * * *",
        prompt: "No target",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
  });

  // ─── list / get ─────────────────────────────────────────────────────────────

  it("list() returns all cron jobs for an agent", async () => {
    const agentId = await createAgent(prisma);
    await service.create(agentId, {
      schedule: "0 9 * * *",
      prompt: "Job 1",
      channel: "C1",
    });
    await service.create(agentId, {
      schedule: "0 10 * * *",
      prompt: "Job 2",
      channel: "C2",
    });
    const jobs = await service.list(agentId);
    expect(jobs).toHaveLength(2);
  });

  it("get() returns a specific cron job", async () => {
    const agentId = await createAgent(prisma);
    const created = await service.create(agentId, {
      schedule: "0 9 * * *",
      prompt: "Specific",
      channel: "C1",
    });
    const fetched = await service.get(agentId, created.id);
    expect(fetched.id).toBe(created.id);
  });

  it("get() throws NotFoundError for unknown cronId", async () => {
    const agentId = await createAgent(prisma);
    await expect(service.get(agentId, "nonexistent")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("get() throws NotFoundError when cronId belongs to a different agent", async () => {
    const agentId1 = await createAgent(prisma, "Agent 1");
    const agentId2 = await createAgent(prisma, "Agent 2");
    const job = await service.create(agentId1, {
      schedule: "0 9 * * *",
      prompt: "Owned by agent1",
      channel: "C1",
    });
    await expect(service.get(agentId2, job.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  // ─── listEnabled ────────────────────────────────────────────────────────────

  it("listEnabled() returns only enabled jobs across all agents", async () => {
    const agentId = await createAgent(prisma);
    await service.create(agentId, {
      schedule: "0 9 * * *",
      prompt: "Enabled",
      channel: "C1",
      enabled: true,
    });
    await service.create(agentId, {
      schedule: "0 10 * * *",
      prompt: "Disabled",
      channel: "C2",
      enabled: false,
    });
    const enabled = await service.listEnabled();
    expect(enabled.every((j) => j.enabled)).toBe(true);
    expect(enabled).toHaveLength(1);
  });

  // ─── update ─────────────────────────────────────────────────────────────────

  it("update() changes schedule and prompt", async () => {
    const agentId = await createAgent(prisma);
    const job = await service.create(agentId, {
      schedule: "0 9 * * *",
      prompt: "Original",
      channel: "C1",
    });
    const updated = await service.update(agentId, job.id, {
      schedule: "0 10 * * *",
      prompt: "Updated",
      channel: "C1",
    });
    expect(updated.schedule).toBe("0 10 * * *");
    expect(updated.prompt).toBe("Updated");
  });

  it("update() throws UnprocessableEntityError when both channel and user are set", async () => {
    const agentId = await createAgent(prisma);
    const job = await service.create(agentId, {
      schedule: "0 9 * * *",
      prompt: "Original",
      channel: "C1",
    });
    await expect(
      service.update(agentId, job.id, {
        schedule: "0 9 * * *",
        prompt: "Updated",
        channel: "C1",
        user: "U1",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
  });

  it("update() throws UnprocessableEntityError for invalid cron expression", async () => {
    const agentId = await createAgent(prisma);
    const job = await service.create(agentId, {
      schedule: "0 9 * * *",
      prompt: "Original",
      channel: "C1",
    });
    await expect(
      service.update(agentId, job.id, {
        schedule: "bad",
        prompt: "Updated",
        channel: "C1",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
  });

  // ─── delete ─────────────────────────────────────────────────────────────────

  it("delete() removes the cron job", async () => {
    const agentId = await createAgent(prisma);
    const job = await service.create(agentId, {
      schedule: "0 9 * * *",
      prompt: "Delete me",
      channel: "C1",
    });
    await service.delete(agentId, job.id);
    const jobs = await service.list(agentId);
    expect(jobs).toHaveLength(0);
  });

  it("delete() throws NotFoundError for unknown cronId", async () => {
    const agentId = await createAgent(prisma);
    await expect(service.delete(agentId, "nonexistent")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  // ─── setEnabled ─────────────────────────────────────────────────────────────

  it("setEnabled() toggles a cron job", async () => {
    const agentId = await createAgent(prisma);
    const job = await service.create(agentId, {
      schedule: "0 9 * * *",
      prompt: "Toggle",
      channel: "C1",
      enabled: true,
    });
    const disabled = await service.setEnabled(agentId, job.id, false);
    expect(disabled.enabled).toBe(false);
    const reenabled = await service.setEnabled(agentId, job.id, true);
    expect(reenabled.enabled).toBe(true);
  });

  // ─── reconcileSystemCrons ───────────────────────────────────────────────────

  it("reconcileSystemCrons() creates system crons for a new agent", async () => {
    const agentId = await createAgent(prisma);
    const result = await service.reconcileSystemCrons(agentId);
    expect(result.created).toBeGreaterThan(0);
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);

    const jobs = await service.list(agentId);
    const systemJobs = jobs.filter((j) => j.system);
    expect(systemJobs.length).toBe(result.created);
  });

  it("reconcileSystemCrons() updates existing system crons", async () => {
    const agentId = await createAgent(prisma);
    // First reconcile seeds all system crons
    await service.reconcileSystemCrons(agentId);
    // Second reconcile should update them (not create new ones)
    const result = await service.reconcileSystemCrons(agentId);
    expect(result.updated).toBeGreaterThan(0);
    expect(result.created).toBe(0);
  });
});
