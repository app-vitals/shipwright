/**
 * task-store/src/patrol-finding-service.ts
 * PatrolFindingService — cross-run ledger of patrol scan findings (PCR-1.2).
 *
 * One row per distinct finding keyed by (accountId, cronId, repo, fingerprint).
 * upsertBatch() creates new findings and, for continued ones, bumps
 * `occurrenceCount` / `lastSeen`, updates `status` and APPENDS to `history`
 * (earlier entries are never rewritten). Each batch carries an `observedAt`
 * (the scan's timestamp); a finding whose `lastSeen` is already >= that
 * timestamp is a replay of the same observation and is left untouched, so
 * repeating an identical upsert cannot inflate counts or duplicate history.
 *
 * Like RepoCronRun there is no parent Task/PullRequest: the route resolves
 * `accountId` and passes it in alongside the caller's scope.
 */

import { BadRequestError, ForbiddenError } from "./errors.ts";
import type { PatrolFinding, PrismaClient } from "./index.ts";
import { cursorWhere, decodeCursor, encodeCursor } from "./lib/cursor.ts";
import { isOrgRepo } from "./validate.ts";

/** Caller scope: `accountId: null` = unrestricted (admin). */
export interface PatrolFindingScope {
  /** null = admin (any repo); an array restricts both writes and reads. */
  repos: string[] | null;
  /** null = no account restriction (admin); a string restricts to it. */
  accountId: string | null;
}

const UNRESTRICTED_SCOPE: PatrolFindingScope = { repos: null, accountId: null };

export const PATROL_FINDING_STATUSES = [
  "tracking",
  "ready_to_propose",
  "open",
  "resolved",
  "suppressed",
] as const;
export type PatrolFindingStatus = (typeof PATROL_FINDING_STATUSES)[number];

export const MAX_PATROL_FINDING_BATCH = 500;

export interface PatrolFindingHistoryEntry {
  at: string;
  status: string;
  occurrenceCount: number;
}

export interface PatrolFindingInput {
  fingerprint: string;
  status: string;
  /** Patrol-specific fields; omitted on a continued finding = keep existing. */
  detail?: unknown;
  /** Fix task id once filed; omitted = keep existing. */
  taskId?: string | null;
}

export interface UpsertPatrolFindingsInput {
  /** Account the rows are stamped with (resolved by the route). */
  accountId: string;
  cronId: string;
  repo: string;
  /** ISO timestamp of the scan observing these findings (default: now). */
  observedAt?: string;
  findings: PatrolFindingInput[];
}

export interface ListPatrolFindingsOptions {
  cronId?: string;
  repo?: string;
  status?: string;
  limit?: number;
  /** Opaque keyset cursor on (lastSeen, id), newest first. */
  cursor?: string;
}

export interface ListPatrolFindingsResult {
  findings: PatrolFinding[];
  total: number;
  /** Cursor for the next page; null on the last page. Route coerces undefined to null. */
  nextCursor?: string | null;
}

/** The subset of PatrolFindingService the routes depend on. */
export interface PatrolFindingServiceLike {
  upsertBatch(
    data: UpsertPatrolFindingsInput,
    scope?: PatrolFindingScope,
  ): Promise<PatrolFinding[]>;
  list(
    opts?: ListPatrolFindingsOptions,
    scope?: PatrolFindingScope,
  ): Promise<ListPatrolFindingsResult>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asHistory(raw: unknown): PatrolFindingHistoryEntry[] {
  return Array.isArray(raw) ? (raw as PatrolFindingHistoryEntry[]) : [];
}

function validateStatus(status: unknown): string {
  if (
    typeof status !== "string" ||
    !(PATROL_FINDING_STATUSES as readonly string[]).includes(status)
  ) {
    throw new BadRequestError(
      `status must be one of: ${PATROL_FINDING_STATUSES.join(", ")}`,
    );
  }
  return status;
}

export class PatrolFindingService implements PatrolFindingServiceLike {
  constructor(
    private prisma: PrismaClient,
    private now: () => Date = () => new Date(),
  ) {}

