/**
 * admin/src/account-onboarding.ts
 * AccountOnboardingService — first-login account provisioning for self-serve
 * agent provisioning (SSP-3.1).
 *
 * A verified email with no account yet either joins the account that invited
 * it (as 'member') or gets a brand-new account (as 'owner'). Everything runs
 * in one transaction, and concurrent first logins for the same email are made
 * idempotent by UNIQUE(AccountMember.email): the losing transaction rolls back
 * entirely (including any account it created) and re-reads the winner's row.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import { normalizeEmail } from "./account-email.ts";

export type OnboardingResult =
  | { kind: "created"; accountId: string }
  | { kind: "joined"; accountId: string }
  | { kind: "existing"; accountId: string };

const MAX_ATTEMPTS = 3;
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === UNIQUE_VIOLATION;
}

export class AccountOnboardingService {
  constructor(
    private prisma: PrismaClient,
    private defaultMaxAgents: number,
  ) {}

  /**
   * Ensure the email belongs to an account: no-op ("existing") if it already
   * does, else join via pending invite ("joined"), else create ("created").
   */
  async provisionForEmail(rawEmail: string): Promise<OnboardingResult> {
    const email = normalizeEmail(rawEmail);
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.$transaction((tx) =>
          this.provisionInTx(tx, email),
        );
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // A concurrent first login won the race — read-after-conflict.
        lastErr = err;
        const member = await this.prisma.accountMember.findUnique({
          where: { email },
        });
        if (member) return { kind: "existing", accountId: member.accountId };
      }
    }
    throw lastErr;
  }

  private async provisionInTx(
    tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
    email: string,
  ): Promise<OnboardingResult> {
    const existing = await tx.accountMember.findUnique({ where: { email } });
    if (existing) return { kind: "existing", accountId: existing.accountId };

    const invite = await tx.accountInvite.findFirst({
      where: { email, acceptedAt: null },
      orderBy: { createdAt: "asc" },
    });
    if (invite) {
      const claimed = await tx.accountInvite.updateMany({
        where: { id: invite.id, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (claimed.count === 1) {
        await tx.accountMember.create({
          data: { accountId: invite.accountId, email, role: "member" },
        });
        return { kind: "joined", accountId: invite.accountId };
      }
    }

    const account = await tx.account.create({
      data: {
        name: email.split("@")[0] || email,
        status: "active",
        maxAgents: this.defaultMaxAgents,
      },
    });
    await tx.accountMember.create({
      data: { accountId: account.id, email, role: "owner" },
    });
    return { kind: "created", accountId: account.id };
  }
}
