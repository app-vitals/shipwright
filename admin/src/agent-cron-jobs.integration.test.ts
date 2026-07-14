/**
 * agent/src/agent-cron-jobs.integration.test.ts
 * Integration tests for AgentCronJobService against a real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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

  afterEach(async () => {
    await prisma.$disconnect();
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

  it("reconcileSystemCrons() preserves cron id and AgentCronRun history across a reconcile", async () => {
    const agentId = await createAgent(prisma);
    // First reconcile seeds all system crons
    await service.reconcileSystemCrons(agentId);

    const jobs = await service.list(agentId);
    const target = jobs.find((j) => j.system && j.name);
    if (!target) {
      throw new Error("expected at least one system cron to be seeded");
    }
    const originalId = target.id;

    // Record a run against this cron, as the runtime does after executing it.
    const run = await prisma.agentCronRun.create({
      data: {
        cronId: originalId,
        agentId,
        startedAt: new Date(),
        completedAt: new Date(),
        skipped: false,
        outcome: "success",
      },
    });

    // Reconciling again (e.g. on agent restart) must not wipe history: it
    // should update the existing row in place rather than delete+recreate it.
    const result = await service.reconcileSystemCrons(agentId);
    expect(result.updated).toBeGreaterThan(0);
    expect(result.created).toBe(0);

    const jobsAfter = await service.list(agentId);
    const targetAfter = jobsAfter.find((j) => j.name === target.name);
    expect(targetAfter).toBeDefined();
    expect(targetAfter?.id).toBe(originalId);

    const survivingRun = await prisma.agentCronRun.findUnique({
      where: { id: run.id },
    });
    expect(survivingRun).not.toBeNull();
    expect(survivingRun?.cronId).toBe(originalId);
  });

  // ─── reconcileSystemCrons: shipwright-loop supersedes legacy phase crons ────

  const LEGACY_PHASE_CRON_NAMES = [
    "shipwright-dev-task",
    "shipwright-patch",
    "shipwright-review-patch",
    "shipwright-review",
    "shipwright-deploy",
  ];

  async function enableCronByName(
    agentId: string,
    name: string,
  ): Promise<void> {
    const jobs = await service.list(agentId);
    const target = jobs.find((j) => j.name === name);
    if (!target) throw new Error(`expected system cron "${name}" to exist`);
    await service.setEnabled(agentId, target.id, true);
  }

  it("reconcileSystemCrons() forces legacy phase crons off once shipwright-loop is enabled (update branch)", async () => {
    const agentId = await createAgent(prisma);
    await service.reconcileSystemCrons(agentId);

    // shipwright-dev-task defaults to enabled:true — force it off despite
    // never touching it directly, proving the override runs unconditionally.
    // shipwright-patch defaults to enabled:false — enable it by hand so the
    // override also has to flip an explicitly-set true back to false.
    await enableCronByName(agentId, "shipwright-loop");
    await enableCronByName(agentId, "shipwright-patch");

    await service.reconcileSystemCrons(agentId);

    const jobs = await service.list(agentId);
    for (const name of LEGACY_PHASE_CRON_NAMES) {
      const cron = jobs.find((j) => j.name === name);
      expect(cron?.enabled).toBe(false);
    }
  });

  it("reconcileSystemCrons() leaves legacy phase crons' enabled state untouched when shipwright-loop is disabled", async () => {
    const agentId = await createAgent(prisma);
    await service.reconcileSystemCrons(agentId);

    // shipwright-loop stays at its default (disabled) — manually enabling a
    // legacy cron here must survive the reconcile unchanged.
    await enableCronByName(agentId, "shipwright-patch");

    await service.reconcileSystemCrons(agentId);

    const jobs = await service.list(agentId);
    const patchCron = jobs.find((j) => j.name === "shipwright-patch");
    expect(patchCron?.enabled).toBe(true);
  });

  it("reconcileSystemCrons() does not force off system crons outside the legacy phase list", async () => {
    const agentId = await createAgent(prisma);
    await service.reconcileSystemCrons(agentId);

    await enableCronByName(agentId, "shipwright-loop");
    await enableCronByName(agentId, "shipwright-test-readiness");

    await service.reconcileSystemCrons(agentId);

    const jobs = await service.list(agentId);
    const unrelated = jobs.find((j) => j.name === "shipwright-test-readiness");
    expect(unrelated?.enabled).toBe(true);
  });

  it("reconcileSystemCrons() creates a legacy phase cron as disabled when shipwright-loop is already enabled (create branch)", async () => {
    const agentId = await createAgent(prisma);
    await service.reconcileSystemCrons(agentId);
    await enableCronByName(agentId, "shipwright-loop");

    // Simulate a legacy cron that doesn't exist yet for this agent (e.g. it
    // was deleted) so the next reconcile exercises the create path rather
    // than the update path. shipwright-dev-task's own SYSTEM_CRONS default
    // is enabled:true, so this only passes if the override applies at
    // creation time too, not just when updating an existing row.
    await prisma.agentCronJob.deleteMany({
      where: { agentId, name: "shipwright-dev-task" },
    });

    const result = await service.reconcileSystemCrons(agentId);
    expect(result.created).toBe(1);

    const jobs = await service.list(agentId);
    const devTaskCron = jobs.find((j) => j.name === "shipwright-dev-task");
    expect(devTaskCron?.enabled).toBe(false);
  });

  it("reconcileSystemCrons() is idempotent when re-run with shipwright-loop enabled", async () => {
    const agentId = await createAgent(prisma);
    await service.reconcileSystemCrons(agentId);
    await enableCronByName(agentId, "shipwright-loop");

    const first = await service.reconcileSystemCrons(agentId);
    const stateAfterFirst = (await service.list(agentId))
      .filter((j) => j.name)
      .map((j) => ({ name: j.name, enabled: j.enabled }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

    const second = await service.reconcileSystemCrons(agentId);
    const stateAfterSecond = (await service.list(agentId))
      .filter((j) => j.name)
      .map((j) => ({ name: j.name, enabled: j.enabled }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

    expect(stateAfterSecond).toEqual(stateAfterFirst);
    expect(second.created).toBe(0);
    expect(second.deleted).toBe(0);
    expect(second.updated).toBe(first.updated);
  });
});
