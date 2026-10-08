/**
 * admin/src/accounts.ts
 * AccountService — self-serve accounts (SSP-1.2). No routes/UI yet.
 */

import type { Account, PrismaClient } from "../prisma/client/client.ts";
import { normalizeEmail } from "./account-email.ts";
import type { PrismaTransactionClient } from "./prisma-tx.ts";

export type { Account };

export type AccountStatus = "active" | "suspended" | "trial_expired";

/** An Account plus its agent and member row counts (admin /accounts API). */
export type AccountWithCounts = Account & {
  agentCount: number;
  memberCount: number;
};

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

  async listWithCounts(): Promise<AccountWithCounts[]> {
    const rows = await this.prisma.account.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { agents: true, members: true } } },
    });
    return rows.map(withCounts);
  }

  async getWithCounts(id: string): Promise<AccountWithCounts | null> {
    const row = await this.prisma.account.findUnique({
      where: { id },
      include: { _count: { select: { agents: true, members: true } } },
    });
    return row ? withCounts(row) : null;
  }

  async update(id: string, data: UpdateAccountInput): Promise<Account> {
    return this.prisma.account.update({ where: { id }, data });
  }

  /** Ids of every agent owned by the account. */
  async listAgentIds(accountId: string): Promise<string[]> {
    const agents = await this.prisma.agent.findMany({
      where: { accountId },
      select: { id: true },
    });
    return agents.map((a) => a.id);
  }

  /** Id + name of every agent owned by the account (admin account detail). */
  async listAgents(
    accountId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    return this.prisma.agent.findMany({
      where: { accountId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
  }

  async countAgents(
    accountId: string,
    client: PrismaTransactionClient = this.prisma,
  ): Promise<number> {
    return client.agent.count({ where: { accountId } });
  }
}

function withCounts(
  row: Account & { _count: { agents: number; members: number } },
): AccountWithCounts {
  const { _count, ...account } = row;
  return {
    ...account,
    agentCount: _count.agents,
    memberCount: _count.members,
  };
}
