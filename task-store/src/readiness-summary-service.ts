/**
 * task-store/src/readiness-summary-service.ts
 * ReadinessSummaryService — the fleet-level agent-readiness roll-up behind
 * GET /readiness/summary (RDY-4.1). Reads ReadinessSnapshot (RDY-1.2) and the
 * system-cron definitions; writes nothing.
 *
 * Definitions:
 *   - "latest" snapshot = newest by measuredAt per repo (ReadinessSnapshotService.latest).
 *   - A repo is stale when its latest snapshot is more than 7 days old. Stale
 *     repos are listed (stale: true) but excluded from percentAtOrAboveFloor,
 *     repoCount and levelDistribution.
 *   - percentAtOrAboveFloor = fresh repos at Level 3+ / fresh repos * 100
 *     (rounded to 1 decimal; null when there are no fresh repos).
 *   - trend = 12 trailing 7-day buckets ending at "now" (oldest first). Each
 *     bucket takes every repo's latest snapshot measured inside it; repos with
 *     no snapshot in the bucket are not counted that week.
 *   - ownerRunning (per failing check) = the owner is "operator", or the owner
 *     id is an enabled system cron in the snapshot's account whose repo scope
 *     is "all" or includes the repo.
 */

import { type Clock, SystemClock } from "./clock.ts";
import type { PrismaClient, SystemCronDefinition } from "./index.ts";
import {
  type ReadinessSnapshotScope,
  ReadinessSnapshotService,
} from "./readiness-snapshot-service.ts";
import type { SystemCronServiceLike } from "./system-cron-service.ts";

/** Level at/above which a repo counts as "agent-ready". */
export const READINESS_FLOOR_LEVEL = 3;
/** A latest snapshot older than this is stale. */
export const READINESS_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const READINESS_TREND_WEEKS = 12;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Owner that is not a system cron and is always considered running. */
export const OPERATOR_OWNER = "operator";

export interface ReadinessSummaryFailingCheck {
  id: string;
  level: number;
  owner: string;
  ownerRunning: boolean;
}

export interface ReadinessSummaryRepo {
  repo: string;
  level: number;
  failingChecks: ReadinessSummaryFailingCheck[];
  scoredAt: string;
  stale: boolean;
}

export interface ReadinessSummaryTrendPoint {
  /** ISO start of the 7-day bucket (inclusive). */
  weekStart: string;
  /** ISO end of the bucket (exclusive). */
  weekEnd: string;
  percentAtOrAboveFloor: number | null;
  repoCount: number;
}

export interface ReadinessSummary {
  percentAtOrAboveFloor: number | null;
  repoCount: number;
  staleCount: number;
  levelDistribution: Record<"0" | "1" | "2" | "3" | "4" | "5", number>;
  repos: ReadinessSummaryRepo[];
  trend: ReadinessSummaryTrendPoint[];
}

export interface ReadinessSummaryServiceLike {
  summary(scope: ReadinessSnapshotScope): Promise<ReadinessSummary>;
}

function pct(atFloor: number, total: number): number | null {
  return total === 0 ? null : Math.round((atFloor / total) * 1000) / 10;
}

export class ReadinessSummaryService implements ReadinessSummaryServiceLike {
  private snapshots: ReadinessSnapshotService;

  constructor(
    private prisma: PrismaClient,
    private systemCrons: SystemCronServiceLike,
    private clock: Clock = SystemClock(),
  ) {
    this.snapshots = new ReadinessSnapshotService(prisma, clock);
  }

  async summary(scope: ReadinessSnapshotScope): Promise<ReadinessSummary> {
    const now = this.clock.now();
    const nowMs = now.getTime();
    const trendStartMs = nowMs - READINESS_TREND_WEEKS * WEEK_MS;

    const emptyScope = scope.repos !== null && scope.repos.length === 0;
    const [latest, crons, window] = emptyScope
      ? [[], [], []]
      : await Promise.all([
          this.snapshots.latest(scope),
          this.systemCrons.list({ accountId: scope.accountId }),
          this.prisma.readinessSnapshot.findMany({
            where: {
              ...(scope.accountId !== null
                ? { accountId: scope.accountId }
                : {}),
              ...(scope.repos !== null ? { repo: { in: scope.repos } } : {}),
              measuredAt: { gte: new Date(trendStartMs) },
            },
            select: { repo: true, level: true, measuredAt: true },
          }),
        ]);

    const cronsByKey = new Map<string, SystemCronDefinition>();
    for (const cron of crons)
      cronsByKey.set(`${cron.accountId}|${cron.id}`, cron);

    const ownerRunning = (
      accountId: string,
      repo: string,
      owner: string,
    ): boolean => {
      if (owner === OPERATOR_OWNER) return true;
      const cron = cronsByKey.get(`${accountId}|${owner}`);
      if (!cron?.enabled) return false;
      return cron.repoScope === "all" || cron.repos.includes(repo);
    };

    const levelDistribution = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<
      number,
      number
    >;
    let fresh = 0;
    let atFloor = 0;
    let staleCount = 0;
    const repos: ReadinessSummaryRepo[] = latest.map((s) => {
      const stale = nowMs - s.measuredAt.getTime() > READINESS_STALE_MS;
      if (stale) {
        staleCount += 1;
      } else {
        fresh += 1;
        levelDistribution[s.level] = (levelDistribution[s.level] ?? 0) + 1;
        if (s.level >= READINESS_FLOOR_LEVEL) atFloor += 1;
      }
      const checks = s.checks as {
        id: string;
        level: number;
        result: string;
        owner: string;
      }[];
      return {
        repo: s.repo,
        level: s.level,
        failingChecks: checks
          .filter((c) => c.result === "fail")
          .map((c) => ({
            id: c.id,
            level: c.level,
            owner: c.owner,
            ownerRunning: ownerRunning(s.accountId, s.repo, c.owner),
          })),
        scoredAt: s.measuredAt.toISOString(),
        stale,
      };
    });

    // Trend: bucket i (0 = oldest) covers [start+i*week, start+(i+1)*week).
    const trend: ReadinessSummaryTrendPoint[] = [];
    for (let i = 0; i < READINESS_TREND_WEEKS; i++) {
      const from = trendStartMs + i * WEEK_MS;
      const to = from + WEEK_MS;
      const newestPerRepo = new Map<string, { level: number; at: number }>();
      for (const row of window) {
        const at = row.measuredAt.getTime();
        // The final bucket also includes `now` itself.
        if (at < from || at >= to + (i === READINESS_TREND_WEEKS - 1 ? 1 : 0)) {
          continue;
        }
        const prev = newestPerRepo.get(row.repo);
        if (!prev || at > prev.at) {
          newestPerRepo.set(row.repo, { level: row.level, at });
        }
      }
      const levels = [...newestPerRepo.values()];
      trend.push({
        weekStart: new Date(from).toISOString(),
        weekEnd: new Date(to).toISOString(),
        percentAtOrAboveFloor: pct(
          levels.filter((l) => l.level >= READINESS_FLOOR_LEVEL).length,
          levels.length,
        ),
        repoCount: levels.length,
      });
    }

    return {
      percentAtOrAboveFloor: pct(atFloor, fresh),
      repoCount: fresh,
      staleCount,
      levelDistribution: {
        "0": levelDistribution[0] ?? 0,
        "1": levelDistribution[1] ?? 0,
        "2": levelDistribution[2] ?? 0,
        "3": levelDistribution[3] ?? 0,
        "4": levelDistribution[4] ?? 0,
        "5": levelDistribution[5] ?? 0,
      },
      repos,
      trend,
    };
  }
}
