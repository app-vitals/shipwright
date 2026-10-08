/**
 * admin/src/accounts-api.integration.test.ts
 * POST /accounts against real Postgres (SSP-5.1): the admin-created account
 * seeds the owner AccountMember, so that owner's first login resolves to it
 * (no new account), and PATCH can raise maxAgents.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 *
 * Note: SSP-4.1 agent-creation quota gating is not present on this branch, so
 * the "owner can then create up to 3 agents" half of the PATCH criterion is
 * covered with SSP-4.1; here we assert the raised quota and the agent count
 * the quota is compared against.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AccountLifecycle } from "./account-lifecycle.ts";
import { AccountMemberService } from "./account-members.ts";
import { AccountService } from "./accounts.ts";
import { createAccountsApp } from "./accounts-api.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("/accounts API (integration)", () => {
  let prisma: PrismaClient;
  let accounts: AccountService;
  let app: ReturnType<typeof createAccountsApp>;
  const headers = {
    Authorization: "Bearer k",
    "Content-Type": "application/json",
  };

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentCronJob.deleteMany();
    await prisma.accountInvite.deleteMany();
    await prisma.accountMember.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.account.deleteMany();
    accounts = new AccountService(prisma);
    app = createAccountsApp({
      selfServe: {
        enabled: true,
        defaultMaxAgents: 0,
        contactEmail: "c@x.com",
      },
      sessionSecret: "s".repeat(32),
      adminApiKeys: new Map([["k", { name: "t", scope: "*" }]]),
      agentTokenService: { validate: async () => null } as never,
      accountService: accounts,
      accountLifecycle: new AccountLifecycle({
        accounts,
        cronJobs: new AgentCronJobService(prisma),
        log: () => {},
      }),
    });
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("POST /accounts seeds the owner so their first login joins it", async () => {
    const res = await app.request("/accounts", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Acme",
        ownerEmail: "Owner@Acme.com",
        maxAgents: 2,
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; memberCount: number };
    expect(created.memberCount).toBe(1);

    // First-login lookup (same one the login join uses) lands in this account.
    const joined = await accounts.getByMemberEmail("owner@acme.com");
    expect(joined?.id).toBe(created.id);
    const member = await new AccountMemberService(prisma).getByEmail(
      "owner@acme.com",
    );
    expect(member?.role).toBe("owner");
    expect(await prisma.account.count()).toBe(1);
  });

  it("duplicate owner email -> 409 and no extra account", async () => {
    const body = JSON.stringify({
      name: "A",
      ownerEmail: "d@x.com",
      maxAgents: 1,
    });
    expect(
      (await app.request("/accounts", { method: "POST", headers, body }))
        .status,
    ).toBe(201);
    expect(
      (await app.request("/accounts", { method: "POST", headers, body }))
        .status,
    ).toBe(409);
    expect(await prisma.account.count()).toBe(1);
  });

  it("PATCH raises maxAgents 0 -> 3 and GET reflects counts", async () => {
    const a = await accounts.create("A", "a@x.com");
    expect(a.maxAgents).toBe(0);
    await prisma.agent.create({ data: { name: "one", accountId: a.id } });
    const res = await app.request(`/accounts/${a.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ maxAgents: 3, plan: "pro", status: "active" }),
    });
    expect(res.status).toBe(200);
    const got = await app.request(`/accounts/${a.id}`, { headers });
    expect(await got.json()).toMatchObject({
      maxAgents: 3,
      plan: "pro",
      agentCount: 1,
      memberCount: 1,
    });
    const list = (await (
      await app.request("/accounts", { headers })
    ).json()) as {
      accounts: unknown[];
    };
    expect(list.accounts).toHaveLength(1);
  });

  // ─── SSP-8.2: status transitions drive the cron lockdown ──────────────────

  async function agentWithCrons(accountId: string) {
    const agent = await prisma.agent.create({
      data: { name: "bot", accountId },
    });
    const mk = (enabled: boolean) =>
      prisma.agentCronJob.create({
        data: {
          agentId: agent.id,
          schedule: "0 * * * *",
          prompt: "p",
          channel: "C1",
          silent: false,
          enabled,
        },
      });
    return { on: await mk(true), userOff: await mk(false) };
  }

  const patch = (id: string, body: unknown) =>
    app.request(`/accounts/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });

  const cron = (id: string) =>
    prisma.agentCronJob.findUniqueOrThrow({ where: { id } });

  it("PATCH status=suspended locks down crons; status=active restores only those", async () => {
    const a = await accounts.create("A", "a@x.com");
    const { on, userOff } = await agentWithCrons(a.id);

    expect((await patch(a.id, { status: "suspended" })).status).toBe(200);
    const locked = await cron(on.id);
    expect(locked.enabled).toBe(false);
    expect(locked.lockdownDisabledAt).not.toBeNull();
    expect((await cron(userOff.id)).lockdownDisabledAt).toBeNull();

    const res = await patch(a.id, { status: "active" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "active" });
    expect((await cron(on.id)).enabled).toBe(true);
    expect((await cron(userOff.id)).enabled).toBe(false);
  });

  it("PATCH status=active with a lapsed trial -> 422 and nothing restored", async () => {
    const a = await accounts.create("A", "a@x.com", {
      status: "trial_expired",
      trialExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const res = await patch(a.id, { status: "active" });
    expect(res.status).toBe(422);
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: a.id } })).status,
    ).toBe("trial_expired");

    const ok = await patch(a.id, {
      status: "active",
      trialExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(ok.status).toBe(200);
  });
});
