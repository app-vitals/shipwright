/**
 * task-store/src/readiness-snapshot-service.ts
 * ReadinessSnapshotService — stores and reads agent-readiness snapshots
 * (RDY-1.2). Modelled on CoverageSnapshotService.
 *
 * One row per (accountId, repo, commitSha). record() is an upsert: the first
 * write for a commit creates the row, a repeat write replaces its measurements
 * in place. Like CoverageSnapshot there is no parent Task/PullRequest: the
 * route resolves `accountId` (agent token → its own account; admin → the
 * request's accountId) and passes it in.
 */

import { z } from "zod";
import { type Clock, SystemClock } from "./clock.ts";
import { BadRequestError, ForbiddenError } from "./errors.ts";
import type { PrismaClient, ReadinessSnapshot } from "./index.ts";
import { cursorWhere, decodeCursor, encodeCursor } from "./lib/cursor.ts";
import { ReadinessCheckResultSchema } from "./openapi-schemas.ts";
import { isOrgRepo } from "./validate.ts";

/** Caller scope: `accountId: null` = unrestricted (admin). */
export interface ReadinessSnapshotScope {
  /** null = admin (any repo); an array restricts both writes and reads. */
  repos: string[] | null;
  /** null = no account restriction (admin); a string restricts reads to it. */
  accountId: string | null;
}

const UNRESTRICTED_SCOPE: ReadinessSnapshotScope = {
  repos: null,
  accountId: null,
};

const ChecksSchema = z.array(ReadinessCheckResultSchema);

export interface RecordReadinessSnapshotInput {
  /** Account the row is stamped with (resolved by the route). */
  accountId: string;
  repo: string;
  commitSha: string;
  level: number;
  passing: number;
  failing: number;
  /** Validated against ReadinessCheckResultSchema[]. */
  checks: unknown;
  catalogueVersion: string;
  /** ISO timestamp. Defaults to the service's Clock.now() when omitted. */
  measuredAt?: string;
}

export interface ListReadinessSnapshotsOptions {
  repo?: string;
  /** ISO timestamp; only snapshots measured at or after it. */
  since?: string;
  limit?: number;
  /** Opaque keyset cursor on (measuredAt, id), newest first. */
  cursor?: string;
}

export interface ListReadinessSnapshotsResult {
  snapshots: ReadinessSnapshot[];
  total: number;
  /** Cursor for the next page; null on the last page. Route coerces undefined to null. */
  nextCursor?: string | null;
}

export interface RecordReadinessSnapshotResult {
  snapshot: ReadinessSnapshot;
  created: boolean;
}

/** The subset of ReadinessSnapshotService the routes depend on. */
export interface ReadinessSnapshotServiceLike {
  record(
    data: RecordReadinessSnapshotInput,
    scope?: ReadinessSnapshotScope,
  ): Promise<RecordReadinessSnapshotResult>;
  list(
    opts?: ListReadinessSnapshotsOptions,
    scope?: ReadinessSnapshotScope,
  ): Promise<ListReadinessSnapshotsResult>;
  /** Newest snapshot per repo, or just `repo`'s newest when given. */
  latest(
    scope?: ReadinessSnapshotScope,
    repo?: string,
  ): Promise<ReadinessSnapshot[]>;
}

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

export class ReadinessSnapshotService implements ReadinessSnapshotServiceLike {
  constructor(
    private prisma: PrismaClient,
    private clock: Clock = SystemClock(),
  ) {}

  async record(
    data: RecordReadinessSnapshotInput,
    scope: ReadinessSnapshotScope = UNRESTRICTED_SCOPE,
  ): Promise<RecordReadinessSnapshotResult> {
    if (!data.repo || !isOrgRepo(data.repo)) {
      throw new BadRequestError("repo must be in 'owner/repo' form");
    }
    if (!data.commitSha) {
      throw new BadRequestError("commitSha is required");
    }
    if (!data.catalogueVersion) {
      throw new BadRequestError("catalogueVersion is required");
    }
    if (
      typeof data.level !== "number" ||
      !Number.isInteger(data.level) ||
      data.level < 0 ||
      data.level > 5
    ) {
      throw new BadRequestError("level must be an integer from 0 to 5");
    }
    if (!isCount(data.passing) || !isCount(data.failing)) {
      throw new BadRequestError(
        "passing and failing must be non-negative integers",
      );
    }
    const parsedChecks = ChecksSchema.safeParse(data.checks);
    if (!parsedChecks.success) {
      throw new BadRequestError(
        `checks must be an array of {id, level, result, owner}: ${parsedChecks.error.issues[0]?.message ?? "invalid"}`,
      );
    }

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
      level: data.level,
      passing: data.passing,
      failing: data.failing,
      checks: parsedChecks.data,
      catalogueVersion: data.catalogueVersion,
      measuredAt,
    };
    const key = {
      accountId: data.accountId,
      repo: data.repo,
      commitSha: data.commitSha,
    };
    // The upsert owns the write, so concurrent first POSTs for one key can't
    // race into a unique-constraint 500. The pre-read only decides `created`.
    const existing = await this.prisma.readinessSnapshot.findUnique({
      where: { accountId_repo_commitSha: key },
      select: { id: true },
    });
    const snapshot = await this.prisma.readinessSnapshot.upsert({
      where: { accountId_repo_commitSha: key },
      create: { ...key, ...fields },
      update: fields,
    });
    return { snapshot, created: !existing };
  }

  async list(
    opts: ListReadinessSnapshotsOptions = {},
    scope: ReadinessSnapshotScope = UNRESTRICTED_SCOPE,
  ): Promise<ListReadinessSnapshotsResult> {
    const limit = opts.limit ?? 50;
    // An empty repo scope can see nothing; an out-of-scope ?repo= likewise
    // returns empty (mirrors coverage-snapshots).
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
      this.prisma.readinessSnapshot.findMany({
        where: pageWhere,
        orderBy: [{ measuredAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      }),
      this.prisma.readinessSnapshot.count({ where }),
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
    scope: ReadinessSnapshotScope = UNRESTRICTED_SCOPE,
    repo?: string,
  ): Promise<ReadinessSnapshot[]> {
    if (scope.repos !== null) {
      if (scope.repos.length === 0) return [];
      if (repo && !scope.repos.includes(repo)) {
        throw new ForbiddenError(`repo '${repo}' is not in this scope`);
      }
    }
    return this.prisma.readinessSnapshot.findMany({
      where: {
        ...(scope.accountId !== null ? { accountId: scope.accountId } : {}),
        ...(scope.repos !== null ? { repo: { in: scope.repos } } : {}),
        ...(repo ? { repo } : {}),
      },
      // distinct keeps the first row per repo in the given order → newest.
      orderBy: [{ repo: "asc" }, { measuredAt: "desc" }],
      distinct: ["repo"],
    });
  }
}
