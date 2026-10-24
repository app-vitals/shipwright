/**
 * admin/src/agent-cron-jobs.integration.test.ts
 * Integration tests for AgentCronJobService against a real PostgreSQL DB.
 *
 * The reconcile tests inject a small fixture specialty, so they do not depend
 * on any shipped specialty. The golden row set for the "coding" specialty
 * lives in agent-cron-jobs.coding.integration.test.ts.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { NotFoundError, UnprocessableEntityError } from "./errors.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import type { SpecialtyManifestResolver } from "./specialty-manifest-loader.ts";
import type { SpecialtyManifest } from "./specialty-registry.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createAdminPrismaClient(TEST_DB as string);
}

// A fixture specialty with a parent cron, two children, and a standalone
// cron, covering every field reconcile maps into a row.
const FIXTURE_TYPE = "fixture";

type ManifestCron = SpecialtyManifest["crons"][number];

const FIXTURE_CRONS: ManifestCron[] = [
  {
    name: "fixture-loop",
    schedule: "*/30 * * * *",
    prompt: "/fixture:loop",
    silent: true,
    enabled: true,
    preCheck: "fixture:check-loop.ts",
  },
  {
    name: "fixture-child-a",
    schedule: "0,30 * * * *",
    prompt: "/fixture:a",
    silent: true,
    enabled: false,
    parentCron: "fixture-loop",
  },
  {
    name: "fixture-child-b",
    schedule: "15,45 * * * *",
    prompt: "/fixture:b",
    silent: true,
    enabled: false,
    parentCron: "fixture-loop",
  },
  {
    name: "fixture-standalone",
    schedule: "0 7 * * 1",
    prompt: "/fixture:standalone\n/fixture:follow-up",
    silent: false,
    enabled: true,
  },
];

const fixtureManifest = {
  crons: FIXTURE_CRONS,
} as unknown as SpecialtyManifest;

/** Resolves only FIXTURE_TYPE; every other type is unknown. */
const fixtureResolver: SpecialtyManifestResolver = {
  getManifest(typeName: string): SpecialtyManifest {
    if (typeName !== FIXTURE_TYPE) throw new Error(`no manifest: ${typeName}`);
    return fixtureManifest;
  },
  tryGetManifest(typeName: string): SpecialtyManifest | undefined {
    return typeName === FIXTURE_TYPE ? fixtureManifest : undefined;
  },
  listTypes() {
    return [{ name: FIXTURE_TYPE, displayName: FIXTURE_TYPE }];
  },
};

