/**
 * admin/src/agent-cron-jobs.coding.integration.test.ts
 * Golden-row-set tests for the "coding" specialty's system crons, against a
 * real PostgreSQL DB. They resolve the real coding code defaults
 * (coding/coding-specialty-defaults.ts), so they stay with that specialty and are excluded from the platform extraction (the
 * generic reconcile behaviour is covered in agent-cron-jobs.integration.test.ts).
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentCronJobService } from "@app-vitals/agent-admin/agent-cron-jobs";
import { SystemClock } from "@app-vitals/agent-admin/clock";
import type { PrismaClient } from "@app-vitals/agent-admin/prisma/client/client.ts";
import { createAdminPrismaClient } from "@app-vitals/agent-admin/prisma-client";
import { codingSpecialtyDefaults } from "./coding/coding-specialty-defaults.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createAdminPrismaClient(TEST_DB as string);
}

async function createAgent(
  prisma: PrismaClient,
  name: string,
  specialty: string,
): Promise<string> {
  const agent = await prisma.agent.create({ data: { name, specialty } });
  return agent.id;
}

/**
 * Golden expected row set for a specialty="coding" agent, hardcoded here (per
 * ATS-3.2 acceptance criterion 1) rather than derived from the code defaults at
 * runtime — so this test catches a regression in EITHER the defaults
 * OR the reconcile logic that maps them into rows. This is the exact set that
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
    name: "shipwright-plan",
    schedule: "* * * * *",
    prompt: "/shipwright:plan-session",
    silent: true,
    preCheck: null,
    enabled: false,
    parentCron: "shipwright-loop",
  },
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
    preCheck: "shipwright:check-patrol-scope.ts",
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
    preCheck: "shipwright:check-patrol-scope.ts",
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
  {
    name: "prompt-audit-maintenance",
    schedule: "0 7 * * 1",
    prompt: "/shipwright:prompt-scan --with-doctor\n/shipwright:prompt-fix",
    silent: true,
    preCheck: "shipwright:check-prompt-audit.ts",
    enabled: false,
    parentCron: null,
  },
];

describeOrSkip("AgentCronJobService coding golden set (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentCronJobService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    // The coding extension's code defaults, as startAdmin() wires them.
    service = new AgentCronJobService(
      prisma,
      SystemClock(),
      undefined,
      codingSpecialtyDefaults,
    );
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  // ─── Golden equivalence (ATS-3.2) ─────────────────────────────────────────
  //
  // t10 — critical boot path. Reconcile for a specialty="coding" agent must
  // produce the EXACT row set that the (now-deleted) SYSTEM_CRONS array
  // produced: names, schedules, prompts, preChecks, silent flags, enabled
  // defaults, and parentCron links. Expected values are hardcoded in
  // GOLDEN_CODING_CRONS above (NOT derived from the code defaults at runtime), so a
  // regression in either the defaults or the defaults→row mapping is
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
});
