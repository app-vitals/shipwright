/**
 * admin/src/account-trial-warning-sweeper.integration.test.ts
 * AccountTrialWarningSweeper (SSP-8.2) against real Postgres fixture accounts
 * and agents, with an injected AgentEnvService double (per-agent Slack
 * config), an injected Slack-send double and a FixedClock. No real Slack.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import {
  AccountTrialWarningSweeper,
  type AccountTrialWarningSweeperDeps,
} from "./account-trial-warning-sweeper.ts";
import { AccountService } from "./accounts.ts";
import { FixedClock } from "./clock.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import type { SendSlackWarningParams } from "./trial-expiry-warning-sweeper.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-08T12:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() + n * DAY);

describeOrSkip("AccountTrialWarningSweeper (integration)", () => {
  let prisma: PrismaClient;
  let accounts: AccountService;
  let sends: SendSlackWarningParams[];
  /** agentId → Slack env; absent → no config bundle. */
  let slackEnv: Map<string, Record<string, string>>;
  let sendOk: (p: SendSlackWarningParams) => boolean;

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
    sends = [];
    slackEnv = new Map();
    sendOk = () => true;
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  function makeSweeper(
    overrides: Partial<AccountTrialWarningSweeperDeps> = {},
  ): AccountTrialWarningSweeper {
    return new AccountTrialWarningSweeper({
      accounts,
      agentEnvService: {
        getConfigBundle: async (agentId) => {
          const env = slackEnv.get(agentId);
          return env ? { env, agentId, allowedTools: [] } : null;
        },
      },
      sendSlackMessage: async (p) => {
        sends.push(p);
        return sendOk(p);
      },
      clock: FixedClock(NOW),
      warningDays: 3,
      log: () => {},
      ...overrides,
    });
  }

  async function makeAccount(
    opts: {
      name?: string;
      status?: string;
      trialExpiresAt?: Date | null;
      trialExpiryWarnedAt?: Date | null;
    } = {},
  ): Promise<string> {
    const a = await prisma.account.create({
      data: {
        name: opts.name ?? "Acme",
        status: opts.status ?? "active",
        trialExpiresAt: opts.trialExpiresAt ?? null,
        trialExpiryWarnedAt: opts.trialExpiryWarnedAt ?? null,
      },
    });
    return a.id;
  }

  async function makeAgent(
    accountId: string | null,
    slack = true,
    name = "bot",
  ): Promise<string> {
    const a = await prisma.agent.create({
      data: { name, typeName: "coding", accountId },
    });
    if (slack) {
      slackEnv.set(a.id, {
        SLACK_BOT_TOKEN: `xoxb-${a.id}`,
        SLACK_ALERT_CHANNEL: `#alerts-${a.id}`,
      });
    }
    return a.id;
  }

  const warnedAt = async (id: string) =>
    (await prisma.account.findUniqueOrThrow({ where: { id } }))
      .trialExpiryWarnedAt;

  it("2 days away with a 3-day window -> exactly one warning across repeated sweeps", async () => {
    const acc = await makeAccount({
      name: "Acme Co",
      trialExpiresAt: days(2),
    });
    const agent = await makeAgent(acc);
    const sweeper = makeSweeper();

    const first = await sweeper.tick();
    expect(first.warned).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      botToken: `xoxb-${agent}`,
      channel: `#alerts-${agent}`,
    });
    expect(sends[0].text).toContain("Acme Co");
    expect(sends[0].text).toContain(days(2).toISOString().slice(0, 10));
    expect(await warnedAt(acc)).toEqual(NOW);

    for (let i = 0; i < 3; i++) {
      expect((await sweeper.tick()).warned).toBe(0);
    }
    expect(sends).toHaveLength(1);
  });

  it("posts once via each of the account's agents' own alert channel", async () => {
    const acc = await makeAccount({ trialExpiresAt: days(2) });
    const a1 = await makeAgent(acc, true, "one");
    const a2 = await makeAgent(acc, true, "two");
    await makeAgent(null); // unrelated agent, never posted to

    const result = await makeSweeper().tick();
    expect(result.warned).toBe(1);
    expect(sends.map((s) => s.channel).sort()).toEqual(
      [`#alerts-${a1}`, `#alerts-${a2}`].sort(),
    );
    await makeSweeper().tick();
    expect(sends).toHaveLength(2);
  });

  it("not yet in the window -> no warning, no stamp", async () => {
    const acc = await makeAccount({ trialExpiresAt: days(5) });
    await makeAgent(acc);
    expect((await makeSweeper().tick()).warned).toBe(0);
    expect(sends).toHaveLength(0);
    expect(await warnedAt(acc)).toBeNull();
  });

  it("no agent has Slack config -> skipped, not stamped, retried next tick", async () => {
    const acc = await makeAccount({ trialExpiresAt: days(2) });
    const agent = await makeAgent(acc, false);
    const sweeper = makeSweeper();

    expect(await sweeper.tick()).toMatchObject({ warned: 0, skipped: 1 });
    expect(await warnedAt(acc)).toBeNull();

    slackEnv.set(agent, {
      SLACK_BOT_TOKEN: "xoxb-late",
      SLACK_ALERT_CHANNEL: "#late",
    });
    expect((await sweeper.tick()).warned).toBe(1);
    expect(sends).toHaveLength(1);
  });

  it("every send fails -> failed, not stamped", async () => {
    const acc = await makeAccount({ trialExpiresAt: days(2) });
    await makeAgent(acc);
    sendOk = () => false;
    expect(await makeSweeper().tick()).toMatchObject({ warned: 0, failed: 1 });
    expect(await warnedAt(acc)).toBeNull();
  });

  it("account with no agents -> skipped, not stamped", async () => {
    const acc = await makeAccount({ trialExpiresAt: days(2) });
    expect(await makeSweeper().tick()).toMatchObject({ skipped: 1 });
    expect(await warnedAt(acc)).toBeNull();
  });

  it("never warns suspended/expired accounts, already-warned accounts, or long-lapsed trials", async () => {
    await makeAgent(
      await makeAccount({ status: "suspended", trialExpiresAt: days(2) }),
    );
    await makeAgent(
      await makeAccount({ trialExpiresAt: days(2), trialExpiryWarnedAt: NOW }),
    );
    const stale = await makeAccount({ trialExpiresAt: days(-30) });
    await makeAgent(stale);

    const result = await makeSweeper().tick();
    expect(result).toMatchObject({ warned: 0, stale: 1 });
    expect(sends).toHaveLength(0);
  });

  it("a candidate fetch failure returns all zeros without throwing", async () => {
    const sweeper = makeSweeper({
      accounts: {
        listTrialWarningCandidates: async () => {
          throw new Error("db down");
        },
        listAgents: accounts.listAgents.bind(accounts),
        markTrialWarned: accounts.markTrialWarned.bind(accounts),
      },
    });
    expect(await sweeper.tick()).toEqual({
      warned: 0,
      skipped: 0,
      failed: 0,
      stale: 0,
    });
  });
});
