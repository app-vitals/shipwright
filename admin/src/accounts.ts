/**
 * admin/src/accounts.ts
 * AccountService — self-serve accounts (SSP-1.2), plus the trial
 * expiry/warning queries the account lifecycle sweepers use (SSP-8.2).
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

  /**
   * Id + own per-agent trialExpiresAt of every agent owned by the account
   * (SSP-8.2 reactivation skips agents whose own trial has lapsed).
   */
  async listAgentTrialStates(
    accountId: string,
  ): Promise<Array<{ id: string; trialExpiresAt: Date | null }>> {
    return this.prisma.agent.findMany({
      where: { accountId },
      select: { id: true, trialExpiresAt: true },
    });
  }

  /**
   * Active accounts with a trial set that have not been warned yet — the
   * account trial-warning sweeper's candidates (SSP-8.2). The window check
   * itself is applied in code (isAccountTrialWarningDue).
   */
  async listTrialWarningCandidates(): Promise<
    Array<
      Pick<Account, "id" | "name" | "trialExpiresAt" | "trialExpiryWarnedAt">
    >
  > {
    return this.prisma.account.findMany({
      where: {
        status: "active",
        trialExpiresAt: { not: null },
        trialExpiryWarnedAt: null,
      },
      select: {
        id: true,
        name: true,
        trialExpiresAt: true,
        trialExpiryWarnedAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Stamp trialExpiryWarnedAt only if still unset. Returns false when another
   * writer got there first (or the account is gone).
   */
  async markTrialWarned(id: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.account.updateMany({
      where: { id, trialExpiryWarnedAt: null },
      data: { trialExpiryWarnedAt: at },
    });
    return count > 0;
  }

  /** Ids of active accounts whose trialExpiresAt is strictly before `now`. */
  async listExpiredActiveIds(now: Date): Promise<string[]> {
    const rows = await this.prisma.account.findMany({
      where: { status: "active", trialExpiresAt: { lt: now } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Flip one account to trial_expired, conditional on it still being active
   * with a lapsed trial — so a concurrent reactivation/extension wins.
   */
  async expireTrial(id: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.account.updateMany({
      where: { id, status: "active", trialExpiresAt: { lt: now } },
      data: { status: "trial_expired" },
    });
    return count > 0;
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
