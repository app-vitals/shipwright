/**
 * task-store/src/session-retention-reaper.ts
 *
 * SessionRetentionReaper — background job that archives inactive Session rows
 * (SESH-8.1). Mirrors StaleClaimReaper's shape (constructor reads its
 * threshold from an env var with a documented default, exposes the resolved
 * value as a readonly field, does one sweep per call) but is registered on a
 * 1-hour interval in main.ts rather than StaleClaimReaper's 60s interval —
 * session archival is a low-urgency housekeeping pass, not a liveness check.
 *
 * Archive rule — a Session row is archived when ALL of:
 *   1. it is not already archived (`archivedAt IS NULL`)
 *   2. every one of its tasks is terminal (`counts.open === 0`)
 *   3. it has at least one task ever (`counts.total > 0` — an empty/phantom
 *      session with zero tasks is never archived)
 *   4. its last task activity is older than `archiveAfterDays` days
 *      (`lastActivityAt < now - archiveAfterDays`)
 * On archive: `archivedAt = now`, `archivedBy = "system"`.
 *
 * Archiving is non-destructive and reversible — SessionService.upsert()
 * un-archives a session (sets `archivedAt: null`) the moment a new task is
 * written into it (SES-1.2). This reaper only ever archives; purge is cut
 * from scope entirely (see PLAN.md) and never deletes a Session or its Tasks.
 *
 * ─── Design choice: typed Prisma queries + computeSessionRollup, not raw SQL ──
 * Task.session is a free-text field (not a FK) matching Session.slug, and
 * Task.status is a Postgres enum while Task.updatedAt is a real `timestamptz`
 * column (unlike StaleClaimReaper's claim fields, which are plain String
 * columns holding ISO text — a lexicographic string compare is sufficient
 * there but not applicable here). Hand-rolling a raw-SQL aggregate would mean
 * getting enum-list and timestamp parameter binding exactly right with no
 * existing precedent in this codebase to copy. `computeSessionRollup` (see
 * ./session-rollup.ts) already implements and unit-tests the exact
 * open/total/lastActivityAt computation this reaper needs — reusing it via
 * Prisma's typed `findMany` is simpler and safer than re-deriving the same
 * logic in raw SQL, at the cost of one query per candidate session rather
 * than a single bulk statement. Given this sweep runs hourly against a
 * background housekeeping table (not a hot path), that cost is acceptable.
 *
 * ─── Design choice: per-session loop with try/catch, not a bulk UPDATE ───────
 * sweep() loops over non-archived sessions one at a time, computing each
 * one's rollup and issuing its own conditional `session.update()`. Each
 * iteration is wrapped in its own try/catch so one session that fails to
 * process (a bad row, an unexpected query error) is logged and skipped
 * rather than aborting the whole sweep — the remaining candidates in the
 * same sweep() call still get evaluated and archived normally. This mirrors
 * how main.ts already wraps StaleClaimReaper's `.reap()` call in `.catch()`,
 * just at per-row granularity instead of per-interval-tick granularity.
 *
 * Usage: register via setInterval(() => reaper.sweep(), 3_600_000) in main.ts.
 */

import { type Clock, SystemClock } from "./clock.ts";
import type { PrismaClient } from "./index.ts";
import { computeSessionRollup } from "./session-rollup.ts";
import type { SessionService } from "./session-service.ts";

const DEFAULT_ARCHIVE_AFTER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionRetentionReaperOptions {
  archiveAfterDays?: number;
}

export class SessionRetentionReaper {
  /** The resolved archive threshold (days), read once at construction.
   * `0` disables the sweep entirely — see sweep() below. */
  readonly archiveAfterDays: number;

  constructor(
    private readonly prisma: PrismaClient,
    // Accepted per the SESH-8.1 constructor contract, but sweep() below
    // performs its own direct Prisma reads/writes against Session rather
    // than going through SessionService — SessionService today only exposes
    // upsert() (an un-archive-on-write hook, SES-1.2), which isn't the
    // operation this reaper needs. Kept as a constructor parameter (not
    // read) so callers/tests can construct this the same way main.ts does,
    // and so a future SessionService.archive()-style method can be adopted
    // here without a constructor signature change.
    private readonly sessionService: SessionService,
    private readonly clock: Clock = SystemClock(),
    opts?: SessionRetentionReaperOptions,
  ) {
    void this.sessionService;
    this.archiveAfterDays =
      opts?.archiveAfterDays ??
      Number(
        process.env.SHIPWRIGHT_TASK_STORE_SESSION_ARCHIVE_AFTER_DAYS ??
          DEFAULT_ARCHIVE_AFTER_DAYS,
      );
  }

  /**
   * Archive every non-archived session whose tasks are all terminal and
   * whose last task activity is older than `archiveAfterDays` days. Returns
   * the number of sessions archived.
   *
   * `archiveAfterDays === 0` disables the sweep: it returns 0 immediately
   * without touching the database, rather than registering a threshold that
   * would (mathematically) match nearly every closed session on every run.
   */
  async sweep(): Promise<number> {
    if (this.archiveAfterDays === 0) return 0;

    const now = this.clock.now();
    const cutoffMs = now.getTime() - this.archiveAfterDays * DAY_MS;

    const candidates = await this.prisma.session.findMany({
      where: { archivedAt: null },
    });

    let archivedCount = 0;

    for (const session of candidates) {
      try {
        const tasks = await this.prisma.task.findMany({
          where: { session: session.slug },
        });

        const rollup = computeSessionRollup(tasks, new Set(), this.clock);

        const isStale =
          rollup.counts.total > 0 &&
          rollup.counts.open === 0 &&
          rollup.lastActivityAt !== null &&
          new Date(rollup.lastActivityAt).getTime() < cutoffMs;

        if (!isStale) continue;

        await this.prisma.session.update({
          where: { slug: session.slug },
          data: { archivedAt: now, archivedBy: "system" },
        });

        archivedCount++;
        console.log(
          `[session-retention-reaper] archived session "${session.slug}" (last activity ${rollup.lastActivityAt})`,
        );
      } catch (err) {
        console.error(
          `[session-retention-reaper] failed to process session "${session.slug}":`,
          err,
        );
      }
    }

    return archivedCount;
  }
}
