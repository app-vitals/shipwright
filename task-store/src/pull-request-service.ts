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
import { Prisma, type PrismaClient, type PrPhase, type PullRequest } from "./index.ts";

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
    phase?: PrPhase,
    prCreatedAt?: string,
  ): Promise<{ status: 200 | 201; record: PullRequest }>;
  heartbeat(id: string): Promise<PullRequest>;
  complete(id: string): Promise<PullRequest>;
  patch(id: string): Promise<PullRequest>;
  release(id: string): Promise<PullRequest>;
  claimNext(
    agentId: string,
    maxConcurrent: number,
    repos?: string[],
  ): Promise<{ pr: PullRequest; phase: PrPhase } | null>;
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
      const updateData: Prisma.PullRequestUpdateInput = { ...data };

      // When a caller transitions reviewState to 'approved' and hasn't already
      // supplied readyForDeployAt, stamp it now rather than leaving it to be
      // set lazily on the next claim/claimNext. claimNext's
      // COALESCE(...) NULLS LAST ordering tolerates an unset value, but setting
      // it at the actual approval moment keeps the deploy-readiness ordering
      // accurate for PRs that sit approved-but-unclaimed for a while.
      if (data.reviewState === "approved" && data.readyForDeployAt === undefined) {
        const existing = await this.prisma.pullRequest.findUnique({
          where: { id },
          select: { readyForDeployAt: true },
        });
        if (existing && existing.readyForDeployAt === null) {
          updateData.readyForDeployAt = this.clock.now().toISOString();
        }
      }

      return await this.prisma.pullRequest.update({
        where: { id },
        data: updateData,
      });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "pr not found");
    }
  }

  // ─── Claim / liveness ─────────────────────────────────────────────────────

  /**
   * Atomically claim a PR using a Prisma transaction.
   *
   * phase defaults to 'review'. Phase-specific behaviour:
   *   - review (default): sets reviewState='in_progress', phase='review';
   *     on first creation of the record, also stamps readyForReviewAt=now
   *     (mirrors claimNext()'s behaviour for pre-existing records)
   *   - patch: sets phase='patch', claim fields; does NOT touch reviewState
   *   - deploy: sets phase='deploy', claim fields, sets readyForDeployAt=now if null
   *
   * Conflict detection:
   *   - Same commitSha AND claimedBy IS NOT NULL with fresh heartbeat for same phase → 409
   *   - Legacy review path: same commitSha AND reviewState !== 'pending' → 409
   */
  async claim(
    repo: string,
    prNumber: number,
    commitSha: string,
    claimedBy: string,
    taskId?: string,
    phase: PrPhase = "review",
    prCreatedAt?: string,
  ): Promise<{ status: 200 | 201; record: PullRequest }> {
    const now = this.clock.now().toISOString();

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.pullRequest.findUnique({
        where: { repo_prNumber: { repo, prNumber } },
      });

      if (existing) {
        // Conflict: same commitSha AND already claimed by someone with fresh heartbeat
        // for the same phase
        if (
          existing.commitSha === commitSha &&
          existing.claimedBy !== null &&
          existing.phase === phase
        ) {
          throw new ConflictError(
            `pr ${repo}#${prNumber} is already claimed with the same commit`,
          );
        }

        // Legacy review conflict: same commitSha and reviewState is not pending
        // (covers the case where phase was not set yet)
        if (
          phase === "review" &&
          existing.commitSha === commitSha &&
          existing.reviewState !== "pending"
        ) {
          throw new ConflictError(
            `pr ${repo}#${prNumber} is already claimed with the same commit`,
          );
        }

        // Build update payload based on phase
        const updateData: Prisma.PullRequestUpdateInput = {
          commitSha,
          claimedBy,
          claimedAt: now,
          heartbeatAt: now,
          phase,
          ...(taskId !== undefined ? { taskId } : {}),
        };

        if (phase === "review") {
          updateData.reviewState = "in_progress";
        } else if (phase === "deploy") {
          // Set readyForDeployAt only if not already set
          if (existing.readyForDeployAt === null) {
            updateData.readyForDeployAt = now;
          }
        }
        // phase === 'patch': do NOT touch reviewState (preserve 'posted')

        const record = await tx.pullRequest.update({
          where: { id: existing.id },
          data: updateData,
        });
        return { status: 200 as const, record };
      }

      // No existing record → create.
      // Guard against a concurrent INSERT winning the race: Postgres enforces
      // @@unique([repo, prNumber]) and the losing writer gets a P2002. Map that
      // to ConflictError(409) so callers see a clean error instead of a raw 500.
      try {
        const createData: Prisma.PullRequestCreateInput = {
          repo,
          prNumber,
          commitSha,
          claimedBy,
          claimedAt: now,
          heartbeatAt: now,
          phase,
          ...(taskId !== undefined ? { taskId } : {}),
          // prCreatedAt is only ever set here, at record creation — it is
          // immutable thereafter (never touched by the update branch above),
          // matching the "read-only via the API" contract in docs/task-store.md.
          ...(prCreatedAt !== undefined ? { prCreatedAt } : {}),
        };

        if (phase === "review") {
          createData.reviewState = "in_progress";
          createData.readyForReviewAt = now;
        } else if (phase === "deploy") {
          createData.readyForDeployAt = now;
        }

        const record = await tx.pullRequest.create({ data: createData });
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

    return result;
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

  /** Mark a PR review as posted. Increments reviewCycles, sets reviewState=posted, reviewedAt, and readyForPatchAt. */
  async complete(id: string): Promise<PullRequest> {
    const now = this.clock.now().toISOString();
    try {
      return await this.prisma.pullRequest.update({
        where: { id },
        data: {
          reviewCycles: { increment: 1 },
          reviewState: "posted",
          reviewedAt: now,
          readyForPatchAt: now,
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

  /**
   * Atomically find the oldest unclaimed eligible PR and claim it.
   *
   * Steps (all in one transaction):
   *   1. Count active claims by agentId — if >= maxConcurrent, return null
   *   2. Find oldest unclaimed eligible PR ordered by
   *      COALESCE(readyForReviewAt, readyForPatchAt, readyForDeployAt) ASC
   *      WHERE claimedBy IS NULL AND state='open' AND reviewState IN ('pending','posted','approved')
   *   3. Determine phase from reviewState: pending→review, posted→patch, approved→deploy
   *   4. Set readyForReviewAt=now if null (first claim)
   *   5. Claim with the appropriate phase
   *   6. Return {pr, phase}
   */
  async claimNext(
    agentId: string,
    maxConcurrent: number,
    repos?: string[],
  ): Promise<{ pr: PullRequest; phase: PrPhase } | null> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    // Cutoff for "fresh" heartbeat — same as reaper default (15 min)
    const cutoffMs = Number(
      process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS ?? 900_000,
    );
    const cutoff = new Date(now.getTime() - cutoffMs).toISOString();

    return this.prisma.$transaction(async (tx) => {
      // Step 1: Count active claims by this agent
      const activeCount = await tx.pullRequest.count({
        where: {
          claimedBy: agentId,
          heartbeatAt: { gt: cutoff },
        },
      });

      if (activeCount >= maxConcurrent) {
        return null;
      }

      // Step 2: Find oldest unclaimed eligible PR via raw SQL for COALESCE ordering.
      // When repos is provided, filter in SQL so out-of-scope PRs don't block
      // in-scope work (application-layer filtering would return null on first
      // out-of-scope hit without examining remaining rows).
      const repoFilter =
        repos && repos.length > 0
          ? Prisma.sql`AND "repo" = ANY(${repos})`
          : Prisma.sql``;

      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id
          FROM "PullRequest"
         WHERE "claimedBy" IS NULL
           AND "state" = 'open'
           AND "reviewState" IN ('pending', 'posted', 'approved')
           ${repoFilter}
         ORDER BY COALESCE("readyForReviewAt", "readyForPatchAt", "readyForDeployAt") ASC NULLS LAST,
                  "createdAt" ASC
         LIMIT 1
      `;

      if (rows.length === 0) {
        return null;
      }

      const targetId = rows[0].id;

      // Step 3: Fetch full record to determine phase
      const target = await tx.pullRequest.findUnique({ where: { id: targetId } });
      if (!target) return null; // concurrent claim took it

      // Determine phase from reviewState
      let phase: PrPhase;
      if (target.reviewState === "pending") {
        phase = "review";
      } else if (target.reviewState === "posted") {
        phase = "patch";
      } else {
        phase = "deploy"; // approved
      }

      // Step 4 & 5: Build claim update
      const updateData: Prisma.PullRequestUpdateInput = {
        claimedBy: agentId,
        claimedAt: nowIso,
        heartbeatAt: nowIso,
        phase,
      };

      if (phase === "review") {
        updateData.reviewState = "in_progress";
        // Set readyForReviewAt=now if this is the first time
        if (target.readyForReviewAt === null) {
          updateData.readyForReviewAt = nowIso;
        }
      } else if (phase === "deploy") {
        if (target.readyForDeployAt === null) {
          updateData.readyForDeployAt = nowIso;
        }
      }
      // patch: preserve reviewState='posted', no readyForPatchAt change here

      const pr = await tx.pullRequest.update({
        where: {
          id: targetId,
          claimedBy: null, // optimistic lock — ensures we win the race
        },
        data: updateData,
      });

      return { pr, phase };
    });
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
