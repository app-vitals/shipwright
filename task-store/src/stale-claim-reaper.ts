/**
 * task-store/src/stale-claim-reaper.ts
 *
 * StaleClaimReaper — background job that reclaims stuck in_progress tasks.
 *
 * A task is considered stale when the agent holding it has stopped sending
 * heartbeats. Two cases are handled:
 *   1. heartbeatAt IS NOT NULL and heartbeatAt < cutoff (agent stopped beating)
 *   2. heartbeatAt IS NULL and claimedAt < cutoff (agent claimed but never beat)
 *
 * The cutoff is: clock.now() - ttlMs.
 * Default TTL: 300 000 ms (5 min), overridable via SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS.
 *
 * Usage: register via setInterval(() => reaper.reap(), 60_000) in main.ts.
 */

import type { Clock } from "./clock.ts";
import { SystemClock } from "./clock.ts";
import type { PrismaClient } from "./index.ts";

const DEFAULT_TTL_MS = 300_000;

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
   * Bulk-reset stale in_progress tasks back to pending.
   * Returns the number of tasks that were reaped.
   */
  async reap(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - this.ttlMs).toISOString();

    const affected = await this.prisma.$executeRaw`
      UPDATE "Task"
      SET status = 'pending',
          "claimedBy" = NULL,
          "claimedAt" = NULL,
          "heartbeatAt" = NULL,
          "updatedAt" = now()
      WHERE status = 'in_progress'
        AND (
          ("heartbeatAt" IS NOT NULL AND "heartbeatAt" < ${cutoff})
          OR
          ("heartbeatAt" IS NULL AND "claimedAt" IS NOT NULL AND "claimedAt" < ${cutoff})
        )
    `;

    if (affected > 0) {
      console.log(`[stale-claim-reaper] reaped ${affected} stale task(s)`);
    }

    return affected;
  }
}
