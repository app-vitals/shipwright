/**
 * admin/src/accounts.ts
 * AccountService — self-serve accounts (SSP-1.2). No routes/UI yet.
 */

import type { Account, PrismaClient } from "../prisma/client/client.ts";
import { normalizeEmail } from "./account-email.ts";
import type { PrismaTransactionClient } from "./prisma-tx.ts";

export type { Account };

export type AccountStatus = "active" | "suspended" | "trial_expired";

export interface CreateAccountOpts {
  status?: AccountStatus;
  maxAgents?: number;
  plan?: string | null;
  trialExpiresAt?: Date | null;
}

export interface UpdateAccountInput {
  name?: string;
  status?: AccountStatus;
  maxAgents?: number;
  plan?: string | null;
  trialExpiresAt?: Date | null;
  trialExpiryWarnedAt?: Date | null;
}

export class AccountService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Create an account and its owner member row in one transaction. Throws
   * (unique-constraint violation) if ownerEmail already belongs to an account.
   */
  async create(
    name: string,
    ownerEmail: string,
    opts: CreateAccountOpts = {},
  ): Promise<Account> {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.create({ data: { name, ...opts } });
      await tx.accountMember.create({
        data: {
          accountId: account.id,
          email: normalizeEmail(ownerEmail),
          role: "owner",
        },
      });
      return account;
    });
  }

  async getById(id: string): Promise<Account | null> {
    return this.prisma.account.findUnique({ where: { id } });
  }

  async getByMemberEmail(email: string): Promise<Account | null> {
    const member = await this.prisma.accountMember.findUnique({
      where: { email: normalizeEmail(email) },
      include: { account: true },
    });
    return member?.account ?? null;
  }

  async list(): Promise<Account[]> {
    return this.prisma.account.findMany({ orderBy: { createdAt: "asc" } });
  }

  async update(id: string, data: UpdateAccountInput): Promise<Account> {
    return this.prisma.account.update({ where: { id }, data });
  }

  async countAgents(
    accountId: string,
    client: PrismaTransactionClient = this.prisma,
  ): Promise<number> {
    return client.agent.count({ where: { accountId } });
  }
}