async function createAgent(
  prisma: PrismaClient,
  name = "Test Agent",
  typeName = FIXTURE_TYPE,
): Promise<string> {
  const agent = await prisma.agent.create({ data: { name, typeName } });
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
    service = new AgentCronJobService(prisma, undefined, fixtureResolver);
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

  it("reconcileSystemCrons() creates the specialty's system crons for a new agent", async () => {
    const agentId = await createAgent(prisma);
    const result = await service.reconcileSystemCrons(agentId);
    expect(result).toEqual({
      created: FIXTURE_CRONS.length,
      updated: 0,
      deleted: 0,
    });

    const systemJobs = (await service.list(agentId)).filter((j) => j.system);
    expect(systemJobs.length).toBe(FIXTURE_CRONS.length);
  });

  it("reconcileSystemCrons() updates existing system crons in place", async () => {
    const agentId = await createAgent(prisma);
    await service.reconcileSystemCrons(agentId);
    const result = await service.reconcileSystemCrons(agentId);
    expect(result).toEqual({
      created: 0,
      updated: FIXTURE_CRONS.length,
      deleted: 0,
    });
  });

  it("reconcileSystemCrons() preserves cron id and AgentCronRun history across a reconcile", async () => {
    const agentId = await createAgent(prisma);
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
    expect(result.updated).toBe(FIXTURE_CRONS.length);
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

  it("reconcileSystemCrons() links children to their parent on a fresh agent's first reconcile", async () => {
    const agentId = await createAgent(prisma);
    // Fresh agent: no parent row exists yet before this call, so the parent
    // id must be resolved within the same reconcile that creates it.
    await service.reconcileSystemCrons(agentId);

    const jobs = await service.list(agentId);
    const parent = jobs.find((j) => j.name === "fixture-loop");
    expect(parent).toBeDefined();

    for (const name of ["fixture-child-a", "fixture-child-b"]) {
      const cron = jobs.find((j) => j.name === name);
      expect(cron).toBeDefined();
      expect(cron?.parentCronId).toBe(parent?.id as string);
    }

    // Crons that declare no parent must not be linked, the parent included.
    expect(parent?.parentCronId).toBeNull();
    const standalone = jobs.find((j) => j.name === "fixture-standalone");
    expect(standalone?.parentCronId).toBeNull();
  });

  it("reconcileSystemCrons() self-heals the parentCronId link on a subsequent reconcile", async () => {
    const agentId = await createAgent(prisma);
    await service.reconcileSystemCrons(agentId);

    // Simulate an agent seeded before parentCron was introduced: clear the
    // parent links on every system row.
    await prisma.agentCronJob.updateMany({
      where: { agentId, system: true },
      data: { parentCronId: null },
    });

    await service.reconcileSystemCrons(agentId);

    const jobs = await service.list(agentId);
    const parent = jobs.find((j) => j.name === "fixture-loop");
    expect(parent).toBeDefined();

    for (const name of ["fixture-child-a", "fixture-child-b"]) {
      const cron = jobs.find((j) => j.name === name);
      expect(cron?.parentCronId).toBe(parent?.id as string);
    }
  });

  it("reconcileSystemCrons() clears a stale parentCronId back to null when the entry no longer declares a resolvable parentCron", async () => {
    const agentId = await createAgent(prisma);
    await service.reconcileSystemCrons(agentId);

    const jobs = await service.list(agentId);
    const parent = jobs.find((j) => j.name === "fixture-loop");
    const standalone = jobs.find((j) => j.name === "fixture-standalone");
    expect(parent).toBeDefined();
    expect(standalone).toBeDefined();

    // Simulate a stale link: the manifest never declares a parentCron for
    // "fixture-standalone", but its row has a non-null parentCronId — e.g.
    // left over from a since-removed parentCron declaration.
    await prisma.agentCronJob.update({
      where: { id: standalone?.id as string },
      data: { parentCronId: parent?.id as string },
    });

    const result = await service.reconcileSystemCrons(agentId);
    expect(result.created).toBe(0);

    const jobsAfter = await service.list(agentId);
    const standaloneAfter = jobsAfter.find(
      (j) => j.name === "fixture-standalone",
    );
    expect(standaloneAfter?.parentCronId).toBeNull();
  });

  // The expected rows are hardcoded here (NOT derived from the manifest at
  // runtime), so a regression in either the manifest→row mapping or the
  // fixture itself is caught rather than silently accepted.
  it("reconcileSystemCrons() produces the exact row set the manifest declares", async () => {
    const agentId = await createAgent(prisma);
    await service.reconcileSystemCrons(agentId);

    const systemJobs = (await service.list(agentId)).filter((j) => j.system);
    expect(systemJobs.length).toBe(4);

    const idByName = new Map<string, string>();
    for (const j of systemJobs) {
      if (j.name) idByName.set(j.name, j.id);
    }

    const expected = [
      {
        name: "fixture-loop",
        schedule: "*/30 * * * *",
        prompt: "/fixture:loop",
        silent: true,
        preCheck: "fixture:check-loop.ts",
        enabled: true,
        parent: null,
      },
      {
        name: "fixture-child-a",
        schedule: "0,30 * * * *",
        prompt: "/fixture:a",
        silent: true,
        preCheck: null,
        enabled: false,
        parent: "fixture-loop",
      },
      {
        name: "fixture-child-b",
        schedule: "15,45 * * * *",
        prompt: "/fixture:b",
        silent: true,
        preCheck: null,
        enabled: false,
        parent: "fixture-loop",
      },
      {
        name: "fixture-standalone",
        schedule: "0 7 * * 1",
        prompt: "/fixture:standalone\n/fixture:follow-up",
        silent: false,
        preCheck: null,
        enabled: true,
        parent: null,
      },
    ];

    for (const want of expected) {
      const row = systemJobs.find((j) => j.name === want.name);
      expect(row, `missing cron ${want.name}`).toBeDefined();
      if (!row) continue;

      expect(row.schedule).toBe(want.schedule);
      expect(row.prompt).toBe(want.prompt);
      expect(row.silent).toBe(want.silent);
      expect(row.preCheck).toBe(want.preCheck);
      expect(row.enabled).toBe(want.enabled);
      expect(row.system).toBe(true);
      expect(row.channel).toBeNull();
      expect(row.user).toBeNull();
      expect(row.parentCronId).toBe(
        want.parent ? (idByName.get(want.parent) ?? null) : null,
      );
    }
  });

  it("reconcileSystemCrons() is idempotent — a second reconcile reproduces the same rows with no orphans", async () => {
    const agentId = await createAgent(prisma);
    await service.reconcileSystemCrons(agentId);
    const second = await service.reconcileSystemCrons(agentId);

    // Second pass updates every row in place; creates and deletes nothing.
    expect(second).toEqual({
      created: 0,
      updated: FIXTURE_CRONS.length,
      deleted: 0,
    });
    const systemJobs = (await service.list(agentId)).filter((j) => j.system);
    expect(systemJobs.length).toBe(FIXTURE_CRONS.length);
  });

  it("reconcileSystemCrons() for an unknown typeName changes nothing (no fallback)", async () => {
    const agentId = await createAgent(prisma, "Renamed Agent", "renamed-type");

    // Must not throw, and must not seed another specialty's crons.
    const result = await service.reconcileSystemCrons(agentId);

    expect(result).toEqual({ created: 0, updated: 0, deleted: 0 });
    expect(await service.list(agentId)).toEqual([]);
  });
});
