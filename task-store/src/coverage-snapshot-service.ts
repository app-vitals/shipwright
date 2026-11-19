/**
 * task-store/src/coverage-snapshot-service.ts
 * CoverageSnapshotService — stores and reads measured test-coverage snapshots
 * (CVT-2.1).
 *
 * One row per (accountId, repo, commitSha). record() is an upsert: the first
 * write for a commit creates the row, a repeat write replaces its measurements
 * in place. The percentages are always computed here from the covered/total
 * counts — callers never supply them, so a stored pct can't disagree with its
 * counts.
 *
 * Unlike VerificationCheck, a snapshot has no parent Task/PullRequest to take
 * an account from: the route resolves `accountId` (agent token → its own
 * account; admin → the request's accountId) and passes it in.
 */

import { type Clock, SystemClock } from "./clock.ts";
import { BadRequestError, ForbiddenError } from "./errors.ts";
import type { CoverageSnapshot, PrismaClient } from "./index.ts";
import { cursorWhere, decodeCursor, encodeCursor } from "./lib/cursor.ts";
import { isOrgRepo } from "./validate.ts";

/** Caller scope: `accountId: null` = unrestricted (admin). */
export interface CoverageSnapshotScope {
  /** null = admin (any repo); an array restricts both writes and reads. */
  repos: string[] | null;
  /** null = no account restriction (admin); a string restricts reads to it. */
  accountId: string | null;
}

const UNRESTRICTED_SCOPE: CoverageSnapshotScope = {
  repos: null,
  accountId: null,
};

export interface RecordCoverageSnapshotInput {
  /** Account the row is stamped with (resolved by the route). */
  accountId: string;
  repo: string;
  branch: string;
  commitSha: string;
  linesCovered: number;
  linesTotal: number;
  branchesCovered?: number | null;
  branchesTotal?: number | null;
  functionsCovered?: number | null;
  functionsTotal?: number | null;
  tool: string;
  runUrl?: string | null;
  /** ISO timestamp. Defaults to the service's Clock.now() when omitted. */
  measuredAt?: string;
}

export interface ListCoverageSnapshotsOptions {
  repo?: string;
  /** ISO timestamp; only snapshots measured at or after it. */
  since?: string;
  limit?: number;
  offset?: number;
  /** Opaque keyset cursor on (measuredAt, id), newest first. Mutually exclusive with `offset`. */
  cursor?: string;
}

export interface ListCoverageSnapshotsResult {
  snapshots: CoverageSnapshot[];
  total: number;
  /** Cursor for the next page; null on the last page. Route coerces undefined to null. */
  nextCursor?: string | null;
}

export interface RecordCoverageSnapshotResult {
  snapshot: CoverageSnapshot;
  created: boolean;
}

/** The subset of CoverageSnapshotService the routes depend on. */
export interface CoverageSnapshotServiceLike {
  record(
    data: RecordCoverageSnapshotInput,
    scope?: CoverageSnapshotScope,
  ): Promise<RecordCoverageSnapshotResult>;
  list(
    opts?: ListCoverageSnapshotsOptions,
    scope?: CoverageSnapshotScope,
  ): Promise<ListCoverageSnapshotsResult>;
  latest(scope?: CoverageSnapshotScope): Promise<CoverageSnapshot[]>;
}

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/**
 * Validates an optional covered/total pair and returns its three stored
 * values. Both halves must be given together; covered must not exceed total.
 * A zero total is allowed for the optional pairs (nothing to measure) and has
 * no meaningful percentage, so pct is null there.
 */
function optionalPair(
  name: string,
  covered: number | null | undefined,
  total: number | null | undefined,
): { covered: number | null; total: number | null; pct: number | null } {
  const hasCovered = covered !== undefined && covered !== null;
  const hasTotal = total !== undefined && total !== null;
  if (!hasCovered && !hasTotal)
    return { covered: null, total: null, pct: null };
  if (hasCovered !== hasTotal) {
    throw new BadRequestError(
      `${name}Covered and ${name}Total must be supplied together`,
    );
  }
  if (!isCount(covered) || !isCount(total)) {
    throw new BadRequestError(
      `${name}Covered and ${name}Total must be non-negative integers`,
    );
  }
  if (covered > total) {
    throw new BadRequestError(
      `${name}Covered (${covered}) must not exceed ${name}Total (${total})`,
    );
  }
  return { covered, total, pct: total > 0 ? (covered / total) * 100 : null };
}

export class CoverageSnapshotService implements CoverageSnapshotServiceLike {
  constructor(
    private prisma: PrismaClient,
    private clock: Clock = SystemClock(),
  ) {}

