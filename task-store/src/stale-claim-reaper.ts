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
 * single unified TTL, derived from the shared DEFAULT_CLAIM_TTL_MS constant
 * in @shipwright/lib/claim-ttl (which combines the 1-hour `claude -p` hard
 * ceiling timeout plus a 5-minute buffer) — overridable via
 * SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS.
 *
 * Usage: register via setInterval(() => reaper.reap(), 60_000) in main.ts.
 */

import { DEFAULT_CLAIM_TTL_MS } from "@shipwright/lib/claim-ttl";
import { type Clock, SystemClock } from "./clock.ts";
import type { PrismaClient, Task } from "./index.ts";
import { writeTaskEvents } from "./task-transition-diff.ts";

/**
 * The columns the reap UPDATE's RETURNING clause reports — the only columns
 * that can possibly have changed, since the SET clause touches nothing else.
 */
interface ReapedTaskRow {
  id: string;
  status: Task["status"];
  claimedBy: Task["claimedBy"];
  claimedAt: Task["claimedAt"];
  heartbeatAt: Task["heartbeatAt"];
  startedAt: Task["startedAt"];
}

export class StaleClaimReaper {
  /** The resolved claim TTL (ms), read once at construction. Exposed so
   * startup code (main.ts) can validate it against other configured
   * timeouts — see `checkClaimTtlBuffer` in ./claim-ttl-buffer-check.ts. */
  readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock = SystemClock(),
    ttlMs?: number,
  ) {
    this.ttlMs =
      ttlMs ??
      Number(
        process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS ?? DEFAULT_CLAIM_TTL_MS,
      );
  }

  /**
   * Bulk-reset stale in_progress Task and PullRequest records back to pending.
   * Returns the total number of records that were reaped (tasks + PRs).
   *
   * The Task branch additionally writes a TaskEvent audit row per changed
   * field per reaped task (TCS-1.3) — a reap is exactly the kind of
   * transition the audit trail exists to make visible. `$executeRaw`'s bulk
   * UPDATE alone doesn't report which rows it touched or their prior values,
   * so this runs as: pre-select the candidate rows (captures "before"),
   * `UPDATE ... RETURNING` the same rows (captures "after"), then diff each
   * before/after pair via the shared `writeTaskEvents` helper — the same
   * diff+write path TaskService's claim()/complete()/etc. use. All three
   * steps run inside one `$transaction` so no row can be claimed or change
   * shape between the pre-select and the update.
   */
  async reap(): Promise<number> {
    const now = this.clock.now().getTime();
    const cutoff = new Date(now - this.ttlMs).toISOString();
    const at = this.clock.now().toISOString();

    const tasksAffected = await this.prisma.$transaction(async (tx) => {
      const staleTasks = await tx.task.findMany({
        where: {
          status: "in_progress",
          OR: [
            { heartbeatAt: { not: null, lt: cutoff } },
            { heartbeatAt: null, claimedAt: { not: null, lt: cutoff } },
          ],
        },
      });

      if (staleTasks.length === 0) return 0;

      const beforeById = new Map<string, Task>(
        staleTasks.map((task) => [task.id, task]),
      );

      const reapedTasks = await tx.$queryRaw<ReapedTaskRow[]>`
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
        RETURNING id, status, "claimedBy", "claimedAt", "heartbeatAt", "startedAt"
      `;

      for (const returned of reapedTasks) {
        const before = beforeById.get(returned.id) ?? null;
        // RETURNING only reports the 5 SET columns, not the full Task shape —
        // computeTaskTransitionDiff diffs every TASK_AUDITED_FIELDS entry, so
        // feeding it a bare `returned` would read `undefined` for every other
        // field and misreport them as changed. Overlay the returned columns
        // onto the full `before` row instead: every untouched field then
        // compares equal (before vs before), and only the columns the UPDATE
        // actually SET can produce a diff.
        const after: Task = before
          ? { ...before, ...returned }
          : ({ ...returned } as Task);
        await writeTaskEvents(tx, before, after, "reap", null, at);
      }

      return reapedTasks.length;
    });

    // A stale PR claim always releases its claim fields, but reviewState only
    // regresses to 'pending' when it is still 'pending'/'in_progress' (an
    // unfinished review). A record already at 'posted'/'approved' keeps its
    // reviewState — regressing it there re-dispatches a duplicate review
    // (app-vitals/shipwright#1016).
    const prsAffected = await this.prisma.$executeRaw`
      UPDATE "PullRequest"
      SET "reviewState" = CASE
            WHEN "reviewState" IN ('pending', 'in_progress')
              THEN 'pending'::"PrReviewState"
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
