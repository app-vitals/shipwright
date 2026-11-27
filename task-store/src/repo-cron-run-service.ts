/**
 * task-store/src/repo-cron-run-service.ts
 * RepoCronRunService — append-only record of every per-repo system-cron run
 * (PCR-1.1).
 *
 * One row per run; record() always inserts (two runs of the same cron for the
 * same repo are two rows). `machineState` is small non-finding state a cron
 * wants back on its next run (e.g. a Sentry project-to-repo mapping); list()
 * omits it unless `includeDetail` is set, latest() always returns it.
 *
 * Like CoverageSnapshot there is no parent Task/PullRequest: the route
 * resolves `accountId` and passes it in alongside the caller's scope.
 */

import { BadRequestError, ForbiddenError } from "./errors.ts";
import type { PrismaClient, RepoCronRun } from "./index.ts";
import { cursorWhere, decodeCursor, encodeCursor } from "./lib/cursor.ts";
import { isOrgRepo } from "./validate.ts";

/** Caller scope: `accountId: null` = unrestricted (admin). */
export interface RepoCronRunScope {
  /** null = admin (any repo); an array restricts both writes and reads. */
  repos: string[] | null;
  /** null = no account restriction (admin); a string restricts reads to it. */
  accountId: string | null;
}

const UNRESTRICTED_SCOPE: RepoCronRunScope = { repos: null, accountId: null };

export const REPO_CRON_RUN_OUTCOMES = ["ok", "no_op", "failed"] as const;
export type RepoCronRunOutcome = (typeof REPO_CRON_RUN_OUTCOMES)[number];

/** Routing-count keys inside `metrics` that must be non-negative integers. */
const ROUTING_COUNT_KEYS = ["auto", "review", "plan"] as const;

export interface RecordRepoCronRunInput {
  /** Account the row is stamped with (resolved by the route). */
  accountId: string;
  cronId: string;
  repo: string;
  taskId?: string | null;
  /** ISO timestamp of the trigger slot. */
  scheduledFor?: string | null;
  startedAt: string;
  finishedAt: string;
  commitSha: string;
  outcome: string;
  metrics: unknown;
  machineState?: unknown;
}

export interface ListRepoCronRunsOptions {
  cronId?: string;
  repo?: string;
  /** Include `machineState` on each row (omitted by default). */
  includeDetail?: boolean;
  limit?: number;
  /** Opaque keyset cursor on (finishedAt, id), newest first. */
  cursor?: string;
}

export type RepoCronRunSummary = Omit<RepoCronRun, "machineState"> &
  Partial<Pick<RepoCronRun, "machineState">>;

export interface ListRepoCronRunsResult {
  runs: RepoCronRunSummary[];
  total: number;
  /** Cursor for the next page; null on the last page. Route coerces undefined to null. */
  nextCursor?: string | null;
}

/** The subset of RepoCronRunService the routes depend on. */
export interface RepoCronRunServiceLike {
  record(
    data: RecordRepoCronRunInput,
    scope?: RepoCronRunScope,
  ): Promise<RepoCronRun>;
  list(
    opts?: ListRepoCronRunsOptions,
    scope?: RepoCronRunScope,
  ): Promise<ListRepoCronRunsResult>;
  latest(
    cronId: string,
    repo: string,
    scope?: RepoCronRunScope,
  ): Promise<RepoCronRun | null>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseTimestamp(name: string, raw: unknown): Date {
  const d = typeof raw === "string" && raw ? new Date(raw) : null;
  if (!d || Number.isNaN(d.getTime())) {
    throw new BadRequestError(`${name} must be a valid ISO timestamp`);
  }
  return d;
}

function validateMetrics(metrics: unknown): Record<string, number> {
  if (!isPlainObject(metrics)) {
    throw new BadRequestError("metrics must be an object of numbers");
  }
  for (const [k, v] of Object.entries(metrics)) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new BadRequestError(`metrics.${k} must be a finite number`);
    }
  }
  for (const k of ROUTING_COUNT_KEYS) {
    const v = metrics[k];
    if (v !== undefined && !(Number.isInteger(v) && (v as number) >= 0)) {
      throw new BadRequestError(`metrics.${k} must be a non-negative integer`);
    }
  }
  return metrics as Record<string, number>;
}

