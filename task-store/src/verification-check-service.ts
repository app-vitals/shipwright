/**
 * task-store/src/verification-check-service.ts
 * VerificationCheckService — records and lists structured per-check
 * verification outcomes (LVB-5.1: the structured, queryable successor to the
 * printed-only "PRE-SHIP CHECKS" table dev-task.md Step 8 / patch.md emit
 * today).
 *
 * A VerificationCheck row belongs to exactly one parent — a Task (recorded
 * while a task is still in progress, before a PR exists) or a PullRequest
 * (recorded once a PR is open). There is no existing "optional reference to
 * one of two parent record types" pattern elsewhere in this codebase to
 * mirror, so the Prisma model carries two nullable FK columns
 * (taskId/prRecordId); Prisma has no schema-level XOR constraint, so "exactly
 * one set" is enforced here in record().
 *
 * record() also enforces the status/reasonCategory relationship that is
 * load-bearing for LVB-4.4's future skip-locally learning trigger:
 * reasonCategory (and learnedFromCategory) may only be set alongside
 * status IN ('skipped', 'timed_out') — a 'ran_failed' row (the check executed
 * and produced a genuine failure — a real assertion/test failure, a real
 * lint violation) must NEVER carry a reasonCategory, since that field means
 * "the agent could not attempt/complete this check in its own environment",
 * never "the code has a real problem". Getting this wrong here would let a
 * plain test failure masquerade, to LVB-4.4's learning trigger, as an
 * environmental skip — this validation is what keeps that distinction real
 * rather than a documentation-only convention.
 *
 * Mirrors PullRequestService.appendFinding()/getEvents() and
 * TaskService.getEvents(): existence-checks the referenced parent first
 * (NotFoundError on a missing task/PR) so a bad id surfaces as a clean 404
 * rather than a raw Prisma P2003 FK-violation error; `at` defaults to
 * this.clock.now() when the caller omits it.
 */

import { type Clock, SystemClock } from "./clock.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";
import type {
  PrismaClient,
  VerificationCheck,
  VerificationCheckReasonCategory,
  VerificationCheckStatus,
} from "./index.ts";
import {
  VerificationCheckReasonCategory as ReasonCategoryEnum,
  VerificationCheckStatus as StatusEnum,
} from "./index.ts";

/** Derived from the runtime enums rather than hand-listed, so these stay in
 * sync with the Prisma schema without a second literal list to update
 * (mirrors routes/prs.ts's PR_ORIGIN_VALUES). */
const STATUS_VALUES: ReadonlySet<string> = new Set(Object.values(StatusEnum));
const REASON_CATEGORY_VALUES: ReadonlySet<string> = new Set(
  Object.values(ReasonCategoryEnum),
);

/** Statuses a reasonCategory may accompany — the check did not run to completion. */
const REASON_CATEGORY_ELIGIBLE_STATUSES: ReadonlySet<string> = new Set([
  StatusEnum.skipped,
  StatusEnum.timed_out,
]);

export interface RecordVerificationCheckInput {
  /** Exactly one of taskId/prId is required. */
  taskId?: string | null;
  prId?: string | null;
  repo: string;
  /** Free-form check name: "install" | "lint" | "typecheck" | "unit" | "integration" | ... */
  checkName: string;
  status: VerificationCheckStatus;
  /** Only valid alongside status IN ('skipped', 'timed_out') — see this file's doc comment. */
  reasonCategory?: VerificationCheckReasonCategory | null;
  /** Only valid alongside reasonCategory === 'learned_skip'. */
  learnedFromCategory?: VerificationCheckReasonCategory | null;
  durationMs?: number | null;
  /** ISO timestamp. Defaults to the service's Clock.now() when omitted. */
  at?: string;
}

/** Result from VerificationCheckService.listForTask/listForPr. */
export interface ListVerificationChecksResult {
  checks: VerificationCheck[];
  total: number;
}

