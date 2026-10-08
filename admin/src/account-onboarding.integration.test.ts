/**
 * admin/src/account-onboarding.integration.test.ts
 * Integration tests for AccountOnboardingService (SSP-3.1) against real Postgres.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AccountInviteService } from "./account-invites.ts";
import { AccountOnboardingService } from "./account-onboarding.ts";
import { AccountService } from "./accounts.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("AccountOnboardingService (integration)", () => {
  let prisma: PrismaClient;
  let onboarding: AccountOnboardingService;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.accountInvite.deleteMany();
    await prisma.accountMember.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.account.deleteMany();
    onboarding = new AccountOnboardingService(prisma, 3);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("creates an account with the owner row, default quota and local-part name", async () => {
    const result = await onboarding.provisionForEmail("New.User@Example.com");
    expect(result.kind).toBe("created");
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: result.accountId },
    });
    expect(account.name).toBe("new.user");
    expect(account.status).toBe("active");
    expect(account.maxAgents).toBe(3);
    const members = await prisma.accountMember.findMany();
    expect(members.map((m) => [m.email, m.role])).toEqual([
      ["new.user@example.com", "owner"],
    ]);
  });

  it("joins the invited account as member and marks the invite accepted", async () => {
    const owner = await new AccountService(prisma).create("Acme", "o@acme.com");
    await new AccountInviteService(prisma).create(
      owner.id,
      "Invitee@Acme.com",
      "o@acme.com",
    );
    const result = await onboarding.provisionForEmail("invitee@acme.com");
    expect(result).toEqual({ kind: "joined", accountId: owner.id });
    expect(await prisma.account.count()).toBe(1);
    const member = await prisma.accountMember.findUniqueOrThrow({
      where: { email: "invitee@acme.com" },
    });
    expect(member.role).toBe("member");
    const invite = await prisma.accountInvite.findFirstOrThrow({
      where: { email: "invitee@acme.com" },
    });
    expect(invite.acceptedAt).not.toBeNull();
  });

  it("returns existing for an email that already has an account", async () => {
    const first = await onboarding.provisionForEmail("a@x.com");
    const second = await onboarding.provisionForEmail("A@x.com");
    expect(second).toEqual({ kind: "existing", accountId: first.accountId });
    expect(await prisma.account.count()).toBe(1);
  });

  it("concurrent first logins for one email yield exactly one account", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        onboarding.provisionForEmail("race@x.com"),
      ),
    );
    expect(await prisma.account.count()).toBe(1);
    expect(await prisma.accountMember.count()).toBe(1);
    expect(new Set(results.map((r) => r.accountId)).size).toBe(1);
    expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
  });

  it("concurrent first logins with a pending invite join once and create no account", async () => {
    const owner = await new AccountService(prisma).create("Acme", "o@acme.com");
    await new AccountInviteService(prisma).create(owner.id, "r@acme.com", "o");
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        onboarding.provisionForEmail("r@acme.com"),
      ),
    );
    expect(await prisma.account.count()).toBe(1);
    expect(results.every((r) => r.accountId === owner.id)).toBe(true);
    expect(results.filter((r) => r.kind === "joined")).toHaveLength(1);
  });
});