export class RepoCronRunService implements RepoCronRunServiceLike {
  constructor(private prisma: PrismaClient) {}

  async record(
    data: RecordRepoCronRunInput,
    scope: RepoCronRunScope = UNRESTRICTED_SCOPE,
  ): Promise<RepoCronRun> {
    if (!data.cronId) throw new BadRequestError("cronId is required");
    if (!data.repo || !isOrgRepo(data.repo)) {
      throw new BadRequestError("repo must be in 'owner/repo' form");
    }
    if (!data.commitSha) throw new BadRequestError("commitSha is required");
    if (!(REPO_CRON_RUN_OUTCOMES as readonly string[]).includes(data.outcome)) {
      throw new BadRequestError(
        `outcome must be one of: ${REPO_CRON_RUN_OUTCOMES.join(", ")}`,
      );
    }
    const startedAt = parseTimestamp("startedAt", data.startedAt);
    const finishedAt = parseTimestamp("finishedAt", data.finishedAt);
    const scheduledFor =
      data.scheduledFor === undefined || data.scheduledFor === null
        ? null
        : parseTimestamp("scheduledFor", data.scheduledFor);
    const metrics = validateMetrics(data.metrics);
    if (
      data.machineState !== undefined &&
      data.machineState !== null &&
      !isPlainObject(data.machineState)
    ) {
      throw new BadRequestError("machineState must be an object or null");
    }

    if (scope.repos !== null && !scope.repos.includes(data.repo)) {
      throw new ForbiddenError(`repo '${data.repo}' is not in this scope`);
    }

    return this.prisma.repoCronRun.create({
      data: {
        accountId: data.accountId,
        cronId: data.cronId,
        repo: data.repo,
        taskId: data.taskId || null,
        scheduledFor,
        startedAt,
        finishedAt,
        commitSha: data.commitSha,
        outcome: data.outcome,
        metrics,
        // JSON-null is not a valid nullable input; omit to store SQL NULL.
        ...(data.machineState ? { machineState: data.machineState } : {}),
      } as never,
    });
  }

  async list(
    opts: ListRepoCronRunsOptions = {},
    scope: RepoCronRunScope = UNRESTRICTED_SCOPE,
  ): Promise<ListRepoCronRunsResult> {
    const limit = opts.limit ?? 50;
    if (scope.repos !== null) {
      if (scope.repos.length === 0) return { runs: [], total: 0 };
      if (opts.repo && !scope.repos.includes(opts.repo)) {
        return { runs: [], total: 0 };
      }
    }
    const where = {
      ...(scope.accountId !== null ? { accountId: scope.accountId } : {}),
      ...(scope.repos !== null ? { repo: { in: scope.repos } } : {}),
      ...(opts.repo ? { repo: opts.repo } : {}),
      ...(opts.cronId ? { cronId: opts.cronId } : {}),
    };
    const pageWhere =
      opts.cursor !== undefined
        ? {
            AND: [
              where,
              cursorWhere(decodeCursor(opts.cursor), "desc", "finishedAt"),
            ],
          }
        : where;
    const [fetched, total] = await this.prisma.$transaction([
      this.prisma.repoCronRun.findMany({
        where: pageWhere,
        orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(opts.includeDetail ? {} : { omit: { machineState: true } }),
      }),
      this.prisma.repoCronRun.count({ where }),
    ]);
    const hasMore = fetched.length > limit;
    const runs = hasMore ? fetched.slice(0, limit) : fetched;
    const last = runs[runs.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.finishedAt, id: last.id })
        : null;
    return { runs, total, nextCursor };
  }

  async latest(
    cronId: string,
    repo: string,
    scope: RepoCronRunScope = UNRESTRICTED_SCOPE,
  ): Promise<RepoCronRun | null> {
    if (scope.repos !== null && !scope.repos.includes(repo)) return null;
    return this.prisma.repoCronRun.findFirst({
      where: {
        cronId,
        repo,
        outcome: { in: ["ok", "no_op"] },
        ...(scope.accountId !== null ? { accountId: scope.accountId } : {}),
      },
      orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
    });
  }
}
