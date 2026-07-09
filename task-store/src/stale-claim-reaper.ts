/**
 * task-store/src/stale-claim-reaper.ts
 *
 * StaleClaimReaper — background job that reclaims stuck in_progress tasks
 * and stuck in_progress PullRequest review records.
 *
 * A record is considered stale when the agent holding it has stopped sending
 * heartbeats. Two cases are handled:
 *   1. heartbeatAt IS NOT NULL and heartbeatAt < cutoff (agent stopped beating)
 *   2. heartbeatAt IS NULL and claimedAt < cutoff (agent claimed but never beat)
 *
 * The cutoff is: clock.now() - ttlMs. Both Task and PullRequest claims use a
 * single unified TTL, defaulting to 2 100 000 ms (35 min) — the 30-minute
 * `claude -p` hard timeout plus a 5-minute buffer — overridable via
 * SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS.
 *
 * Usage: register via setInterval(() => reaper.reap(), 60_000) in main.ts.
 */

import { type Clock, SystemClock } from "./clock.ts";
import type { PrismaClient } from "./index.ts";

const DEFAULT_TTL_MS = 2_100_000;

export class StaleClaimReaper {
  private readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock = SystemClock(),
    ttlMs?: number,
  ) {
    this.ttlMs =
      ttlMs ??
      Number(process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS ?? DEFAULT_TTL_MS);
  }

  /**
   * Bulk-reset stale in_progress Task and PullRequest records back to pending.
   * Returns the total number of records that were reaped (tasks + PRs).
   */
  async reap(): Promise<number> {
    const now = this.clock.now().getTime();
    const cutoff = new Date(now - this.ttlMs).toISOString();

    const tasksAffected = await this.prisma.$executeRaw`
      UPDATE "Task"
      SET status = 'pending',
          "claimedBy" = NULL,
          "claimedAt" = NULL,
          "heartbeatAt" = NULL,
          "startedAt" = NULL,
          "updatedAt" = now()
      WHERE status = 'in_progress'
        AND (
          ("heartbeatAt" IS NOT NULL AND "heartbeatAt" < ${cutoff})
          OR
          ("heartbeatAt" IS NULL AND "claimedAt" IS NOT NULL AND "claimedAt" < ${cutoff})
        )
    `;

    const prsAffected = await this.prisma.$executeRaw`
      UPDATE "PullRequest"
      SET "reviewState" = CASE
            WHEN "phase" = 'review' THEN 'pending'::"PrReviewState"
            ELSE "reviewState"
          END,
          "claimedBy" = NULL,
          "claimedAt" = NULL,
          "heartbeatAt" = NULL,
          "phase" = NULL,
          "updatedAt" = now()
      WHERE "claimedBy" IS NOT NULL
        AND (
          ("heartbeatAt" IS NOT NULL AND "heartbeatAt" < ${cutoff})
          OR
          ("heartbeatAt" IS NULL AND "claimedAt" IS NOT NULL AND "claimedAt" < ${cutoff})
        )
    `;

    const total = tasksAffected + prsAffected;

    if (tasksAffected > 0) {
      console.log(`[stale-claim-reaper] reaped ${tasksAffected} stale task(s)`);
    }
    if (prsAffected > 0) {
      console.log(
        `[stale-claim-reaper] reaped ${prsAffected} stale PR review(s)`,
      );
    }

    return total;
  }
}