  async record(
    data: RecordCoverageSnapshotInput,
    scope: CoverageSnapshotScope = UNRESTRICTED_SCOPE,
  ): Promise<RecordCoverageSnapshotResult> {
    if (!data.repo || !isOrgRepo(data.repo)) {
      throw new BadRequestError("repo must be in 'owner/repo' form");
    }
    if (!data.commitSha) {
      throw new BadRequestError("commitSha is required");
    }
    if (!data.branch) {
      throw new BadRequestError("branch is required");
    }
    if (!data.tool) {
      throw new BadRequestError("tool is required");
    }
    if (!isCount(data.linesCovered) || !isCount(data.linesTotal)) {
      throw new BadRequestError(
        "linesCovered and linesTotal must be non-negative integers",
      );
    }
    if (data.linesTotal <= 0) {
      throw new BadRequestError("linesTotal must be greater than 0");
    }
    if (data.linesCovered > data.linesTotal) {
      throw new BadRequestError(
        `linesCovered (${data.linesCovered}) must not exceed linesTotal (${data.linesTotal})`,
      );
    }
    const branches = optionalPair(
      "branches",
      data.branchesCovered,
      data.branchesTotal,
    );
    const functions = optionalPair(
      "functions",
      data.functionsCovered,
      data.functionsTotal,
    );

    const measuredAt = data.measuredAt
      ? new Date(data.measuredAt)
      : this.clock.now();
    if (Number.isNaN(measuredAt.getTime())) {
      throw new BadRequestError("measuredAt must be a valid ISO timestamp");
    }

    if (scope.repos !== null && !scope.repos.includes(data.repo)) {
      throw new ForbiddenError(`repo '${data.repo}' is not in this scope`);
    }

    const fields = {
      branch: data.branch,
      linesCovered: data.linesCovered,
      linesTotal: data.linesTotal,
      linesPct: (data.linesCovered / data.linesTotal) * 100,
      branchesCovered: branches.covered,
      branchesTotal: branches.total,
      branchesPct: branches.pct,
      functionsCovered: functions.covered,
      functionsTotal: functions.total,
      functionsPct: functions.pct,
      tool: data.tool,
      runUrl: data.runUrl || null,
      measuredAt,
    };

    const key = {
      accountId: data.accountId,
      repo: data.repo,
      commitSha: data.commitSha,
    };
    // The upsert owns the write, so concurrent first POSTs for one key can't
    // race into a unique-constraint 500. The pre-read only decides `created`.
    const existing = await this.prisma.coverageSnapshot.findUnique({
      where: { accountId_repo_commitSha: key },
      select: { id: true },
    });
    const snapshot = await this.prisma.coverageSnapshot.upsert({
      where: { accountId_repo_commitSha: key },
      create: { ...key, ...fields },
      update: fields,
    });
    return { snapshot, created: !existing };
  }

  async list(
    opts: ListCoverageSnapshotsOptions = {},
    scope: CoverageSnapshotScope = UNRESTRICTED_SCOPE,
  ): Promise<ListCoverageSnapshotsResult> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    // An empty repo scope can see nothing; an out-of-scope ?repo= likewise
    // returns empty (mirrors verification-checks).
    if (scope.repos !== null) {
      if (scope.repos.length === 0) return { snapshots: [], total: 0 };
      if (opts.repo && !scope.repos.includes(opts.repo)) {
        return { snapshots: [], total: 0 };
      }
    }
    const where = {
      ...(scope.accountId !== null ? { accountId: scope.accountId } : {}),
      ...(scope.repos !== null ? { repo: { in: scope.repos } } : {}),
      ...(opts.repo ? { repo: opts.repo } : {}),
      ...(opts.since ? { measuredAt: { gte: new Date(opts.since) } } : {}),
    };
    if (opts.cursor !== undefined && opts.offset) {
      throw new BadRequestError("cursor and offset are mutually exclusive");
    }
    const pageWhere =
      opts.cursor !== undefined
        ? {
            AND: [
              where,
              cursorWhere(decodeCursor(opts.cursor), "desc", "measuredAt"),
            ],
          }
        : where;
    // Fetch limit+1 rows to learn whether another page exists.
    const [fetched, total] = await this.prisma.$transaction([
      this.prisma.coverageSnapshot.findMany({
        where: pageWhere,
        orderBy: [{ measuredAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        skip: offset,
      }),
      this.prisma.coverageSnapshot.count({ where }),
    ]);
    const hasMore = fetched.length > limit;
    const snapshots = hasMore ? fetched.slice(0, limit) : fetched;
    const last = snapshots[snapshots.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.measuredAt, id: last.id })
        : null;
    return { snapshots, total, nextCursor };
  }

  async latest(
    scope: CoverageSnapshotScope = UNRESTRICTED_SCOPE,
  ): Promise<CoverageSnapshot[]> {
    if (scope.repos !== null && scope.repos.length === 0) return [];
    return this.prisma.coverageSnapshot.findMany({
      where: {
        ...(scope.accountId !== null ? { accountId: scope.accountId } : {}),
        ...(scope.repos !== null ? { repo: { in: scope.repos } } : {}),
      },
      // distinct keeps the first row per repo in the given order → newest.
      orderBy: [{ repo: "asc" }, { measuredAt: "desc" }],
      distinct: ["repo"],
    });
  }
}