  async upsertBatch(
    data: UpsertPatrolFindingsInput,
    scope: PatrolFindingScope = UNRESTRICTED_SCOPE,
  ): Promise<PatrolFinding[]> {
    if (!data.cronId) throw new BadRequestError("cronId is required");
    if (!data.repo || !isOrgRepo(data.repo)) {
      throw new BadRequestError("repo must be in 'owner/repo' form");
    }
    if (!Array.isArray(data.findings)) {
      throw new BadRequestError("findings must be an array");
    }
    if (data.findings.length > MAX_PATROL_FINDING_BATCH) {
      throw new BadRequestError(
        `findings may contain at most ${MAX_PATROL_FINDING_BATCH} entries`,
      );
    }
    let observedAt = this.now();
    if (data.observedAt !== undefined) {
      observedAt = new Date(data.observedAt);
      if (Number.isNaN(observedAt.getTime())) {
        throw new BadRequestError("observedAt must be a valid ISO timestamp");
      }
    }
    const seen = new Set<string>();
    for (const f of data.findings) {
      if (!isPlainObject(f)) {
        throw new BadRequestError("each finding must be an object");
      }
      if (typeof f.fingerprint !== "string" || !f.fingerprint) {
        throw new BadRequestError("fingerprint is required");
      }
      if (seen.has(f.fingerprint)) {
        throw new BadRequestError(`duplicate fingerprint '${f.fingerprint}'`);
      }
      seen.add(f.fingerprint);
      validateStatus(f.status);
      if (
        f.detail !== undefined &&
        f.detail !== null &&
        !isPlainObject(f.detail)
      ) {
        throw new BadRequestError("detail must be an object or null");
      }
    }

    if (scope.repos !== null && !scope.repos.includes(data.repo)) {
      throw new ForbiddenError(`repo '${data.repo}' is not in this scope`);
    }
    if (data.findings.length === 0) return [];

    const existing = await this.prisma.patrolFinding.findMany({
      where: {
        accountId: data.accountId,
        cronId: data.cronId,
        repo: data.repo,
        fingerprint: { in: data.findings.map((f) => f.fingerprint) },
      },
    });
    const byFingerprint = new Map(existing.map((r) => [r.fingerprint, r]));
    const at = observedAt.toISOString();

    const ops: unknown[] = [];
    const slots: Array<PatrolFinding | number> = data.findings.map((f) => {
      const prev = byFingerprint.get(f.fingerprint);
      if (!prev) {
        return (
          ops.push(
            this.prisma.patrolFinding.create({
              data: {
                accountId: data.accountId,
                cronId: data.cronId,
                repo: data.repo,
                fingerprint: f.fingerprint,
                status: f.status,
                firstSeen: observedAt,
                lastSeen: observedAt,
                occurrenceCount: 1,
                history: [{ at, status: f.status, occurrenceCount: 1 }],
                taskId: f.taskId || null,
                // JSON-null is not a valid nullable input; omit to store SQL NULL.
                ...(f.detail ? { detail: f.detail } : {}),
              } as never,
            }),
          ) - 1
        );
      }
      // Replay of an observation already recorded: leave the row untouched.
      if (observedAt.getTime() <= prev.lastSeen.getTime()) {
        return prev;
      }
      const occurrenceCount = prev.occurrenceCount + 1;
      return (
        ops.push(
          this.prisma.patrolFinding.update({
            where: { id: prev.id },
            data: {
              status: f.status,
              lastSeen: observedAt,
              occurrenceCount,
              history: [
                ...asHistory(prev.history),
                { at, status: f.status, occurrenceCount },
              ],
              ...(f.detail ? { detail: f.detail } : {}),
              ...(f.taskId ? { taskId: f.taskId } : {}),
            } as never,
          }),
        ) - 1
      );
    });
    // Replays need no write, so only real creates/updates go in the transaction.
    const written = ops.length
      ? ((await this.prisma.$transaction(
          ops as never,
        )) as unknown as PatrolFinding[])
      : [];
    return slots.map((slot) =>
      typeof slot === "number" ? (written[slot] as PatrolFinding) : slot,
    );
  }

  async list(
    opts: ListPatrolFindingsOptions = {},
    scope: PatrolFindingScope = UNRESTRICTED_SCOPE,
  ): Promise<ListPatrolFindingsResult> {
    const limit = opts.limit ?? 50;
    if (scope.repos !== null) {
      if (opts.repo && !scope.repos.includes(opts.repo)) {
        throw new ForbiddenError(`repo '${opts.repo}' is not in this scope`);
      }
      if (scope.repos.length === 0) return { findings: [], total: 0 };
    }
    const where = {
      ...(scope.accountId !== null ? { accountId: scope.accountId } : {}),
      ...(scope.repos !== null ? { repo: { in: scope.repos } } : {}),
      ...(opts.repo ? { repo: opts.repo } : {}),
      ...(opts.cronId ? { cronId: opts.cronId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    };
    const pageWhere =
      opts.cursor !== undefined
        ? {
            AND: [
              where,
              cursorWhere(decodeCursor(opts.cursor), "desc", "lastSeen"),
            ],
          }
        : where;
    const [fetched, total] = await this.prisma.$transaction([
      this.prisma.patrolFinding.findMany({
        where: pageWhere,
        orderBy: [{ lastSeen: "desc" }, { id: "desc" }],
        take: limit + 1,
      }),
      this.prisma.patrolFinding.count({ where }),
    ]);
    const hasMore = fetched.length > limit;
    const findings = hasMore ? fetched.slice(0, limit) : fetched;
    const last = findings[findings.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.lastSeen, id: last.id })
        : null;
    return { findings, total, nextCursor };
  }
}
