/**
 * task-store/src/pull-request-service.ts
 * PullRequestService — operations for tracking GitHub PRs through the
 * Shipwright review → patch → deploy pipeline.
 *
 * claim() is atomic via a Prisma $transaction:
 *   1. Find existing record by @@unique([repo, prNumber])
 *   2. Same commitSha AND reviewState !== 'pending' → ConflictError(409)
 *   3. Different commitSha OR reviewState === 'pending' → update (200)
 *   4. No record → create (201)
 *
 * Timestamp fields are stored as ISO strings to match the application contract;
 * only createdAt/updatedAt are DateTime columns.
 */

import { type Clock, SystemClock } from "./clock.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import type { Prisma, PrismaClient, PullRequest } from "./index.ts";

/** Filters accepted by PullRequestService.list. */
export interface PullRequestListFilters {
  repo?: string;
  prNumber?: number;
  taskId?: string;
  state?: string;
  reviewState?: string;
  staged?: boolean;
  limit?: number;
  offset?: number;
}

/** Paginated list result from PullRequestService.list. */
export interface PullRequestListResult {
  prs: PullRequest[];
  total: number;
  limit: number;
  offset: number;
}

/** The subset of PullRequestService the routes depend on. */
export interface PullRequestServiceLike {
  list(filters?: PullRequestListFilters): Promise<PullRequestListResult>;
  get(id: string): Promise<PullRequest | null>;
  update(id: string, data: Partial<PullRequest>): Promise<PullRequest>;
  claim(
    repo: string,
    prNumber: number,
    commitSha: string,
    claimedBy: string,
    taskId?: string,
  ): Promise<{ status: 200 | 201; record: PullRequest }>;
  heartbeat(id: string): Promise<PullRequest>;
  complete(id: string): Promise<PullRequest>;
  patch(id: string): Promise<PullRequest>;
  release(id: string): Promise<PullRequest>;
}

export class PullRequestService implements PullRequestServiceLike {
  constructor(
    private prisma: PrismaClient,
    private clock: Clock = SystemClock(),
  ) {}

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async list(
    filters: PullRequestListFilters = {},
  ): Promise<PullRequestListResult> {
    const where: Prisma.PullRequestWhereInput = {};
    if (filters.repo) where.repo = filters.repo;
    if (filters.prNumber !== undefined) where.prNumber = filters.prNumber;
    if (filters.taskId) where.taskId = filters.taskId;
    if (filters.state) where.state = filters.state as PullRequest["state"];
    if (filters.reviewState)
      where.reviewState = filters.reviewState as PullRequest["reviewState"];
    if (filters.staged !== undefined) where.staged = filters.staged;

    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const [prs, total] = await this.prisma.$transaction([
      this.prisma.pullRequest.findMany({
        where,
        orderBy: { createdAt: "asc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.pullRequest.count({ where }),
    ]);

    return { prs, total, limit, offset };
  }

  async get(id: string): Promise<PullRequest | null> {
    return this.prisma.pullRequest.findUnique({ where: { id } });
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  async update(id: string, data: Partial<PullRequest>): Promise<PullRequest> {
    try {
      return await this.prisma.pullRequest.update({
        where: { id },
        data: data as Prisma.PullRequestUpdateInput,
      });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "pr not found");
    }
  }

  // ─── Claim / liveness ─────────────────────────────────────────────────────

  /**
   * Atomically claim a PR for review using a Prisma transaction:
   *
   *   1. Find existing record by @@unique([repo, prNumber])
   *   2. If found with same commitSha AND reviewState !== 'pending' → ConflictError(409)
   *   3. If found with different commitSha OR reviewState === 'pending' → update → return {status:200, record}
   *   4. If no record → create → return {status:201, record}
   */
  async claim(
    repo: string,
    prNumber: number,
    commitSha: string,
    claimedBy: string,
    taskId?: string,
  ): Promise<{ status: 200 | 201; record: PullRequest }> {
    const now = this.clock.now().toISOString();

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.pullRequest.findUnique({
        where: { repo_prNumber: { repo, prNumber } },
      });

      if (existing) {
        // Same commitSha and already in active review → conflict
        if (
          existing.commitSha === commitSha &&
          existing.reviewState !== "pending"
        ) {
          throw new ConflictError(
            `pr ${repo}#${prNumber} is already claimed with the same commit`,
          );
        }

        // Different commitSha or reviewState is pending → start new review cycle
        const record = await tx.pullRequest.update({
          where: { id: existing.id },
          data: {
            commitSha,
            reviewState: "in_progress",
            claimedBy,
            claimedAt: now,
            heartbeatAt: now,
            ...(taskId !== undefined ? { taskId } : {}),
          },
        });
        return { status: 200 as const, record };
      }

      // No existing record → create.
      // Guard against a concurrent INSERT winning the race: Postgres enforces
      // @@unique([repo, prNumber]) and the losing writer gets a P2002. Map that
      // to ConflictError(409) so callers see a clean error instead of a raw 500.
      try {
        const record = await tx.pullRequest.create({
          data: {
            repo,
            prNumber,
            commitSha,
            reviewState: "in_progress",
            claimedBy,
            claimedAt: now,
            heartbeatAt: now,
            ...(taskId !== undefined ? { taskId } : {}),
          },
        });
        return { status: 201 as const, record };
      } catch (err: unknown) {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: string }).code === "P2002"
        ) {
          throw new ConflictError(`pr ${repo}#${prNumber} is already claimed`);
        }
        throw err;
      }
    });
  }

  /** Touch heartbeatAt for liveness. Errors if the PR is missing. */
  async heartbeat(id: string): Promise<PullRequest> {
    const now = this.clock.now().toISOString();
    try {
      return await this.prisma.pullRequest.update({
        where: { id },
        data: { heartbeatAt: now },
      });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "pr not found");
    }
  }

  /** Mark a PR review as posted. Increments reviewCycles, sets reviewState=posted and reviewedAt. */
  async complete(id: string): Promise<PullRequest> {
    const now = this.clock.now().toISOString();
    try {
      return await this.prisma.pullRequest.update({
        where: { id },
        data: {
          reviewCycles: { increment: 1 },
          reviewState: "posted",
          reviewedAt: now,
        },
      });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "pr not found");
    }
  }

  /**
   * Increment patch cycles. Sets patchCycles+1, patchedAt=now, reviewState=pending.
   * Called when a patch run is started after a review posted findings.
   */
  async patch(id: string): Promise<PullRequest> {
    const now = this.clock.now().toISOString();
    try {
      return await this.prisma.pullRequest.update({
        where: { id },
        data: {
          patchCycles: { increment: 1 },
          patchedAt: now,
          reviewState: "pending",
        },
      });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "pr not found");
    }
  }

  /** Unclaim a PR — reset claim fields and return reviewState to pending. */
  async release(id: string): Promise<PullRequest> {
    try {
      return await this.prisma.pullRequest.update({
        where: { id },
        data: {
          reviewState: "pending",
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
        },
      });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "pr not found");
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /** Map Prisma's P2025 (record not found) to a NotFoundError; re-throw the rest. */
  private translateNotFound(err: unknown, message: string): unknown {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "P2025"
    ) {
      return new NotFoundError(message);
    }
    return err;
  }
}
