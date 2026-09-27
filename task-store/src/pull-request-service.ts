/**
 * task-store/src/pull-request-service.ts
 * PullRequestService — operations for tracking GitHub PRs through the
 * Shipwright review → patch → deploy pipeline.
 *
 * claim() is atomic via a Prisma $transaction:
 *   1. Find existing record by @@unique([repo, prNumber])
 *   2. Update with the conflict conditions re-checked in the UPDATE's own WHERE
 *      clause (so Postgres, holding the row lock, is the sole arbiter of a
 *      concurrent claim — not a possibly-stale JS snapshot). A write that no
 *      longer matches affects 0 rows → P2025 → ConflictError(409) (or, if the
 *      row was deleted, NotFoundError). Otherwise → update (200)
 *   3. No record → create (201); a concurrent INSERT loser hits the
 *      @@unique([repo, prNumber]) constraint → P2002 → ConflictError(409)
 *
 * Timestamp fields are stored as ISO strings to match the application contract;
 * only createdAt/updatedAt are DateTime columns.
 */

import { DEFAULT_CLAIM_TTL_MS } from "@shipwright/lib/claim-ttl";
import { type Clock, SystemClock } from "./clock.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import {
  type PrFinding,
  type PrFindingDisposition,
  type PrFindingSource,
  Prisma,
  type PrismaClient,
  type PrOrigin,
  type PrPhase,
  type PrState,
  type PullRequest,
  type PullRequestEvent,
} from "./index.ts";
import { buildRepoOrgWhere } from "./lib/repo-org-filter.ts";
import { deriveOrigin } from "./pr-origin-derivation.ts";
import { computePrTransitionDiff } from "./pr-transition-diff.ts";

/**
 * The Prisma client surface shared by the top-level client and a $transaction
 * callback's `tx`. recordTransition() accepts this so it can run against either
 * — the write path always hands it the same `tx` that performed the source
 * update, keeping the event insert(s) atomic with it.
 *
 * Also the type stampOrigin()'s optional `client` param accepts (POM-1.1) —
 * exported as `PullRequestTxClient` so TaskService.update() can type the tx
 * it hands across the service boundary in the same $transaction.
 */
type PrismaTxClient = Pick<
  Prisma.TransactionClient,
  "pullRequest" | "pullRequestEvent"
>;
export type PullRequestTxClient = PrismaTxClient;

/**
 * Parses an `updatedSince` filter value into a Date, matching the
 * BadRequestError(400) pattern used for `repo`/`prNumber` validation
 * elsewhere in the request stack rather than letting an unparseable value
 * surface as an Invalid Date that Prisma throws on (caught only by the
 * generic 500 handler).
 */
function parseUpdatedSince(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError(
      `updatedSince '${value}' is not a valid ISO timestamp`,
    );
  }
  return date;
}

/** Normalizes a `string | string[] | undefined` filter value into an array, for buildRepoOrgWhere. */
function toArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/** Minimal shape of a joined Task row needed to evaluate the blocked signal. */
interface LinkedTaskBlockedInfo {
  status: string;
}

