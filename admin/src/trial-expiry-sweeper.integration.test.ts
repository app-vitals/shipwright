/**
 * admin/src/trial-expiry-sweeper.integration.test.ts
 * Integration tests for TrialExpirySweeper against a real PostgreSQL DB —
 * exercises the real AgentCronJobService.listEnabledWithExpiredTrial() join
 * query and setEnabled() write path together (ATE-3.1).
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise (mirrors
 * agent-cron-jobs.integration.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { FixedClock } from "./clock.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import { TrialExpirySweeper } from "./trial-expiry-sweeper.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createAdminPrismaClient(TEST_DB as string);
}

const NOW = new Date("2026-06-15T00:00:00.000Z");
const PAST = new Date("2026-06-01T00:00:00.000Z"); // before NOW — expired
const FUTURE = new Date("2026-07-01T00:00:00.000Z"); // after NOW — not expired

async function createAgent(
  prisma: PrismaClient,
  opts: { name?: string; trialExpiresAt?: Date | null } = {},
): Promise<string> {
  const agent = await prisma.agent.create({
    data: {
      name: opts.name ?? "Test Agent",
      typeName: "coding",
      trialExpiresAt: opts.trialExpiresAt ?? null,
    },
  });
  return agent.id;
}

async function createCron(
  prisma: PrismaClient,
  agentId: string,
  opts: { enabled?: boolean; name?: string } = {},
): Promise<string> {
  const cron = await prisma.agentCronJob.create({
    data: {
      agentId,
      schedule: "0 * * * *",
      prompt: "test prompt",
      channel: "C123456",
      silent: false,
      enabled: opts.enabled ?? true,
      name: opts.name ?? null,
    },
  });
  return cron.id;
}

async function getCronEnabled(
  prisma: PrismaClient,
  cronId: string,
): Promise<boolean> {
  const cron = await prisma.agentCronJob.findUniqueOrThrow({
    where: { id: cronId },
  });
  return cron.enabled;
}

describeOrSkip("TrialExpirySweeper (integration)", () => {
  let prisma: PrismaClient;
  let sweeper: TrialExpirySweeper;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();

    const agentCronJobService = new AgentCronJobService(prisma);
    sweeper = new TrialExpirySweeper({
      agentCronJobService,
      clock: FixedClock(NOW),
    });
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  // ─── AC1: expired trial → every enabled cron disabled ──────────────────────

  it("disables every enabled cron for an agent whose trial has expired", async () => {
    const agentId = await createAgent(prisma, { trialExpiresAt: PAST });
    const cronA = await createCron(prisma, agentId, { enabled: true });
    const cronB = await createCron(prisma, agentId, { enabled: true });

    const result = await sweeper.tick();

    expect(result.disabled).toBe(2);
    expect(await getCronEnabled(prisma, cronA)).toBe(false);
    expect(await getCronEnabled(prisma, cronB)).toBe(false);
  });

  it("leaves an already-disabled cron for an expired-trial agent untouched (not recounted)", async () => {
    const agentId = await createAgent(prisma, { trialExpiresAt: PAST });
    const enabledCron = await createCron(prisma, agentId, { enabled: true });
    const disabledCron = await createCron(prisma, agentId, {
      enabled: false,
    });

    const result = await sweeper.tick();

    expect(result.disabled).toBe(1);
    expect(await getCronEnabled(prisma, enabledCron)).toBe(false);
    expect(await getCronEnabled(prisma, disabledCron)).toBe(false);
  });

  it("is idempotent — a second tick after the first finds nothing left to do", async () => {
    const agentId = await createAgent(prisma, { trialExpiresAt: PAST });
    await createCron(prisma, agentId, { enabled: true });

    const first = await sweeper.tick();
    const second = await sweeper.tick();

    expect(first.disabled).toBe(1);
    expect(second.disabled).toBe(0);
  });

  // ─── AC2: not-yet-expired / unset trial → no-op ─────────────────────────────

  it("does not touch crons for an agent whose trial has not yet expired", async () => {
    const agentId = await createAgent(prisma, { trialExpiresAt: FUTURE });
    const cronId = await createCron(prisma, agentId, { enabled: true });

    const result = await sweeper.tick();

    expect(result.disabled).toBe(0);
    expect(await getCronEnabled(prisma, cronId)).toBe(true);
  });

  it("does not touch crons for an agent with trialExpiresAt unset (null)", async () => {
    const agentId = await createAgent(prisma, { trialExpiresAt: null });
    const cronId = await createCron(prisma, agentId, { enabled: true });

    const result = await sweeper.tick();

    expect(result.disabled).toBe(0);
    expect(await getCronEnabled(prisma, cronId)).toBe(true);
  });

  it("treats trialExpiresAt exactly equal to now as NOT yet expired", async () => {
    const agentId = await createAgent(prisma, { trialExpiresAt: NOW });
    const cronId = await createCron(prisma, agentId, { enabled: true });

    const result = await sweeper.tick();

    expect(result.disabled).toBe(0);
    expect(await getCronEnabled(prisma, cronId)).toBe(true);
  });

  // ─── Edge cases ──────────────────────────────────────────────────────────

  it("no-ops cleanly for an expired-trial agent with zero cron rows", async () => {
    await createAgent(prisma, { trialExpiresAt: PAST });

    const result = await sweeper.tick();

    expect(result.disabled).toBe(0);
  });

  it("only disables crons for the expired agent, leaving a sibling not-yet-expired agent's crons alone", async () => {
    const expiredAgentId = await createAgent(prisma, {
      name: "Expired Agent",
      trialExpiresAt: PAST,
    });
    const activeAgentId = await createAgent(prisma, {
      name: "Active Agent",
      trialExpiresAt: FUTURE,
    });
    const expiredCron = await createCron(prisma, expiredAgentId, {
      enabled: true,
    });
    const activeCron = await createCron(prisma, activeAgentId, {
      enabled: true,
    });

    const result = await sweeper.tick();

    expect(result.disabled).toBe(1);
    expect(await getCronEnabled(prisma, expiredCron)).toBe(false);
    expect(await getCronEnabled(prisma, activeCron)).toBe(true);
  });

  it("a bad row does not abort the rest of the sweep (per-row try/catch)", async () => {
    const agentId = await createAgent(prisma, { trialExpiresAt: PAST });
    const badCronId = await createCron(prisma, agentId, { enabled: true });
    const goodCronId = await createCron(prisma, agentId, { enabled: true });

    // A fake service whose setEnabled() throws for one specific cron id but
    // succeeds for the other — exercises the per-row try/catch directly
    // against real listing data from the real service.
    const realService = new AgentCronJobService(prisma);
    const flaky = {
      listEnabledWithExpiredTrial: (now: Date) =>
        realService.listEnabledWithExpiredTrial(now),
      setEnabled: async (agId: string, cronId: string, enabled: boolean) => {
        if (cronId === badCronId) {
          throw new Error("boom");
        }
        return realService.setEnabled(agId, cronId, enabled);
      },
    };
    const flakySweeper = new TrialExpirySweeper({
      agentCronJobService: flaky,
      clock: FixedClock(NOW),
    });

    const result = await flakySweeper.tick();

    expect(result.disabled).toBe(1);
    expect(await getCronEnabled(prisma, badCronId)).toBe(true);
    expect(await getCronEnabled(prisma, goodCronId)).toBe(false);
  });
});
