/**
 * admin/src/account-members.ts
 * AccountMemberService — email-keyed members of an account (SSP-1.2).
 *
 * UNIQUE(email) means an email belongs to at most one account in Phase 1.
 * The last owner of an account can never be removed or demoted.
 */

import type { AccountMember, PrismaClient } from "../prisma/client/client.ts";
import { normalizeEmail } from "./account-email.ts";
import type { PrismaTransactionClient } from "./prisma-tx.ts";

export type { AccountMember };

export type AccountRole = "owner" | "member";

export class LastOwnerError extends Error {
  constructor(public readonly accountId: string) {
    super(`Cannot remove or demote the last owner of account ${accountId}`);
    this.name = "LastOwnerError";
  }
}

export class AccountMemberNotFoundError extends Error {
  constructor(accountId: string, email: string) {
    super(`No member ${email} in account ${accountId}`);
    this.name = "AccountMemberNotFoundError";
  }
}

export class AccountMemberService {
  constructor(private prisma: PrismaClient) {}

  async listByAccount(accountId: string): Promise<AccountMember[]> {
    return this.prisma.accountMember.findMany({
      where: { accountId },
      orderBy: { createdAt: "asc" },
    });
  }

  async getByEmail(email: string): Promise<AccountMember | null> {
    return this.prisma.accountMember.findUnique({
      where: { email: normalizeEmail(email) },
    });
  }

  /**
   * Add a member. Throws (unique-constraint violation) if the email already
   * belongs to any account.
   *
   * @param client - pass a `tx` from `prisma.$transaction` to participate in it.
   */
  async add(
    accountId: string,
    email: string,
    role: AccountRole = "member",
    client: PrismaTransactionClient = this.prisma,
  ): Promise<AccountMember> {
    return client.accountMember.create({
      data: { accountId, email: normalizeEmail(email), role },
    });
  }

  async remove(accountId: string, email: string): Promise<void> {
    await this.guardedChange(accountId, email, async (tx, member) => {
      await tx.accountMember.delete({ where: { id: member.id } });
    });
  }

  async promote(accountId: string, email: string): Promise<AccountMember> {
    return this.setRole(accountId, email, "owner");
  }

  async demote(accountId: string, email: string): Promise<AccountMember> {
    return this.setRole(accountId, email, "member");
  }

  private async setRole(
    accountId: string,
    email: string,
    role: AccountRole,
  ): Promise<AccountMember> {
    let updated: AccountMember | undefined;
    await this.guardedChange(
      accountId,
      email,
      async (tx, member) => {
        updated = await tx.accountMember.update({
          where: { id: member.id },
          data: { role },
        });
      },
      role === "member",
    );
    return updated as AccountMember;
  }

  /**
   * Runs `change` in a transaction after verifying the member exists and, when
   * the change would remove an owner, that they are not the last one. The
   * account row is locked first so concurrent removals/demotions serialize.
   */
  private async guardedChange(
    accountId: string,
    rawEmail: string,
    change: (
      tx: PrismaTransactionClient,
      member: AccountMember,
    ) => Promise<void>,
    removesOwnerRole = true,
  ): Promise<void> {
    const email = normalizeEmail(rawEmail);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${accountId} FOR UPDATE`;
      const member = await tx.accountMember.findUnique({
        where: { accountId_email: { accountId, email } },
      });
      if (!member) throw new AccountMemberNotFoundError(accountId, email);
      if (removesOwnerRole && member.role === "owner") {
        const owners = await tx.accountMember.count({
          where: { accountId, role: "owner" },
        });
        if (owners <= 1) throw new LastOwnerError(accountId);
      }
      await change(tx, member);
    });
  }
}