/** Map key for the repo+prNumber task join — mirrors GET /tasks?repo=&pr=. */
function prKey(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

/**
 * True when a PR should be surfaced by `list({ blocked: true })`:
 * `pr.blocked === true` OR at least one linked task has `status ===
 * "blocked"`. `tasks` is empty for PRs no task points at — in that case only
 * `pr.blocked` is consulted, so a missing join never crashes or
 * false-positives. A PR can legitimately have several linked tasks (the
 * bundle case), and any one of them being blocked blocks the PR.
 *
 * Task.hitl is deliberately not consulted here: post-redesign, Type A tasks
 * (the only ones that keep hitl:true) never have a linked PR, so that branch
 * was dead code.
 *
 * Mirrors the combined signal agent/src/check-helpers.ts already uses for
 * dispatch gating — `isTaskBlockedForDispatch(linkedTask) ||
 * isPrRecordBlockedForDispatch(pr)` — reimplemented natively here rather than
 * imported, since task-store must not depend on the agent package.
 */
function isPrBlocked(
  pr: Pick<PullRequest, "blocked">,
  tasks: readonly LinkedTaskBlockedInfo[],
): boolean {
  return pr.blocked === true || tasks.some((t) => t.status === "blocked");
}

/**
 * Skip-count auto-block threshold: once a PR's skipCount reaches this value,
 * recordSkip() also sets blocked:true + blockedReason so the loop
 * orchestrator stops re-selecting it. Mirrors SPIN_DETECTION_THRESHOLD in
 * agent/src/loop-orchestrator.ts:179 — duplicated here (not imported) since
 * agent/ and task-store/ are separate deployables.
 */
const SKIP_BLOCK_THRESHOLD = 3;

/**
 * CI-failure streak auto-block threshold: once a PR's consecutiveCiFailureCount
 * reaches this value (i.e. patch() has been called this many times in a row
 * with the same ciFailureSignature), patch() also sets blocked:true +
 * blockedReason in the same request so the loop orchestrator stops
 * re-dispatching CI-fix cycles that keep hitting the same failure. Mirrors
 * SKIP_BLOCK_THRESHOLD above / SPIN_DETECTION_THRESHOLD in
 * agent/src/loop-orchestrator.ts:179.
 */
const CI_FAILURE_BLOCK_THRESHOLD = 3;

/** Filters accepted by PullRequestService.list. */
export interface PullRequestListFilters {
  /**
   * A single repo string preserves today's exact-match behavior
   * (`where.repo = repo`). An array (or an `org` filter alongside it) is
   * built via `buildRepoOrgWhere` into a `{ repo: { in: [...] } }` clause.
   */
  repo?: string | string[];
  /**
   * Org filter — matched via `repo: { startsWith: "<org>/" }` (there's no
   * dedicated org column). Built via the shared `buildRepoOrgWhere` helper.
   */
  org?: string | string[];
  prNumber?: number;
  state?: string;
  reviewState?: string;
  staged?: boolean;
  limit?: number;
  offset?: number;
  /**
   * When true, only return unclaimed PRs (claimedBy IS NULL) — mirrors
   * /tasks?ready=true's semantics for tasks. Deliberately kept to the literal
   * "unclaimed" interpretation from the acceptance criteria rather than also
   * hardcoding claimNext()'s state='open' AND reviewState IN
   * ('pending','posted','approved') eligibility rules: GET /prs is a general
   * list endpoint used by multiple callers (not just the claim-next code
   * path), and those additional rules are already composable via the
   * existing `state`/`reviewState` filters when a caller needs them. Claim
   * staleness is handled entirely by StaleClaimReaper — this filter does not
   * duplicate that logic, it just reads the current claimedBy column.
   */
  ready?: boolean;
  /**
   * When true, only return PRs considered "blocked" — mirroring the combined
   * dispatch-gating signal agent/src/check-helpers.ts uses (
   * isTaskBlockedForDispatch(linkedTask) || isPrRecordBlockedForDispatch(pr)),
   * reimplemented natively here since task-store must not import from the
   * agent package. A PR is blocked when pr.blocked===true OR any task
   * linked to it has status==='blocked'. The link is resolved live by
   * (Task.repo, Task.pr) — the same repo+pr lookup GET /tasks?repo=&pr=
   * exposes — since the stored PullRequest.taskId column was dropped in
   * PTL-3.1. PRs no task points at are evaluated on pr.blocked alone.
   * Task.hitl is deliberately not consulted: post-redesign, Type A tasks
   * (the only ones that keep hitl:true) never have a linked PR, so that
   * branch would be dead code.
   */
  blocked?: boolean;
  /**
   * Order results by createdAt. Defaults to "asc", preserving current
   * behavior for every existing caller. Unrelated to claimNext()'s own
   * deterministic SQL ORDER BY (COALESCE(readyForReviewAt, ...) ASC) used
   * for phase-ready claiming — claimNext() does not call list() and does not
   * accept this filter.
   */
  sort?: "asc" | "desc";
  /**
   * ISO timestamp. Only return PRs with updatedAt >= this value. A
   * conservative pre-filter (not a precise sync anchor) — see
   * planning/task-store-date-filtering/PLAN.md for the root-cause/design
   * rationale. Omitting it preserves current (unfiltered) behavior.
   */
  updatedSince?: string;
  /**
   * PrOrigin values to match (OR'd together, i.e. `{ origin: { in: [...] } }`)
   * — POM-1.1's `GET /prs?origin=shipwright,ci` filter. Omitting it preserves
   * current (unfiltered) behavior.
   */
  origin?: PrOrigin[];
}

/** Paginated list result from PullRequestService.list. */
export interface PullRequestListResult {
  prs: PullRequest[];
  total: number;
  limit: number;
  offset: number;
}

/** Result from PullRequestService.getEvents. */
export interface GetEventsResult {
  events: PullRequestEvent[];
  total: number;
}

// ─── Origin metrics (POM-1.1) ──────────────────────────────────────────────────

/**
 * Fields PullRequestService.stampOrigin() may write for a (repo, prNumber)
 * pair. `origin` is first-write-wins: it is only applied when the target
 * row's existing `origin` is currently null (a row that already has an
 * origin is never overwritten). `authorLogin`/`headRef`/`title` are written
 * unconditionally whenever supplied — the latest known value always wins for
 * those three; a field simply omitted from `data` is left untouched on an
 * existing row (never forced to null).
 */
export interface StampOriginInput {
  origin?: PrOrigin;
  authorLogin?: string | null;
  headRef?: string | null;
  title?: string | null;
}

/**
 * A single entry in a `POST /prs/census` batch upsert — StampOriginInput
 * plus the additional fields census writes unconditionally (`state`,
 * `mergedAt`, `prCreatedAt`, and the five commit-count fields from CPP-1.1).
 * Deliberately excludes claim/phase/review/patch/blocked fields — census
 * must never touch them, so there's no way to even supply them here.
 *
 * The five commit-count fields (`commitCount`/`commitsDocsRefresh`/
 * `commitsReviewPatch`/`commitsCiFix`/`commitsImplementation`, CPP-1.1) live
 * only on this interface, not on `StampOriginInput` — only the census sweep
 * ever supplies them, so TaskService.update()'s pr_open transition and
 * claim() (the other two StampOriginInput callers) never see them.
 */
export interface CensusEntryInput extends StampOriginInput {
  repo: string;
  prNumber: number;
  state?: PrState;
  mergedAt?: string | null;
  prCreatedAt?: string | null;
  commitCount?: number | null;
  commitsDocsRefresh?: number | null;
  commitsReviewPatch?: number | null;
  commitsCiFix?: number | null;
  commitsImplementation?: number | null;
}

/**
 * Hard cap on entries per `POST /prs/census` call — bounds the shared
 * transaction's per-call work, mirroring `MAX_BULK_TASKS` in
 * task-service.ts. An over-cap batch is rejected with 400 before any write.
 */
export const MAX_CENSUS_ENTRIES = 200;

/**
 * Narrow interface for the origin-stamping dependency TaskService.update()
 * needs — just stampOrigin(), not PullRequestServiceLike's full pipeline
 * surface — so TaskService's own unit tests can inject a minimal double
 * instead of building out dozens of unrelated PR-lifecycle stub methods. A
 * real PullRequestService instance satisfies this structurally (no explicit
 * `implements` needed).
 */
export interface PrOriginStamper {
  stampOrigin(
    repo: string,
    prNumber: number,
    data: StampOriginInput,
    client?: PullRequestTxClient,
  ): Promise<PullRequest>;
}

/** Input for PullRequestService.appendFinding. */
export interface AppendFindingInput {
  ref: string;
  disposition: PrFindingDisposition;
  source: PrFindingSource;
  evidence: string;
  /** ISO timestamp. Defaults to the service's Clock.now() when omitted. */
  at?: string;
  /** Agent instance that triaged this finding. */
  agentId?: string;
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
    phase?: PrPhase,
    prCreatedAt?: string,
    authorLogin?: string | null,
    headRef?: string | null,
    title?: string | null,
  ): Promise<{ status: 200 | 201; record: PullRequest }>;
  heartbeat(id: string): Promise<PullRequest>;
  complete(id: string): Promise<PullRequest>;
  patch(
    id: string,
    commitSha?: string,
    ciFailureSignature?: string,
  ): Promise<PullRequest>;
  release(id: string): Promise<PullRequest>;
  recordSkip(id: string): Promise<PullRequest>;
  resetSkip(id: string): Promise<PullRequest>;
  claimNext(
    agentId: string,
    maxConcurrent: number,
    repos?: string[],
  ): Promise<{ pr: PullRequest; phase: PrPhase } | null>;
  appendFinding(prId: string, data: AppendFindingInput): Promise<PrFinding>;
  getEvents(
    prId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<GetEventsResult>;
  lookupBlockedPrNumbers(
    pairs: { repo: string; prNumber: number }[],
  ): Promise<Set<number>>;
  /**
   * Upsert a PullRequest row for (repo, prNumber): authorLogin/headRef/title
   * are written unconditionally when supplied; origin follows first-write-
   * wins (see StampOriginInput). When `client` is supplied, runs against it
   * directly (no nested transaction) so a caller — e.g. TaskService.update()
   * — can fold this into its own $transaction; when omitted, wraps the write
   * in its own transaction.
   */
  stampOrigin(
    repo: string,
    prNumber: number,
    data: StampOriginInput,
    client?: PullRequestTxClient,
  ): Promise<PullRequest>;
  /**
   * Batch upsert for POST /prs/census (max MAX_CENSUS_ENTRIES per call, all
   * in one transaction). Never touches claim/phase/review/patch/blocked
   * fields; new rows get phase=null, reviewState='pending', staged=false.
   * The five commit-count fields (CPP-1.1) are written unconditionally
   * whenever supplied, same as authorLogin/headRef/title.
   */
  census(entries: CensusEntryInput[]): Promise<PullRequest[]>;
  /**
   * Max `mergedAt` (ISO string) among rows scoped to `repo` whose `origin`
   * is not null, or null when no such row exists — the incremental search
   * window POM-4.1's census sweep reads via GET /prs/census/cursor.
   */
  getCensusCursor(repo: string): Promise<string | null>;
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
    if (typeof filters.repo === "string" && filters.org === undefined) {
      // Preserves today's exact-match behavior for a single repo string.
      where.repo = filters.repo;
    } else if (filters.repo !== undefined || filters.org !== undefined) {
      Object.assign(
        where,
        buildRepoOrgWhere({
          repos: toArray(filters.repo),
          orgs: toArray(filters.org),
        }),
      );
    }
    if (filters.prNumber !== undefined) where.prNumber = filters.prNumber;
    if (filters.state) where.state = filters.state as PullRequest["state"];
    if (filters.reviewState)
      where.reviewState = filters.reviewState as PullRequest["reviewState"];
    if (filters.staged !== undefined) where.staged = filters.staged;
    if (filters.ready) where.claimedBy = null;
    if (filters.origin && filters.origin.length > 0) {
      where.origin = { in: filters.origin };
    }
    if (filters.updatedSince) {
      where.updatedAt = { gte: parseUpdatedSince(filters.updatedSince) };
    }

    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;
    const orderBy = { createdAt: filters.sort ?? ("asc" as const) };

    if (filters.blocked) {
      // The blocked predicate depends on linked Task rows, which are joined
      // by (Task.repo, Task.pr) — there is no relation and no stored
      // PullRequest→Task column (PTL-3.1 dropped taskId) — so it can't be
      // expressed in the Prisma `where` above. Fetch every where-matching
      // candidate (unpaginated), compute the blocked signal in JS via a
      // single batched Task lookup, then paginate the filtered set — total
      // must reflect the post-filter count, not the raw Prisma count, or
      // pagination would be wrong.
      const candidates = await this.prisma.pullRequest.findMany({
        where,
        orderBy,
        include: { findings: true, events: true },
      });

      // Over-fetch on repo × prNumber (a cheap cross-product pre-filter,
      // since Prisma can't express "any of these (repo, pr) pairs" without
      // an OR-per-candidate query), then match exact pairs in JS below.
      const repos = [...new Set(candidates.map((pr) => pr.repo))];
      const prNumbers = [...new Set(candidates.map((pr) => pr.prNumber))];
      const tasks = candidates.length
        ? await this.prisma.task.findMany({
            where: { repo: { in: repos }, pr: { in: prNumbers } },
            select: { repo: true, pr: true, status: true },
          })
        : [];

      const tasksByPr = new Map<string, LinkedTaskBlockedInfo[]>();
      for (const task of tasks) {
        if (task.repo === null || task.pr === null) continue;
        const key = prKey(task.repo, task.pr);
        const bucket = tasksByPr.get(key);
        if (bucket) bucket.push(task);
        else tasksByPr.set(key, [task]);
      }

      const blockedPrs = candidates.filter((pr) =>
        isPrBlocked(pr, tasksByPr.get(prKey(pr.repo, pr.prNumber)) ?? []),
      );

      return {
        prs: blockedPrs.slice(offset, offset + limit),
        total: blockedPrs.length,
        limit,
        offset,
      };
    }

    const [prs, total] = await this.prisma.$transaction([
      this.prisma.pullRequest.findMany({
        where,
        orderBy,
        take: limit,
        skip: offset,
        include: { findings: true, events: true },
      }),
      this.prisma.pullRequest.count({ where }),
    ]);

    return { prs, total, limit, offset };
  }

  async get(id: string): Promise<PullRequest | null> {
    return this.prisma.pullRequest.findUnique({
      where: { id },
      include: { findings: true, events: true },
    });
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
      if (
        data.reviewState === "approved" &&
        data.readyForDeployAt === undefined
      ) {
        const existing = await this.prisma.pullRequest.findUnique({
          where: { id },
          select: { readyForDeployAt: true },
        });
        if (existing && existing.readyForDeployAt === null) {
          updateData.readyForDeployAt = this.clock.now().toISOString();
        }
      }

      // When a review session transitions reviewState to 'posted' or
      // 'approved' it is done with the record, so release its claim in the same
      // write — mirroring the state:'merged' block below. Review skills
      // historically left claimedBy/claimedAt/heartbeatAt/phase set and relied
      // on a follow-up release call that agents often skipped; a claim left
      // dangling past the reaper TTL then got reaped and its reviewState
      // regressed, re-dispatching a duplicate review (app-vitals/shipwright#1016).
      if (data.reviewState === "posted" || data.reviewState === "approved") {
        updateData.claimedBy = null;
        updateData.claimedAt = null;
        updateData.heartbeatAt = null;
        updateData.phase = null;
      }

      // deploy.md's merge-completion PATCH transitions state to 'merged' —
      // explicitly release the claim in the same call, mirroring patch()'s
      // always-release behavior. Defense-in-depth: claimNext()'s WHERE clause
      // already excludes state:'merged' records, so this is currently
      // harmless if omitted, but keeps claim state consistent regardless.
      // 'closed' gets the same treatment (CHU-2.1's PR state reconciler PATCHes
      // both merged and closed records and relies on this to clear claim
      // fields without having to send them explicitly, since claimedBy/
      // claimedAt/heartbeatAt are not in the PATCH allowlist in routes/prs.ts).
      if (data.state === "merged" || data.state === "closed") {
        updateData.claimedBy = null;
        updateData.claimedAt = null;
        updateData.heartbeatAt = null;
        updateData.phase = null;
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
   *   - Same commitSha AND claimedBy IS NOT NULL for same phase → 409. Staleness of
   *     the existing claim's heartbeat is never checked inline here — a stale claim
   *     still blocks; only the reaper (a separate process) adjudicates staleness and
   *     clears stale claims asynchronously.
   *   - Legacy review path: claimedBy IS NOT NULL AND same commitSha AND
   *     reviewState !== 'pending' → 409
   *
   * Origin stamping (POM-1.2): after the claim write succeeds (update or
   * create branch), looks up whether a Task row exists for (repo, prNumber),
   * derives a PrOrigin via deriveOrigin() (a task-row match always wins,
   * taking precedence over any author/branch-based signal), and calls
   * stampOrigin() with the same `tx` so it's atomic with the claim write.
   * stampOrigin()'s first-write-wins contract means this is safe to call on
   * every claim — an already-set origin is never overwritten, while
   * authorLogin/headRef/title are refreshed to the latest supplied value
   * every time. The final `record` returned is stampOrigin()'s return value,
   * not the raw claim-write result, so the API response reflects the
   * freshly-stamped fields.
   */
  async claim(
    repo: string,
    prNumber: number,
    commitSha: string,
    claimedBy: string,
    phase: PrPhase = "review",
    prCreatedAt?: string,
    authorLogin?: string | null,
    headRef?: string | null,
    title?: string | null,
  ): Promise<{ status: 200 | 201; record: PullRequest }> {
    const now = this.clock.now().toISOString();

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.pullRequest.findUnique({
        where: { repo_prNumber: { repo, prNumber } },
      });

      if (existing) {
        // Build update payload based on phase
        const updateData: Prisma.PullRequestUpdateInput = {
          commitSha,
          claimedBy,
          claimedAt: now,
          heartbeatAt: now,
          phase,
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

        // Re-validate the two conflict conditions in the UPDATE's own WHERE
        // clause so Postgres — holding the row lock at execution time — is the
        // sole arbiter of who wins a concurrent claim, not application-level JS
        // reading a possibly-stale findUnique() snapshot. Under READ COMMITTED
        // two racers could both pass a pre-update JS `if` against the same stale
        // read and the second writer would silently clobber the first's claim
        // (a lost-update race, CRF-1.1). Expressing the guards as negated WHERE
        // filters means the losing writer matches 0 rows and Prisma throws
        // P2025 instead — which we disambiguate into ConflictError vs
        // NotFoundError below.
        //
        // Conflict conditions (the UPDATE must match only when NEITHER holds):
        //   1. Modern phase guard: same commitSha AND already claimed AND same phase.
        //      Heartbeat staleness is not checked — a stale claim still blocks; only
        //      the reaper resolves staleness and clears stale claims.
        //   2. Legacy review guard (phase === 'review' only): already claimed, same
        //      commitSha, and reviewState !== 'pending' (covers the case where phase
        //      was not set yet). The claimedBy check keeps this guard from firing
        //      while the PR is idle (claimedBy: null) — e.g. after release()/
        //      complete() clear the claim — so a legitimate re-claim (such as the
        //      fresh-author-reply re-candidacy case) is not permanently blocked.
        const conflictConditions: Prisma.PullRequestWhereInput[] = [
          { commitSha, claimedBy: { not: null }, phase },
        ];
        if (phase === "review") {
          conflictConditions.push({
            commitSha,
            claimedBy: { not: null },
            reviewState: { not: "pending" },
          });
        }

        try {
          const record = await tx.pullRequest.update({
            where: {
              id: existing.id,
              NOT: { OR: conflictConditions },
            },
            data: updateData,
          });
          // Audit the claim transition against the pre-update snapshot, inside
          // the same tx (the CRF-1.1 WHERE-guard/conflict-detection logic above
          // is untouched — recordTransition only runs once the update succeeds).
          await this.recordTransition(tx, existing, record, "claim", claimedBy);
          const stamped = await this.stampClaimOrigin(
            tx,
            repo,
            prNumber,
            authorLogin,
            headRef,
            title,
          );
          return { status: 200 as const, record: stamped };
        } catch (err: unknown) {
          // The combined WHERE matched 0 rows → Prisma throws P2025. Distinguish
          // the two causes: the row still exists (a concurrent claim() now
          // satisfies a conflict condition — the expected outcome this fix
          // closes the race for) → ConflictError; the row was deleted entirely
          // (much rarer) → genuine NotFoundError.
          if (
            typeof err === "object" &&
            err !== null &&
            "code" in err &&
            (err as { code: string }).code === "P2025"
          ) {
            const stillExists = await tx.pullRequest.findUnique({
              where: { id: existing.id },
              select: { id: true },
            });
            if (stillExists) {
              throw new ConflictError(
                `pr ${repo}#${prNumber} is already claimed with the same commit`,
              );
            }
            throw new NotFoundError(`pr ${repo}#${prNumber} not found`);
          }
          throw err;
        }
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

        await tx.pullRequest.create({ data: createData });
        const stamped = await this.stampClaimOrigin(
          tx,
          repo,
          prNumber,
          authorLogin,
          headRef,
          title,
        );
        return { status: 201 as const, record: stamped };
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

  /**
   * Touch heartbeatAt for liveness. Errors if the PR is missing.
   *
   * Deliberately writes NO audit event and stays outside a $transaction: a bare
   * heartbeat only ever changes heartbeatAt, which is excluded from the audit
   * trail (see computePrTransitionDiff), so recordTransition() would be a
   * guaranteed no-op here. Skipping it entirely keeps this hot liveness path a
   * single cheap UPDATE. (This is the concrete realization of acceptance
   * criterion 3: a bare heartbeat() writes zero event rows.)
   */
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

  /** Mark a PR review as posted. Increments reviewCycles, sets reviewState=posted, reviewedAt, and readyForPatchAt, and releases the claim. */
  async complete(id: string): Promise<PullRequest> {
    const now = this.clock.now().toISOString();
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Capture the before-state up front — the actor is the current
        // claimant, which the same update clears to null.
        const before = await tx.pullRequest.findUnique({ where: { id } });
        const record = await tx.pullRequest.update({
          where: { id },
          data: {
            reviewCycles: { increment: 1 },
            reviewState: "posted",
            reviewedAt: now,
            readyForPatchAt: now,
            // The review session is done with the record, so release its claim
            // in the same write — mirroring update()'s posted/approved release.
            // This is the path the review flow actually uses
            // (POST /prs/:id/complete), so without the clear the claim lingers
            // until the reaper TTL and the stale-claim reap re-dispatches a
            // duplicate review (app-vitals/shipwright#1016).
            claimedBy: null,
            claimedAt: null,
            heartbeatAt: null,
            phase: null,
          },
        });
        await this.recordTransition(
          tx,
          before,
          record,
          "complete",
          before?.claimedBy ?? null,
        );
        return record;
      });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "pr not found");
    }
  }

  /**
   * Increment patch cycles and always release the claim — the patch invocation
   * is complete regardless of outcome. Sets patchCycles+1, patchedAt=now, and
   * clears claimedBy/claimedAt/heartbeatAt/phase to null (mirrors release()'s
   * claim-clearing, extended to phase).
   *
   * reviewState reset is conditional on `commitSha`:
   *   - commitSha omitted: reviewState unconditionally resets to 'pending'
   *     (legacy behavior — preserved for callers not yet passing commitSha).
   *   - commitSha provided and differs from the record's stored commitSha: a
   *     real fix landed — reviewState resets to 'pending' and commitSha is
   *     updated to the new value.
   *   - commitSha provided and matches the record's stored commitSha: a no-op
   *     patch cycle — reviewState is left untouched entirely (absent from the
   *     update payload, so Prisma does not touch it).
   *
   * Root-cause fix for PR app-vitals/shipwright#1321's review pile-up: patch()
   * was unconditionally resetting reviewState even on no-op cycles, causing
   * findings to be re-reviewed forever.
   *
   * CI-failure streak tracking is entirely independent of the reviewState
   * logic above and self-contained (no linked-task lookup), mirroring
   * recordSkip()'s auto-block pattern:
   *   - ciFailureSignature omitted: lastCiFailureSignature/
   *     consecutiveCiFailureCount are left untouched (absent from the update
   *     payload) — covers merge-conflict/review-fix patch calls unrelated to
   *     CI.
   *   - ciFailureSignature provided and matches the record's stored
   *     lastCiFailureSignature: increments consecutiveCiFailureCount.
   *   - ciFailureSignature provided and differs (or none stored yet): resets
   *     consecutiveCiFailureCount to 1 and stores the new signature.
   *   - Crossing CI_FAILURE_BLOCK_THRESHOLD (3) on a matching-signature
   *     increment also sets blocked:true + a descriptive blockedReason, in the
   *     same request/update call. A reset never trips the threshold, even if
   *     the prior count was at/above it.
   */
  async patch(
    id: string,
    commitSha?: string,
    ciFailureSignature?: string,
  ): Promise<PullRequest> {
    const now = this.clock.now().toISOString();

    const updateData: Prisma.PullRequestUpdateInput = {
      patchCycles: { increment: 1 },
      patchedAt: now,
      claimedBy: null,
      claimedAt: null,
      heartbeatAt: null,
      phase: null,
    };

    // Always read the before-state (rather than only when commitSha/
    // ciFailureSignature is provided as before): recordTransition needs a
    // "before" snapshot to diff against, and reading it inside the tx keeps the
    // audit atomic with the update. When neither optional arg is provided the
    // read also stands in for the update's own existence check.
    return await this.prisma.$transaction(async (tx) => {
      const existing = await tx.pullRequest.findUnique({ where: { id } });

      // A missing record is a NotFoundError regardless of which args were
      // passed. (Previously the no-arg path let the update's own P2025 surface
      // via translateNotFound; reading the record up front for the audit diff
      // means we detect the absence here and throw the same NotFoundError.)
      if (!existing) {
        throw new NotFoundError("pr not found");
      }

      if (commitSha === undefined) {
        updateData.reviewState = "pending";
      } else if (existing.commitSha !== commitSha) {
        updateData.reviewState = "pending";
        updateData.commitSha = commitSha;
      }

      if (ciFailureSignature !== undefined) {
        if (existing.lastCiFailureSignature === ciFailureSignature) {
          updateData.consecutiveCiFailureCount = { increment: 1 };
          const newCount = existing.consecutiveCiFailureCount + 1;
          if (newCount >= CI_FAILURE_BLOCK_THRESHOLD) {
            updateData.blocked = true;
            updateData.blockedReason = `Auto-blocked after ${newCount} consecutive patch cycles hitting the same CI failure (${ciFailureSignature})`;
          }
        } else {
          updateData.consecutiveCiFailureCount = 1;
          updateData.lastCiFailureSignature = ciFailureSignature;
        }
      }

      const record = await tx.pullRequest.update({
        where: { id },
        data: updateData,
      });
      await this.recordTransition(
        tx,
        existing,
        record,
        "patch",
        existing.claimedBy ?? null,
      );
      return record;
    });
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
    // Cutoff for "fresh" heartbeat — mirrors the reaper's own default
    // (DEFAULT_CLAIM_TTL_MS in @shipwright/lib/claim-ttl).
    const cutoffMs = Number(
      process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS ?? DEFAULT_CLAIM_TTL_MS,
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
      const target = await tx.pullRequest.findUnique({
        where: { id: targetId },
      });
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

      // Audit the claim transition against the pre-claim snapshot (`target`),
      // inside the same tx as the update above. Actor is the claiming agent.
      await this.recordTransition(tx, target, pr, "claimNext", agentId);

      return { pr, phase };
    });
  }

  /**
   * Unclaim a PR — always clears claim fields (claimedBy/claimedAt/heartbeatAt).
   * reviewState is reset to 'pending' only if it is not already a terminal
   * value ('posted' or 'approved'); a terminal reviewState is left untouched.
   *
   * Without this guard, a caller racing /complete or a direct PATCH that just
   * set reviewState='posted'/'approved' would have that terminal verdict
   * clobbered back to 'pending' by a subsequent release(), causing
   * check-review / /shipwright:review to re-process a PR that was already
   * reviewed and terminally verdicted on GitHub (18+ documented recurrences,
   * app-vitals/shipwright CHU-2.3). Mirrors the same terminal-state guard
   * already used by update() (posted/approved release, ~line 191) and
   * patch()'s no-op-cycle guard (~line 411), and StaleClaimReaper.reap()'s
   * equivalent SQL CASE expression.
   */
  async release(id: string): Promise<PullRequest> {
    // Existence check stays outside the transaction (preserves the existing
    // synchronous-NotFoundError-before-any-write behavior), but is used only
    // for that check now — the audit `before` snapshot is re-read inside the
    // transaction below so a concurrent write in the gap can't produce a
    // stale `oldValue` in the persisted PullRequestEvent row.
    const existsCheck = await this.prisma.pullRequest.findUnique({
      where: { id },
    });
    if (!existsCheck) {
      throw new NotFoundError("pr not found");
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.pullRequest.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundError("pr not found");
        }

        const updateData: Prisma.PullRequestUpdateInput = {
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
        };
        if (
          existing.reviewState !== "posted" &&
          existing.reviewState !== "approved"
        ) {
          updateData.reviewState = "pending";
        }

        const record = await tx.pullRequest.update({
          where: { id },
          data: updateData,
        });
        // Actor is whoever held the claim being given up.
        await this.recordTransition(
          tx,
          existing,
          record,
          "release",
          existing.claimedBy ?? null,
        );
        return record;
      });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "pr not found");
    }
  }

  /**
   * Record a skip: atomically increments skipCount and sets lastSkippedAt.
   * When the new skipCount crosses SKIP_BLOCK_THRESHOLD (3), also sets
   * blocked:true + a descriptive blockedReason in the same request — self
   * contained, no linked-task lookup needed. Every call increments
   * regardless of current count (not a guard), and re-checks the threshold
   * each time in case a prior resetSkip() brought the count back down.
   */
  async recordSkip(id: string): Promise<PullRequest> {
    const now = this.clock.now().toISOString();
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Snapshot before the first update so the audit diff spans the whole
        // recordSkip (both the increment and any threshold auto-block).
        const before = await tx.pullRequest.findUnique({ where: { id } });
        let updated = await tx.pullRequest.update({
          where: { id },
          data: { skipCount: { increment: 1 }, lastSkippedAt: now },
        });
        if (updated.skipCount >= SKIP_BLOCK_THRESHOLD) {
          updated = await tx.pullRequest.update({
            where: { id },
            data: {
              blocked: true,
              blockedReason: `Auto-blocked after ${updated.skipCount} consecutive skips (dispatched but found nothing to do)`,
            },
          });
        }
        // Actor is the claim holder if any; recordSkip can fire on unclaimed
        // PRs (no actor in scope at the route), in which case attribute to
        // "system".
        await this.recordTransition(
          tx,
          before,
          updated,
          "recordSkip",
          before?.claimedBy ?? "system",
        );
        return updated;
      });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "pr not found");
    }
  }

  /**
   * Reset skip tracking — sets skipCount back to 0 and lastSkippedAt to null.
   * If the PR is currently blocked AND its blockedReason matches the
   * skip-auto-block message pattern set by recordSkip() (contains
   * "consecutive skips"), also clears blocked:false and blockedReason:null
   * in the same update — giving a human-retried PR a way back into
   * candidacy. A block set by a different mechanism (e.g. the CI-failure-
   * streak auto-block in patch()) is left untouched.
   */
  async resetSkip(id: string): Promise<PullRequest> {
    // Existence check stays outside the transaction (preserves the existing
    // synchronous-NotFoundError-before-any-write behavior), but is used only
    // for that check now — the audit `before` snapshot is re-read inside the
    // transaction below so a concurrent write in the gap can't produce a
    // stale `oldValue` in the persisted PullRequestEvent row.
    const existsCheck = await this.prisma.pullRequest.findUnique({
      where: { id },
    });
    if (!existsCheck) {
      throw new NotFoundError("pr not found");
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.pullRequest.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundError("pr not found");
        }

        const updateData: Prisma.PullRequestUpdateInput = {
          skipCount: 0,
          lastSkippedAt: null,
        };
        if (
          existing.blocked &&
          existing.blockedReason?.includes("consecutive skips")
        ) {
          updateData.blocked = false;
          updateData.blockedReason = null;
        }

        const record = await tx.pullRequest.update({
          where: { id },
          data: updateData,
        });
        await this.recordTransition(
          tx,
          existing,
          record,
          "resetSkip",
          existing.claimedBy ?? "system",
        );
        return record;
      });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "pr not found");
    }
  }

  /**
   * Append a PrFinding row to a PR — a single unlocked INSERT, race-safe
   * against concurrent writers (see the schema.prisma comment on PrFinding
   * for the rationale: a JSON-array read-modify-write PATCH is not race-safe,
   * a plain INSERT is). Validates the PR exists first via an explicit
   * findUnique() check (rather than letting a bad prRecordId surface as a
   * Prisma P2003 FK-violation error) so callers get a clean 404 via
   * NotFoundError, matching the translateNotFound pattern used elsewhere.
   *
   * Server-side source/disposition authority enforcement (source:'patch' may
   * only submit disposition:'rejected') lives in the route handler
   * (routes/prs.ts), consistent with this codebase's existing pattern of
   * validating request fields inline in the handler before calling the
   * service (see claimRoute's repo/prNumber/commitSha checks).
   *
   * `at` defaults to this.clock.now() when the caller omits it, keeping the
   * route handler thin (mirrors this.clock usage elsewhere in this class).
   */
  async appendFinding(
    prId: string,
    data: AppendFindingInput,
  ): Promise<PrFinding> {
    const existing = await this.prisma.pullRequest.findUnique({
      where: { id: prId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundError("pr not found");
    }

    return this.prisma.prFinding.create({
      data: {
        prRecordId: prId,
        ref: data.ref,
        disposition: data.disposition,
        source: data.source,
        evidence: data.evidence,
        at: data.at ?? this.clock.now().toISOString(),
        agentId: data.agentId ?? null,
      },
    });
  }

  /**
   * Fetch a PR's PullRequestEvent audit trail (PSA-1.2), ordered by `at`
   * ascending (oldest first) — uses the (prRecordId, at) index (PSA-1.1).
   * Existence-checks the PR first (mirrors appendFinding()) so a missing PR
   * surfaces as a clean NotFoundError rather than an empty result being
   * indistinguishable from "PR exists but has zero events".
   */
  async getEvents(
    prId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<GetEventsResult> {
    const existing = await this.prisma.pullRequest.findUnique({
      where: { id: prId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundError("pr not found");
    }

    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const [events, total] = await this.prisma.$transaction([
      this.prisma.pullRequestEvent.findMany({
        where: { prRecordId: prId },
        orderBy: { at: "asc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.pullRequestEvent.count({ where: { prRecordId: prId } }),
    ]);

    return { events, total };
  }

  /**
   * Given a batch of (repo, prNumber) pairs — typically every linked-PR
   * reference across a set of tasks — return the subset of prNumbers whose
   * PullRequest record has `blocked === true`, in ONE query. Built for
   * SessionService.list()/get() (SESH-2.2): computeSessionRollup()'s
   * `prBlockedSet` param needs exactly this signal, and batching the lookup
   * across an entire session list avoids a per-session round trip.
   *
   * Deliberately narrower than the private isPrBlocked()/list({blocked:true})
   * pair above: this does NOT also consult linked-task status. Callers here
   * already have the full task set for their own use (SessionService reads
   * every Task row for the sessions it's rolling up) and
   * computeSessionRollup's classifyWaiting() independently checks
   * `task.status === "blocked"` with higher precedence than pr_blocked — so
   * re-deriving task-blocked-ness inside this helper would be redundant.
   *
   * Mirrors list()'s `{blocked:true}` branch: over-fetch on the repo ×
   * prNumber cross-product (Prisma can't express "any of these (repo, pr)
   * pairs" without an OR-per-pair query), then filter exact pairs in JS via
   * the shared prKey() helper. Returns a Set of prNumbers ONLY (not repo+
   * prNumber pairs) — matches computeSessionRollup's prBlockedSet shape,
   * itself a pre-existing limitation carried over from SESH-2.1 (a task's pr
   * field alone, without its repo, is what's compared against the set).
   */
  async lookupBlockedPrNumbers(
    pairs: { repo: string; prNumber: number }[],
  ): Promise<Set<number>> {
    if (pairs.length === 0) return new Set();

    const repos = [...new Set(pairs.map((p) => p.repo))];
    const prNumbers = [...new Set(pairs.map((p) => p.prNumber))];
    const rows = await this.prisma.pullRequest.findMany({
      where: {
        repo: { in: repos },
        prNumber: { in: prNumbers },
        blocked: true,
      },
      select: { repo: true, prNumber: true },
    });

    const exactPairs = new Set(pairs.map((p) => prKey(p.repo, p.prNumber)));
    const result = new Set<number>();
    for (const row of rows) {
      if (exactPairs.has(prKey(row.repo, row.prNumber))) {
        result.add(row.prNumber);
      }
    }
    return result;
  }

  // ─── Origin metrics (POM-1.1 / POM-1.2) ─────────────────────────────────────

  /**
   * claim()'s origin-stamping tail call (POM-1.2): looks up whether a Task
   * row links (repo, prNumber), derives a PrOrigin via deriveOrigin() (a
   * task-row match always wins over any author/branch-based signal), and
   * calls stampOrigin() against the same `tx` so the origin write is atomic
   * with the claim write that preceded it. Returns stampOrigin()'s record —
   * the final value claim() returns to its caller.
   */
  private async stampClaimOrigin(
    tx: Prisma.TransactionClient,
    repo: string,
    prNumber: number,
    authorLogin: string | null | undefined,
    headRef: string | null | undefined,
    title: string | null | undefined,
  ): Promise<PullRequest> {
    const linkedTask = await tx.task.findFirst({
      where: { repo, pr: prNumber },
      select: { id: true },
    });
    const origin = deriveOrigin({
      hasLinkedTask: linkedTask !== null,
      authorLogin,
      headRef,
    });
    return this.stampOrigin(repo, prNumber, { origin, authorLogin, headRef, title }, tx);
  }

  async stampOrigin(
    repo: string,
    prNumber: number,
    data: StampOriginInput,
    client?: PullRequestTxClient,
  ): Promise<PullRequest> {
    const entry: CensusEntryInput = { repo, prNumber, ...data };
    if (client) {
      return this.upsertOriginFields(client, entry);
    }
    return this.prisma.$transaction((tx) => this.upsertOriginFields(tx, entry));
  }

  async census(entries: CensusEntryInput[]): Promise<PullRequest[]> {
    if (entries.length > MAX_CENSUS_ENTRIES) {
      throw new BadRequestError(
        `census accepts at most ${MAX_CENSUS_ENTRIES} entries per call (received ${entries.length}) — split the batch`,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const results: PullRequest[] = [];
      for (const entry of entries) {
        results.push(await this.upsertOriginFields(tx, entry));
      }
      return results;
    });
  }

  async getCensusCursor(repo: string): Promise<string | null> {
    const row = await this.prisma.pullRequest.findFirst({
      where: { repo, origin: { not: null }, mergedAt: { not: null } },
      orderBy: { mergedAt: "desc" },
      select: { mergedAt: true },
    });
    return row?.mergedAt ?? null;
  }

  /**
   * Core upsert shared by stampOrigin() and census(): findUnique by the
   * (repo, prNumber) unique key, then either update (authorLogin/headRef/
   * title/state/mergedAt/prCreatedAt/commitCount/commitsDocsRefresh/
   * commitsReviewPatch/commitsCiFix/commitsImplementation written
   * unconditionally when supplied; origin only when currently null) or
   * create (new rows pick up the schema's own phase=null/
   * reviewState='pending'/staged=false defaults — left absent from
   * createData rather than restated here, so a future default change
   * doesn't need updating in two places).
   *
   * Deliberately does NOT call recordTransition()/write PullRequestEvent
   * rows — stampOrigin/census are metrics-plumbing writes, not pipeline
   * lifecycle transitions, and origin/authorLogin/headRef/title are not in
   * pr-transition-diff.ts's AUDITED_FIELDS allowlist.
   *
   * A concurrent create race (two callers upserting the same never-before-
   * seen (repo, prNumber) at once) surfaces as Prisma P2002; the loser
   * retries once as a plain update against the now-existing row rather than
   * surfacing a 409 — stampOrigin/census are idempotent upserts, not claims.
   */
  private async upsertOriginFields(
    client: PullRequestTxClient,
    entry: CensusEntryInput,
  ): Promise<PullRequest> {
    const {
      repo,
      prNumber,
      origin,
      authorLogin,
      headRef,
      title,
      state,
      mergedAt,
      prCreatedAt,
      commitCount,
      commitsDocsRefresh,
      commitsReviewPatch,
      commitsCiFix,
      commitsImplementation,
    } = entry;

    const existing = await client.pullRequest.findUnique({
      where: { repo_prNumber: { repo, prNumber } },
    });

    // First-write-wins: only apply `origin` when it was supplied AND the
    // target row (if any) doesn't already have a non-null origin.
    const resolvedOrigin =
      origin !== undefined && (!existing || existing.origin === null)
        ? origin
        : undefined;

    if (existing) {
      const updateData: Prisma.PullRequestUpdateInput = {};
      if (authorLogin !== undefined) updateData.authorLogin = authorLogin;
      if (headRef !== undefined) updateData.headRef = headRef;
      if (title !== undefined) updateData.title = title;
      if (state !== undefined) updateData.state = state;
      if (mergedAt !== undefined) updateData.mergedAt = mergedAt;
      if (prCreatedAt !== undefined) updateData.prCreatedAt = prCreatedAt;
      if (commitCount !== undefined) updateData.commitCount = commitCount;
      if (commitsDocsRefresh !== undefined)
        updateData.commitsDocsRefresh = commitsDocsRefresh;
      if (commitsReviewPatch !== undefined)
        updateData.commitsReviewPatch = commitsReviewPatch;
      if (commitsCiFix !== undefined) updateData.commitsCiFix = commitsCiFix;
      if (commitsImplementation !== undefined)
        updateData.commitsImplementation = commitsImplementation;
      if (resolvedOrigin !== undefined) updateData.origin = resolvedOrigin;

      if (Object.keys(updateData).length === 0) return existing;

      return client.pullRequest.update({
        where: { id: existing.id },
        data: updateData,
      });
    }

    try {
      return await client.pullRequest.create({
        data: {
          repo,
          prNumber,
          authorLogin: authorLogin ?? null,
          headRef: headRef ?? null,
          title: title ?? null,
          origin: resolvedOrigin ?? null,
          ...(state !== undefined ? { state } : {}),
          mergedAt: mergedAt ?? null,
          prCreatedAt: prCreatedAt ?? null,
          commitCount: commitCount ?? null,
          commitsDocsRefresh: commitsDocsRefresh ?? null,
          commitsReviewPatch: commitsReviewPatch ?? null,
          commitsCiFix: commitsCiFix ?? null,
          commitsImplementation: commitsImplementation ?? null,
        },
      });
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "P2002"
      ) {
        // Lost a concurrent create race — the row now exists; retry once as
        // a plain update against it.
        return this.upsertOriginFields(client, entry);
      }
      throw err;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Write the audit trail for a single mutation: diff `before` vs `after` and
   * insert one PullRequestEvent row per changed, auditable field. Runs on the
   * same `tx` the source update ran on, so the event rows land atomically with
   * the field change (or not at all).
   *
   * heartbeatAt-only changes produce zero rows (see computePrTransitionDiff);
   * a create-path `before === null` also produces zero rows. Every row is
   * stamped with the same `at` timestamp from the injected Clock so an entire
   * transition's rows share one instant, and carries the `method` name and
   * `actor` that drove the write for later diagnostics.
   */
  private async recordTransition(
    tx: PrismaTxClient,
    before: PullRequest | null,
    after: PullRequest,
    method: string,
    actor: string | null,
  ): Promise<void> {
    const changes = computePrTransitionDiff(before, after);
    if (changes.length === 0) return;
    const at = this.clock.now().toISOString();
    for (const change of changes) {
      await tx.pullRequestEvent.create({
        data: {
          prRecordId: after.id,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          actor,
          method,
          at,
        },
      });
    }
  }

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
