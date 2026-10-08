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
import { AccountMemberService } from "./account-members.ts";
import { AccountService } from "./accounts.ts";
import { createAccountsApp } from "./accounts-api.ts";
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
});
