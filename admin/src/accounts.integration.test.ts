/**
 * admin/src/accounts.integration.test.ts
 * Integration tests for AccountService, AccountMemberService and
 * AccountInviteService (SSP-1.2) against real Postgres.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AccountInviteService } from "./account-invites.ts";
import {
  AccountMemberNotFoundError,
  AccountMemberService,
  LastOwnerError,
} from "./account-members.ts";
import { AccountService } from "./accounts.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("Account services (integration)", () => {
  let prisma: PrismaClient;
  let accounts: AccountService;
  let members: AccountMemberService;
  let invites: AccountInviteService;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.accountInvite.deleteMany();
    await prisma.accountMember.deleteMany();
    await prisma.agent.deleteMany();
    await prisma.account.deleteMany();
    accounts = new AccountService(prisma);
    members = new AccountMemberService(prisma);
    invites = new AccountInviteService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  describe("AccountService", () => {
    it("create() makes the account with defaults and a lowercased owner row", async () => {
      const account = await accounts.create("Acme", "Owner@Acme.COM");
      expect(account.status).toBe("active");
      expect(account.maxAgents).toBe(0);
      const rows = await members.listByAccount(account.id);
      expect(rows.map((r) => [r.email, r.role])).toEqual([
        ["owner@acme.com", "owner"],
      ]);
    });

    it("create() rolls back the account when the owner email is taken", async () => {
      await accounts.create("A", "dup@x.com");
      await expect(
        (async () => accounts.create("B", "DUP@x.com"))(),
      ).rejects.toThrow();
      expect((await accounts.list()).map((a) => a.name)).toEqual(["A"]);
    });

    it("getByMemberEmail() is case-insensitive", async () => {
      const account = await accounts.create("Acme", "o@acme.com");
      expect((await accounts.getByMemberEmail("O@ACME.com"))?.id).toBe(
        account.id,
      );
      expect(await accounts.getByMemberEmail("nobody@x.com")).toBeNull();
    });

    it("countAgents() counts only agents of that account", async () => {
      const a = await accounts.create("A", "a@x.com");
      const b = await accounts.create("B", "b@x.com");
      await prisma.agent.create({ data: { name: "1", accountId: a.id } });
      await prisma.agent.create({ data: { name: "2", accountId: a.id } });
      await prisma.agent.create({ data: { name: "3", accountId: b.id } });
      expect(await accounts.countAgents(a.id)).toBe(2);
    });

    it("existing agents keep accountId NULL and an account with agents cannot be deleted", async () => {
      const legacy = await prisma.agent.create({ data: { name: "legacy" } });
      expect(legacy.accountId).toBeNull();
      const a = await accounts.create("A", "a@x.com");
      await prisma.agent.create({ data: { name: "x", accountId: a.id } });
      await expect(
        (async () => prisma.account.delete({ where: { id: a.id } }))(),
      ).rejects.toThrow();
    });

    it("update() changes fields", async () => {
      const a = await accounts.create("A", "a@x.com");
      const updated = await accounts.update(a.id, {
        status: "suspended",
        maxAgents: 3,
      });
      expect(updated.status).toBe("suspended");
      expect(updated.maxAgents).toBe(3);
    });
  });

  describe("AccountMemberService", () => {
    it("UNIQUE(email) rejects the same email in a second account", async () => {
      await accounts.create("A", "shared@x.com");
      const b = await accounts.create("B", "b@x.com");
      await expect(
        (async () => members.add(b.id, "Shared@X.com"))(),
      ).rejects.toThrow();
    });

    it("refuses to remove the last owner and changes nothing", async () => {
      const a = await accounts.create("A", "o@x.com");
      await members.add(a.id, "m@x.com");
      await expect(
        (async () => members.remove(a.id, "O@x.com"))(),
      ).rejects.toBeInstanceOf(LastOwnerError);
      expect(await members.listByAccount(a.id)).toHaveLength(2);
    });

    it("refuses to demote the last owner and changes nothing", async () => {
      const a = await accounts.create("A", "o@x.com");
      await expect(
        (async () => members.demote(a.id, "o@x.com"))(),
      ).rejects.toBeInstanceOf(LastOwnerError);
      expect((await members.getByEmail("o@x.com"))?.role).toBe("owner");
    });

    it("allows demoting/removing an owner once another owner exists", async () => {
      const a = await accounts.create("A", "o@x.com");
      await members.add(a.id, "m@x.com");
      await members.promote(a.id, "M@x.com");
      expect((await members.demote(a.id, "o@x.com")).role).toBe("member");
      await expect(
        (async () => members.remove(a.id, "m@x.com"))(),
      ).rejects.toBeInstanceOf(LastOwnerError);
    });

    it("removes a plain member and errors on unknown members", async () => {
      const a = await accounts.create("A", "o@x.com");
      await members.add(a.id, "m@x.com");
      await members.remove(a.id, "m@x.com");
      expect(await members.getByEmail("m@x.com")).toBeNull();
      await expect(
        (async () => members.remove(a.id, "m@x.com"))(),
      ).rejects.toBeInstanceOf(AccountMemberNotFoundError);
    });
  });

  describe("AccountInviteService", () => {
    it("create() lowercases and listPending() returns it", async () => {
      const a = await accounts.create("A", "o@x.com");
      await invites.create(a.id, "New@X.com", "o@x.com");
      const pending = await invites.listPending(a.id);
      expect(pending.map((i) => i.email)).toEqual(["new@x.com"]);
    });

    it("acceptForEmail() marks accepted and returns the account; second call is a no-op", async () => {
      const a = await accounts.create("A", "o@x.com");
      await invites.create(a.id, "new@x.com", "o@x.com");
      const first = await invites.acceptForEmail("NEW@x.com");
      expect(first?.id).toBe(a.id);
      expect(await invites.listPending(a.id)).toHaveLength(0);
      const row = await prisma.accountInvite.findFirst({
        where: { accountId: a.id },
      });
      expect(row?.acceptedAt).not.toBeNull();
      expect(await invites.acceptForEmail("new@x.com")).toBeNull();
    });

    it("revoke() removes a pending invite", async () => {
      const a = await accounts.create("A", "o@x.com");
      await invites.create(a.id, "new@x.com", "o@x.com");
      await invites.revoke(a.id, "NEW@x.com");
      expect(await invites.listPending(a.id)).toHaveLength(0);
      expect(await invites.acceptForEmail("new@x.com")).toBeNull();
    });
  });
});
