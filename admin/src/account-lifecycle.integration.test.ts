/**
 * admin/src/account-lifecycle.integration.test.ts
 * SSP-8.2 against real Postgres: account trial expiry (AccountTrialExpirySweeper),
 * admin suspend, and reactivation (AccountLifecycle.update) all driving the
 * SSP-8.1 cron lockdown marker. A FixedClock stands in for time.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AccountLifecycle } from "./account-lifecycle.ts";
import { AccountTrialExpirySweeper } from "./account-trial-expiry-sweeper.ts";
import { AccountService } from "./accounts.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { FixedClock } from "./clock.ts";
import { UnprocessableEntityError } from "./errors.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import { TrialExpirySweeper } from "./trial-expiry-sweeper.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-08T12:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() + n * DAY);

describeOrSkip("account lifecycle (integration)", () => {
  let prisma: PrismaClient;
  let accounts: AccountService;
  let cronJobs: AgentCronJobService;
  let lifecycle: AccountLifecycle;
  let sweeper: AccountTrialExpirySweeper;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.accountInvite.deleteMany();
    await prisma.accountMember.deleteMany();
    await prisma.account.deleteMany();
    accounts = new AccountService(prisma);
    cronJobs = new AgentCronJobService(prisma);
    const clock = FixedClock(NOW);
    lifecycle = new AccountLifecycle({
      accounts,
      cronJobs,
      clock,
      log: () => {},
    });
    sweeper = new AccountTrialExpirySweeper({
      accounts,
      lifecycle,
      clock,
      log: () => {},
    });
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  async function makeAccount(
    opts: {
      status?: "active" | "suspended" | "trial_expired";
      trialExpiresAt?: Date | null;
      trialExpiryWarnedAt?: Date | null;
    } = {},
  ): Promise<string> {
    const a = await prisma.account.create({
      data: {
        name: "Acme",
        status: opts.status ?? "active",
        trialExpiresAt: opts.trialExpiresAt ?? null,
        trialExpiryWarnedAt: opts.trialExpiryWarnedAt ?? null,
      },
    });
    return a.id;
  }

  async function makeAgent(
    accountId: string | null,
    trialExpiresAt: Date | null = null,
  ): Promise<string> {
    const a = await prisma.agent.create({
      data: { name: "agent", typeName: "coding", accountId, trialExpiresAt },
    });
    return a.id;
  }

  async function makeCron(agentId: string, enabled = true): Promise<string> {
    const c = await prisma.agentCronJob.create({
      data: {
        agentId,
        schedule: "0 * * * *",
        prompt: "p",
        channel: "C1",
        silent: false,
        enabled,
      },
    });
    return c.id;
  }

  const cron = (id: string) =>
    prisma.agentCronJob.findUniqueOrThrow({ where: { id } });
  const account = (id: string) =>
    prisma.account.findUniqueOrThrow({ where: { id } });

  // ─── Expiry ────────────────────────────────────────────────────────────────

  it("expired active account -> trial_expired, every cron disabled + marked; re-run does nothing", async () => {
    const acc = await makeAccount({ trialExpiresAt: days(-1) });
    const agentA = await makeAgent(acc);
    const agentB = await makeAgent(acc);
    const c1 = await makeCron(agentA);
    const c2 = await makeCron(agentB);
    const userOff = await makeCron(agentA, false);

    const first = await sweeper.tick();
    expect(first).toEqual({ expired: 1, disabled: 2 });
    expect((await account(acc)).status).toBe("trial_expired");
    for (const id of [c1, c2]) {
      const row = await cron(id);
      expect(row.enabled).toBe(false);
      expect(row.lockdownDisabledAt).not.toBeNull();
    }
    // A cron the user had already disabled is left unmarked.
    expect((await cron(userOff)).lockdownDisabledAt).toBeNull();

    const before = await cron(c1);
    const second = await sweeper.tick();
    expect(second).toEqual({ expired: 0, disabled: 0 });
    const after = await cron(c1);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.lockdownDisabledAt).toEqual(before.lockdownDisabledAt);
  });

  it("leaves future-trial, no-trial and expiring-exactly-now accounts alone", async () => {
    const future = await makeAccount({ trialExpiresAt: days(2) });
    const none = await makeAccount();
    const exactlyNow = await makeAccount({ trialExpiresAt: NOW });
    const crons = await Promise.all(
      [future, none, exactlyNow].map(async (a) => makeCron(await makeAgent(a))),
    );

    expect(await sweeper.tick()).toEqual({ expired: 0, disabled: 0 });
    for (const a of [future, none, exactlyNow]) {
      expect((await account(a)).status).toBe("active");
    }
    for (const c of crons) expect((await cron(c)).enabled).toBe(true);
  });

  it("does not flip a suspended account with a lapsed trial to trial_expired", async () => {
    const acc = await makeAccount({
      status: "suspended",
      trialExpiresAt: days(-1),
    });
    await sweeper.tick();
    expect((await account(acc)).status).toBe("suspended");
  });

  it("re-locks a cron re-enabled while the account is locked", async () => {
    const acc = await makeAccount({ status: "suspended" });
    const agent = await makeAgent(acc);
    const c = await makeCron(agent);

    expect(await sweeper.tick()).toEqual({ expired: 0, disabled: 1 });
    const row = await cron(c);
    expect(row.enabled).toBe(false);
    expect(row.lockdownDisabledAt).not.toBeNull();
  });

  // ─── Suspend ───────────────────────────────────────────────────────────────

  it("suspend locks down every enabled cron of the account's agents only", async () => {
    const acc = await makeAccount();
    const other = await makeAccount();
    const agent = await makeAgent(acc);
    const c = await makeCron(agent);
    const userOff = await makeCron(agent, false);
    const otherCron = await makeCron(await makeAgent(other));
    const freeCron = await makeCron(await makeAgent(null));

    const updated = await lifecycle.update(acc, { status: "suspended" });
    expect(updated.status).toBe("suspended");

    const row = await cron(c);
    expect(row.enabled).toBe(false);
    expect(row.lockdownDisabledAt).not.toBeNull();
    expect((await cron(userOff)).lockdownDisabledAt).toBeNull();
    expect((await cron(otherCron)).enabled).toBe(true);
    expect((await cron(freeCron)).enabled).toBe(true);
  });

  it("suspending an already-suspended account is a no-op", async () => {
    const acc = await makeAccount();
    const c = await makeCron(await makeAgent(acc));
    await lifecycle.update(acc, { status: "suspended" });
    const before = await cron(c);
    await lifecycle.update(acc, { status: "suspended" });
    expect((await cron(c)).updatedAt).toEqual(before.updatedAt);
  });

  // ─── Reactivate ────────────────────────────────────────────────────────────

  it("reactivation restores exactly the lockdown-disabled crons, not user-disabled ones", async () => {
    const acc = await makeAccount();
    const agent = await makeAgent(acc);
    const locked = await makeCron(agent);
    const userOff = await makeCron(agent, false);

    await lifecycle.update(acc, { status: "suspended" });
    // A cron the user disables manually while suspended carries no marker.
    const userOffDuring = await makeCron(agent, false);

    await lifecycle.update(acc, { status: "active" });

    const row = await cron(locked);
    expect(row.enabled).toBe(true);
    expect(row.lockdownDisabledAt).toBeNull();
    expect((await cron(userOff)).enabled).toBe(false);
    expect((await cron(userOffDuring)).enabled).toBe(false);
  });

  it("reactivating a trial_expired account with a future trial restores crons and resets trialExpiryWarnedAt", async () => {
    const acc = await makeAccount({
      trialExpiresAt: days(-1),
      trialExpiryWarnedAt: days(-3),
    });
    const c = await makeCron(await makeAgent(acc));
    await sweeper.tick();
    expect((await cron(c)).enabled).toBe(false);

    const updated = await lifecycle.update(acc, {
      status: "active",
      trialExpiresAt: days(30),
    });
    expect(updated.status).toBe("active");
    expect(updated.trialExpiryWarnedAt).toBeNull();
    expect((await cron(c)).enabled).toBe(true);

    // And the expiry sweeper leaves it alone now.
    expect(await sweeper.tick()).toEqual({ expired: 0, disabled: 0 });
  });

  it("reactivating with trialExpiresAt cleared is allowed", async () => {
    const acc = await makeAccount({
      status: "trial_expired",
      trialExpiresAt: days(-1),
    });
    const updated = await lifecycle.update(acc, {
      status: "active",
      trialExpiresAt: null,
    });
    expect(updated.status).toBe("active");
    expect(updated.trialExpiresAt).toBeNull();
  });

  it("rejects reactivation while trialExpiresAt is still in the past (no write)", async () => {
    const acc = await makeAccount({
      status: "trial_expired",
      trialExpiresAt: days(-1),
    });
    const c = await makeCron(await makeAgent(acc));
    await sweeper.tick();

    await expect(lifecycle.update(acc, { status: "active" })).rejects.toThrow(
      UnprocessableEntityError,
    );
    expect((await account(acc)).status).toBe("trial_expired");
    expect((await cron(c)).enabled).toBe(false);
  });

  it("does not restore crons of an agent whose own per-agent trial has lapsed", async () => {
    const acc = await makeAccount();
    const ownExpired = await makeAgent(acc, days(-1));
    const c = await makeCron(ownExpired);
    await lifecycle.update(acc, { status: "suspended" });
    await lifecycle.update(acc, { status: "active" });
    expect((await cron(c)).enabled).toBe(false);
  });

  it("changing trialExpiresAt resets trialExpiryWarnedAt; resubmitting the same value does not", async () => {
    const acc = await makeAccount({
      trialExpiresAt: days(2),
      trialExpiryWarnedAt: days(-1),
    });
    const same = await lifecycle.update(acc, {
      name: "Renamed",
      trialExpiresAt: days(2),
    });
    expect(same.trialExpiryWarnedAt).not.toBeNull();
    const extended = await lifecycle.update(acc, { trialExpiresAt: days(20) });
    expect(extended.trialExpiryWarnedAt).toBeNull();
  });

  it("update on a missing account throws NotFound", async () => {
    await expect(
      lifecycle.update("nope", { status: "suspended" }),
    ).rejects.toThrow("not found");
  });

  // ─── Regression: per-agent trial expiry ────────────────────────────────────

  it("per-agent trialExpiresAt still locks crons for agents with accountId null or set", async () => {
    const acc = await makeAccount();
    const inAccount = await makeAgent(acc, days(-1));
    const free = await makeAgent(null, days(-1));
    const c1 = await makeCron(inAccount);
    const c2 = await makeCron(free);

    // Account sweeper alone doesn't touch them (account is active, no trial)…
    expect(await sweeper.tick()).toEqual({ expired: 0, disabled: 0 });
    // …the per-agent sweeper still does, exactly as before.
    const perAgent = new TrialExpirySweeper({
      agentCronJobService: cronJobs,
      clock: FixedClock(NOW),
      log: () => {},
    });
    expect((await perAgent.tick()).disabled).toBe(2);
    expect((await cron(c1)).enabled).toBe(false);
    expect((await cron(c2)).enabled).toBe(false);
    expect((await account(acc)).status).toBe("active");
  });
});