/** The subset of VerificationCheckService the routes depend on. */
export interface VerificationCheckServiceLike {
  record(data: RecordVerificationCheckInput): Promise<VerificationCheck>;
  listForTask(
    taskId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<ListVerificationChecksResult>;
  listForPr(
    prId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<ListVerificationChecksResult>;
}

/** Normalizes a possibly-empty-string/null/undefined id field to `string | null`. */
function normalizeId(value: string | null | undefined): string | null {
  return typeof value === "string" && value ? value : null;
}

export class VerificationCheckService implements VerificationCheckServiceLike {
  constructor(
    private prisma: PrismaClient,
    private clock: Clock = SystemClock(),
  ) {}

  async record(
    data: RecordVerificationCheckInput,
  ): Promise<VerificationCheck> {
    const taskId = normalizeId(data.taskId);
    const prId = normalizeId(data.prId);

    if (taskId === null && prId === null) {
      throw new BadRequestError(
        "exactly one of taskId/prId is required — neither was provided",
      );
    }
    if (taskId !== null && prId !== null) {
      throw new BadRequestError(
        "exactly one of taskId/prId is required — both were provided",
      );
    }

    if (!data.repo) {
      throw new BadRequestError("repo is required");
    }
    if (!data.checkName) {
      throw new BadRequestError("checkName is required");
    }
    if (!STATUS_VALUES.has(data.status)) {
      throw new BadRequestError(
        `status '${data.status}' is not a valid VerificationCheckStatus`,
      );
    }

    const reasonCategory = data.reasonCategory ?? null;
    if (
      reasonCategory !== null &&
      !REASON_CATEGORY_VALUES.has(reasonCategory)
    ) {
      throw new BadRequestError(
        `reasonCategory '${reasonCategory}' is not a valid VerificationCheckReasonCategory`,
      );
    }
    // The load-bearing check (see this file's doc comment + LVB-4.4): a
    // ran_passed/ran_failed row must never carry a reasonCategory.
    if (
      reasonCategory !== null &&
      !REASON_CATEGORY_ELIGIBLE_STATUSES.has(data.status)
    ) {
      throw new BadRequestError(
        `reasonCategory may only be set when status is '${StatusEnum.skipped}' or '${StatusEnum.timed_out}' (got status '${data.status}') — a '${data.status}' row must never carry a reasonCategory`,
      );
    }

    const learnedFromCategory = data.learnedFromCategory ?? null;
    if (
      learnedFromCategory !== null &&
      !REASON_CATEGORY_VALUES.has(learnedFromCategory)
    ) {
      throw new BadRequestError(
        `learnedFromCategory '${learnedFromCategory}' is not a valid VerificationCheckReasonCategory`,
      );
    }
    if (
      learnedFromCategory !== null &&
      reasonCategory !== ReasonCategoryEnum.learned_skip
    ) {
      throw new BadRequestError(
        `learnedFromCategory may only be set when reasonCategory is '${ReasonCategoryEnum.learned_skip}'`,
      );
    }
    if (learnedFromCategory === ReasonCategoryEnum.learned_skip) {
      throw new BadRequestError(
        `learnedFromCategory must be the original root-cause category that triggered the learning, not '${ReasonCategoryEnum.learned_skip}' itself`,
      );
    }

    if (taskId !== null) {
      const existing = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundError("task not found");
      }
    } else if (prId !== null) {
      const existing = await this.prisma.pullRequest.findUnique({
        where: { id: prId },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundError("pr not found");
      }
    }

    return this.prisma.verificationCheck.create({
      data: {
        taskId,
        prRecordId: prId,
        repo: data.repo,
        checkName: data.checkName,
        status: data.status,
        reasonCategory,
        learnedFromCategory,
        durationMs: data.durationMs ?? null,
        at: data.at ?? this.clock.now().toISOString(),
      },
    });
  }

  async listForTask(
    taskId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<ListVerificationChecksResult> {
    const existing = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundError("task not found");
    }
    return this.list({ taskId }, opts);
  }

  async listForPr(
    prId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<ListVerificationChecksResult> {
    const existing = await this.prisma.pullRequest.findUnique({
      where: { id: prId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundError("pr not found");
    }
    return this.list({ prRecordId: prId }, opts);
  }

  private async list(
    where: { taskId: string } | { prRecordId: string },
    opts: { limit?: number; offset?: number },
  ): Promise<ListVerificationChecksResult> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const [checks, total] = await this.prisma.$transaction([
      this.prisma.verificationCheck.findMany({
        where,
        orderBy: { at: "asc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.verificationCheck.count({ where }),
    ]);

    return { checks, total };
  }
}
