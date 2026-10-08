/**
 * admin/src/account-invites.ts
 * AccountInviteService — pending invites to join an account (SSP-1.2).
 */

import type {
  Account,
  AccountInvite,
  PrismaClient,
} from "../prisma/client/client.ts";
import { normalizeEmail } from "./account-email.ts";

export type { AccountInvite };

export class AccountInviteService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Create an invite. Re-inviting an email that already has an invite for this
   * account resets it to pending (clears acceptedAt, updates invitedBy).
   */
  async create(
    accountId: string,
    email: string,
    invitedBy: string,
  ): Promise<AccountInvite> {
    const normalized = normalizeEmail(email);
    return this.prisma.accountInvite.upsert({
      where: { accountId_email: { accountId, email: normalized } },
      create: { accountId, email: normalized, invitedBy },
      update: { invitedBy, acceptedAt: null },
    });
  }

  async listPending(accountId: string): Promise<AccountInvite[]> {
    return this.prisma.accountInvite.findMany({
      where: { accountId, acceptedAt: null },
      orderBy: { createdAt: "asc" },
    });
  }

  /** Delete a pending invite. No-ops if absent or already accepted. */
  async revoke(accountId: string, email: string): Promise<void> {
    await this.prisma.accountInvite.deleteMany({
      where: { accountId, email: normalizeEmail(email), acceptedAt: null },
    });
  }

  /**
   * Accept the oldest pending invite for an email: marks it accepted and
   * returns the account. Returns null if there is no pending invite, so a
   * second call is a no-op.
   */
  async acceptForEmail(email: string): Promise<Account | null> {
    const normalized = normalizeEmail(email);
    return this.prisma.$transaction(async (tx) => {
      const invite = await tx.accountInvite.findFirst({
        where: { email: normalized, acceptedAt: null },
        orderBy: { createdAt: "asc" },
        include: { account: true },
      });
      if (!invite) return null;
      const claimed = await tx.accountInvite.updateMany({
        where: { id: invite.id, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      return claimed.count === 1 ? invite.account : null;
    });
  }
}
