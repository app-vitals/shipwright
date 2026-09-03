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
  typeName = "coding",
): Promise<string> {
  const agent = await prisma.agent.create({ data: { name, typeName } });
  return agent.id;
}

/**
 * Golden expected row set for a typeName="coding" agent, hardcoded here (per
 * ATS-3.2 acceptance criterion 1) rather than derived from the manifest at
 * runtime — so this test catches a regression in EITHER the manifest content
 * OR the reconcile logic that maps it into rows. This is the exact set that
 * the deleted admin/src/system-crons.ts SYSTEM_CRONS array produced.
 */
interface GoldenCron {
  name: string;
  schedule: string;
  prompt: string;
  silent: boolean;
  preCheck: string | null;
  enabled: boolean;
  parentCron: string | null;
}

const GOLDEN_CODING_CRONS: GoldenCron[] = [
  {
    name: "shipwright-dev-task",
    schedule: "* * * * *",
    prompt: "/shipwright:dev-task",
    silent: true,
    preCheck: null,
    enabled: true,
    parentCron: "shipwright-loop",
  },
  {
    name: "shipwright-patch",
    schedule: "* * * * *",
    prompt: "/shipwright:patch",
    silent: true,
    preCheck: null,
    enabled: true,
    parentCron: "shipwright-loop",
  },
  {
    name: "shipwright-review",
    schedule: "* * * * *",
    prompt: "/shipwright:review",
    silent: true,
    preCheck: null,
    enabled: true,
    parentCron: "shipwright-loop",
  },
  {
    name: "shipwright-deploy",
    schedule: "* * * * *",
    prompt: "/shipwright:deploy",
    silent: true,
    preCheck: null,
    enabled: false,
    parentCron: "shipwright-loop",
  },
  {
    name: "shipwright-loop",
    schedule: "* * * * *",
    prompt:
      "internal: dispatched via handleLoopCronRequest, not run through Claude",
    silent: true,
    preCheck: null,
    enabled: false,
    parentCron: null,
  },
  {
    name: "shipwright-test-readiness",
    schedule: "0 6 * * *",
    prompt: "/shipwright:test-readiness --full --publish",
    silent: true,
    preCheck: "shipwright:check-test-readiness.ts",
    enabled: false,
    parentCron: null,
  },
  {
    name: "shipwright-docs-freshness",
    schedule: "0 7 * * *",
    prompt: "/shipwright:research-docs --auto",
    silent: true,
    preCheck: "shipwright:check-docs-freshness.ts",
    enabled: false,
    parentCron: null,
  },
  {
    name: "learn-dream",
    schedule: "0 3 * * *",
    prompt: "/shipwright:learn-dream --since 1d --review",
    silent: true,
    preCheck: "shipwright:check-learn-dream.ts",
    enabled: false,
    parentCron: null,
  },
  {
    name: "entropy-patrol-maintenance",
    schedule: "0 4 * * 1",
    prompt:
      '/shipwright:entropy-scan\n/shipwright:entropy-fix\nAfter the fix run completes, write state/entropy-patrol-last-run.json: {"lastRun": "<ISO timestamp>"}. Use [silent] if no pr_worthy findings are found.',
    silent: true,
    preCheck: null,
    enabled: false,
    parentCron: null,
  },
  {
    name: "error-patrol-maintenance",
    schedule: "0 4 * * *",
    prompt:
      "/shipwright:error-scan\n/shipwright:error-fix\n/shipwright:error-resolve\nThese three commands are not independent suggestions -- invoke each one immediately after the previous one finishes, in this same session, using the Skill tool. Do not stop after a command's own output tells you to 'run /X next' (e.g. error-scan's summary) -- that phrasing is written for a standalone manual invocation, not this chained cron session. Continue automatically through all three commands before doing anything else.\n" +
      'After the chain completes, write state/error-patrol-ledger.json\'s lastRun field: "<ISO timestamp>". Use [silent] if no new or regressed issues are found.',
    silent: true,
    preCheck: "shipwright:check-error-patrol.ts",
    enabled: false,
    parentCron: null,
  },
  {
    name: "security-patrol-maintenance",
    schedule: "0 6 * * 1",
    prompt:
      '/shipwright:security-scan\n/shipwright:security-fix\nAfter the fix run completes, write state/security-patrol-last-run.json: {"lastRun": "<ISO timestamp>"}. Use [silent] if no pr_worthy findings are found.',
    silent: true,
    preCheck: null,
    enabled: false,
    parentCron: null,
  },
  {
    name: "consolidation-patrol-maintenance",
    schedule: "0 5 * * 1",
    prompt:
      '/shipwright:consolidation-scan\n/shipwright:consolidation-fix\nAfter the chain completes, write state/consolidation-ledger.json\'s lastRun field: "<ISO timestamp>". Use [silent] if no ready_to_propose findings are found.',
    silent: true,
    preCheck: "shipwright:check-consolidation-patrol.ts",
    enabled: false,
    parentCron: null,
  },
];

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

  it("reconcileSystemCrons() links the four legacy phase crons to shipwright-loop as parent on a fresh agent's first reconcile", async () => {
    const agentId = await createAgent(prisma);
    // Fresh agent: no shipwright-loop row exists yet before this call, so the
    // parent id must be resolved within the same reconcile that creates it.
    await service.reconcileSystemCrons(agentId);

    const jobs = await service.list(agentId);
    const loopCron = jobs.find((j) => j.name === "shipwright-loop");
    expect(loopCron).toBeDefined();

    const legacyNames = [
      "shipwright-dev-task",
      "shipwright-patch",
      "shipwright-review",
      "shipwright-deploy",
    ];
    for (const name of legacyNames) {
      const cron = jobs.find((j) => j.name === name);
      expect(cron).toBeDefined();
      expect(cron?.parentCronId).toBe(loopCron?.id as string);
    }

    // Other system crons (not part of the phase pipeline) must not be linked.
    const loopSelf = jobs.find((j) => j.name === "shipwright-loop");
    expect(loopSelf?.parentCronId).toBeNull();
    const unrelated = jobs.find((j) => j.name === "shipwright-test-readiness");
    expect(unrelated?.parentCronId).toBeNull();
  });

  it("reconcileSystemCrons() self-heals the parentCronId link on a subsequent reconcile", async () => {
    const agentId = await createAgent(prisma);
    await service.reconcileSystemCrons(agentId);

    // Simulate a pre-LPC-1.2 agent state: clear the parent link as if these
    // rows were seeded before parentCron was introduced.
    await prisma.agentCronJob.updateMany({
      where: { agentId, system: true },
      data: { parentCronId: null },
    });

    await service.reconcileSystemCrons(agentId);

    const jobs = await service.list(agentId);
    const loopCron = jobs.find((j) => j.name === "shipwright-loop");
    expect(loopCron).toBeDefined();

    for (const name of [
      "shipwright-dev-task",
      "shipwright-patch",
      "shipwright-review",
      "shipwright-deploy",
    ]) {
      const cron = jobs.find((j) => j.name === name);
      expect(cron?.parentCronId).toBe(loopCron?.id as string);
    }
  });

  it("reconcileSystemCrons() clears a stale parentCronId back to null when the entry no longer declares a resolvable parentCron", async () => {
    const agentId = await createAgent(prisma);
    await service.reconcileSystemCrons(agentId);

    const jobs = await service.list(agentId);
    const loopCron = jobs.find((j) => j.name === "shipwright-loop");
    const unrelated = jobs.find((j) => j.name === "shipwright-test-readiness");
    expect(loopCron).toBeDefined();
    expect(unrelated).toBeDefined();

    // Simulate a stale link: SYSTEM_CRONS never declares parentCron for
    // "shipwright-test-readiness", but its row has a non-null parentCronId
    // — e.g. left over from a since-removed parentCron declaration, or from
    // a name that used to resolve and no longer does.
    await prisma.agentCronJob.update({
      where: { id: unrelated?.id as string },
      data: { parentCronId: loopCron?.id as string },
    });

    const result = await service.reconcileSystemCrons(agentId);
    expect(result.created).toBe(0);

    const jobsAfter = await service.list(agentId);
    const unrelatedAfter = jobsAfter.find(
      (j) => j.name === "shipwright-test-readiness",
    );
    expect(unrelatedAfter?.parentCronId).toBeNull();
  });

  // ─── Golden equivalence (ATS-3.2) ─────────────────────────────────────────
  //
  // t10 — critical boot path. Reconcile for a typeName="coding" agent must
  // produce the EXACT row set that the (now-deleted) SYSTEM_CRONS array
  // produced: names, schedules, prompts, preChecks, silent flags, enabled
  // defaults, and parentCron links. Expected values are hardcoded in
  // GOLDEN_CODING_CRONS above (NOT derived from the manifest at runtime), so a
  // regression in either the manifest content or the manifest→row mapping is
  // caught here rather than silently accepted.

  it("reconcileSystemCrons() for a coding agent produces the exact golden row set", async () => {
    const agentId = await createAgent(prisma, "Coding Agent", "coding");
    await service.reconcileSystemCrons(agentId);

    const jobs = await service.list(agentId);
    const systemJobs = jobs.filter((j) => j.system);

    // Exactly the golden count — no extra, no missing.
    expect(systemJobs.length).toBe(GOLDEN_CODING_CRONS.length);

    // Resolve name → id so we can assert parentCron links by name.
    const idByName = new Map<string, string>();
    for (const j of systemJobs) {
      if (j.name) idByName.set(j.name, j.id);
    }

    for (const golden of GOLDEN_CODING_CRONS) {
      const row = systemJobs.find((j) => j.name === golden.name);
      expect(row, `missing golden cron ${golden.name}`).toBeDefined();
      if (!row) continue;

      expect(row.schedule).toBe(golden.schedule);
      expect(row.prompt).toBe(golden.prompt);
      expect(row.silent).toBe(golden.silent);
      expect(row.preCheck).toBe(golden.preCheck);
      expect(row.enabled).toBe(golden.enabled);
      expect(row.system).toBe(true);
      expect(row.channel).toBeNull();
      expect(row.user).toBeNull();

      const expectedParentId = golden.parentCron
        ? (idByName.get(golden.parentCron) ?? null)
        : null;
      expect(row.parentCronId).toBe(expectedParentId as string | null);
    }
  });

  it("reconcileSystemCrons() for a coding agent is idempotent — a second reconcile reproduces the same golden set with no orphans", async () => {
    const agentId = await createAgent(prisma, "Coding Agent", "coding");
    await service.reconcileSystemCrons(agentId);
    const second = await service.reconcileSystemCrons(agentId);

    // Second pass updates every row in place; creates and deletes nothing.
    expect(second.created).toBe(0);
    expect(second.deleted).toBe(0);
    expect(second.updated).toBe(GOLDEN_CODING_CRONS.length);

    const jobs = await service.list(agentId);
    const systemJobs = jobs.filter((j) => j.system);
    expect(systemJobs.length).toBe(GOLDEN_CODING_CRONS.length);
  });

  it("reconcileSystemCrons() for an unknown typeName falls back to the coding golden set (no throw on the boot path)", async () => {
    const agentId = await createAgent(prisma, "Renamed Agent", "renamed-type");

    // Must not throw — the boot-path reconcile route must never 5xx for an
    // agent whose type was renamed/removed.
    await service.reconcileSystemCrons(agentId);

    const jobs = await service.list(agentId);
    const systemJobs = jobs.filter((j) => j.system);
    expect(systemJobs.length).toBe(GOLDEN_CODING_CRONS.length);
    const names = systemJobs.map((j) => j.name).sort();
    expect(names).toEqual(GOLDEN_CODING_CRONS.map((c) => c.name).sort());
  });
});
