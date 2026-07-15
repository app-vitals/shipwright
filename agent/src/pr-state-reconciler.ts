/**
 * agent/src/pr-state-reconciler.ts
 *
 * PR state reconciler — self-heals task-store PullRequest records left
 * state:"open" after an untracked merge/close (a session crashed or hung
 * AFTER the real work happened on GitHub but BEFORE the completion PATCH
 * ran). Mirrors task-store's own StaleClaimReaper pattern (batch-scan +
 * per-item resolve + defensive continue-on-error) — see
 * task-store/src/stale-claim-reaper.ts — but lives in agent/src since it
 * needs GitHub read access, which agent/src/check-helpers.ts already
 * provides (ghJson, resolveAllRepos, splitOrgRepo, createTaskStoreClient).
 *
 * Unlike the claim reaper (crash backstop for the *claim* fields only), this
 * reconciles the *business state* (state/mergedAt) against GitHub reality,
 * closing the gap CHU-1.x left: check-deploy.ts/check-review.ts/check-patch.ts
 * only ever scan GitHub's *open* PR list, so a merged/closed PR silently
 * drops out of view before its task-store record gets corrected.
 *
 * This is a pure background interval (agent/src/index.ts), not a Claude
 * session and not folded into the loop-orchestrator's per-tick candidate
 * collection — purely mechanical field sync, no judgment required, and
 * running it every tick would multiply gh API calls unnecessarily.
 *
 * Usage: register via setInterval(() => void reconciler.reconcile(), <ms>)
 * with a 30-60 minute interval — see agent/src/index.ts.
 *
 * CHU-2.2 extends this module with a second, causally distinct step:
 * `reconcileReviewState()` self-heals task-store reviewState:"pending"
 * records that are actually terminal on GitHub. Unlike the state/mergedAt
 * drift above (a crash/hang case), this drift comes from an out-of-band
 * reviewer — a review posted directly to GitHub by an identity not wired
 * into any code path that writes to the task-store — so a stuck-pending
 * record would otherwise re-trigger check-review.ts's eligibility gate
 * (agent/src/check-review.ts) forever, spawning a full review sub-agent
 * every time even though nothing is left to review. It shares this file's
 * repo-iteration/page-until-partial/continue-on-error scaffolding and reuses
 * the SAME setInterval tick in agent/src/index.ts — not a second timer.
 */

import type { PrReviewData } from "./check-patch.ts";
import {
  isCleanApproveBody,
  resolveAllRepos,
  resolveWorkspacePath,
  splitOrgRepo,
} from "./check-helpers.ts";
import type { Clock } from "./clock.ts";
import { SystemClock } from "./clock.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal shape of a task-store PullRequest record this reconciler needs. */
export interface PrStateRecord {
  id: string;
  repo: string;
  prNumber: number;
  state: string;
}

/** Result of `gh pr view <n> --json state,mergedAt`. */
export interface GhPrView {
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
}

export interface PrStateReconcilerDeps {
  repos: string[];
  /** Page size for listing state:"open" records; defaults to the task-store's own default (50). */
  pageLimit?: number;
  /** List one page of state:"open" PR records for a repo. */
  listOpenPrRecords: (
    repo: string,
    limit: number,
    offset: number,
  ) => Promise<PrStateRecord[]>;
  /** PATCH a task-store PR record's fields. */
  patchPrRecord: (id: string, fields: Record<string, unknown>) => Promise<void>;
  /** Fetch live GitHub state for a single PR. Throws on lookup failure. */
  ghViewPr: (repo: string, prNumber: number) => Promise<GhPrView>;
}

/** Minimal shape of a task-store PullRequest record reviewState reconciliation needs. */
export interface PrReviewStateRecord {
  id: string;
  repo: string;
  prNumber: number;
  claimedBy: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
}

export interface PrReviewStateReconcilerDeps {
  repos: string[];
  /** Page size for listing reviewState:"pending" records; defaults to the task-store's own default (50). */
  pageLimit?: number;
  /** Injected time source — never call Date.now()/new Date() directly. */
  clock: Clock;
  /** Claim freshness window in ms; defaults to 2_100_000 (mirrors SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS's own default). */
  claimTtlMs?: number;
  /** List one page of state:"open" && reviewState:"pending" PR records for a repo. */
  listPendingReviewRecords: (
    repo: string,
    limit: number,
    offset: number,
  ) => Promise<PrReviewStateRecord[]>;
  /** Fetch head commit + reviews + review threads for a single PR. Throws on lookup failure. */
  fetchPrReviews: (
    org: string,
    repo: string,
    prNumber: number,
  ) => Promise<PrReviewData>;
  /** PATCH a task-store PR record's fields. */
  patchPrRecord: (id: string, fields: Record<string, unknown>) => Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_LIMIT = 50;
const DEFAULT_CLAIM_TTL_MS = 2_100_000;

/** Map GitHub's uppercase PR state to the task-store's lowercase PrState enum. */
function mapGhStateToPrState(
  state: GhPrView["state"],
): "merged" | "closed" | null {
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return null; // still OPEN on GitHub — nothing to reconcile
}

/**
 * List every state:"open" PR record for a repo, paging through the
 * task-store's default 50-record page until a page returns fewer than
 * `limit` records.
 */
async function listAllOpenRecords(
  deps: PrStateReconcilerDeps,
  repo: string,
): Promise<PrStateRecord[]> {
  const limit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const records: PrStateRecord[] = [];
  let offset = 0;

  for (;;) {
    const page = await deps.listOpenPrRecords(repo, limit, offset);
    records.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return records;
}

/**
 * Reconcile a single PR record against live GitHub state. Issues a PATCH
 * only when GitHub reports MERGED or CLOSED while the record still says
 * "open" — records still OPEN on GitHub are left completely untouched.
 */
async function reconcileRecord(
  deps: PrStateReconcilerDeps,
  record: PrStateRecord,
): Promise<void> {
  const ghState = await deps.ghViewPr(record.repo, record.prNumber);
  const newState = mapGhStateToPrState(ghState.state);
  if (newState === null) return; // still open on GitHub — no-op

  // claimedBy/claimedAt/heartbeatAt aren't in routes/prs.ts's PATCH
  // allowlist, so including them here is documentation-of-intent rather than
  // a functional requirement — the actual clearing happens server-side in
  // PullRequestService.update()'s state === "merged" || "closed" special
  // case (mirrors CHU-1.3's pattern). `phase` IS allowlisted and is included
  // here for defense-in-depth alongside the server-side clear.
  const fields: Record<string, unknown> = {
    state: newState,
    claimedBy: null,
    claimedAt: null,
    heartbeatAt: null,
    phase: null,
  };
  if (newState === "merged" && ghState.mergedAt) {
    fields.mergedAt = ghState.mergedAt;
  }

  await deps.patchPrRecord(record.id, fields);
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Scan every repo's state:"open" PR records, compare each against live
 * GitHub state, and PATCH only the ones that disagree (GitHub shows
 * MERGED/CLOSED but the record still says "open"). A single per-PR gh
 * lookup failure is logged and does not abort reconciliation of the rest
 * of the batch.
 */
export async function reconcilePrState(
  deps: PrStateReconcilerDeps,
): Promise<void> {
  for (const repo of deps.repos) {
    let records: PrStateRecord[];
    try {
      records = await listAllOpenRecords(deps, repo);
    } catch (err) {
      console.error(
        `[pr-state-reconciler] failed to list open PRs for ${repo}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }

    for (const record of records) {
      try {
        await reconcileRecord(deps, record);
      } catch (err) {
        console.error(
          `[pr-state-reconciler] failed to reconcile ${repo}#${record.prNumber}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
}

// ─── reconcileReviewState ───────────────────────────────────────────────────────

/**
 * Classify a PR's review state from live GitHub review data. Mirrors the
 * SHAPE of check-patch.ts's private `hasUnaddressedFindings` filtering
 * (reviews-at-head, unresolved-threads-or-non-empty-body) but keyed on
 * `isCleanApproveBody` for the approve/non-finding split instead of
 * self-authorship — this reconciler exists specifically to catch an
 * OUT-OF-BAND reviewer, so ANY author's clean-approve-shaped COMMENTED
 * review counts, not just self-authored ones.
 *
 * Returns:
 *   - "approved" — a real APPROVED review, or a clean-approve-shaped
 *     COMMENTED review, at the current head commit.
 *   - "posted" — a terminal (no unresolved threads, no qualifying non-empty
 *     finding body) non-approve review at the current head commit.
 *   - null — no review at all at the current head commit, OR a genuine
 *     unaddressed finding at the current head commit. Both cases must leave
 *     the record completely untouched.
 */
function classifyReviewState(data: PrReviewData): "approved" | "posted" | null {
  const { headRefOid, reviews, reviewThreads } = data;
  const reviewsAtHead = reviews.nodes.filter(
    (r) => r.commit.oid === headRefOid,
  );
  if (reviewsAtHead.length === 0) return null; // nothing at head — untouched

  const hasApprove = reviewsAtHead.some(
    (r) =>
      r.state === "APPROVED" ||
      (r.state === "COMMENTED" && isCleanApproveBody(r.body)),
  );
  if (hasApprove) return "approved";

  const qualifyingReviews = reviewsAtHead.filter(
    (r) =>
      (r.state === "COMMENTED" || r.state === "CHANGES_REQUESTED") &&
      !isCleanApproveBody(r.body),
  );
  if (qualifyingReviews.length === 0) return "posted"; // terminal, non-finding

  const unresolvedThreads = reviewThreads.nodes.filter((t) => !t.isResolved);
  if (unresolvedThreads.length > 0) return null; // genuine finding — untouched

  const hasFindingBody = qualifyingReviews.some(
    (r) => r.body.trim().length > 0,
  );
  if (hasFindingBody) return null; // genuine finding — untouched

  return "posted"; // terminal, non-approve, no finding
}

/**
 * A record is "actively claimed" (skip it — never overwrite a live claim's
 * reviewState) when `claimedBy` is set AND its freshness timestamp
 * (`heartbeatAt`, falling back to `claimedAt` when null) is within the claim
 * TTL window of `clock.now()`. If `claimedBy` is null, or both timestamps
 * are null, the record is NOT actively claimed.
 */
function isActivelyClaimed(
  record: PrReviewStateRecord,
  clock: Clock,
  claimTtlMs: number,
): boolean {
  if (!record.claimedBy) return false;
  const freshnessTimestamp = record.heartbeatAt ?? record.claimedAt;
  if (!freshnessTimestamp) return false;
  const cutoff = clock.now().getTime() - claimTtlMs;
  return new Date(freshnessTimestamp).getTime() >= cutoff;
}

/**
 * List every reviewState:"pending" PR record for a repo, paging through the
 * task-store's default 50-record page until a page returns fewer than
 * `limit` records.
 */
async function listAllPendingReviewRecords(
  deps: PrReviewStateReconcilerDeps,
  repo: string,
): Promise<PrReviewStateRecord[]> {
  const limit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const records: PrReviewStateRecord[] = [];
  let offset = 0;

  for (;;) {
    const page = await deps.listPendingReviewRecords(repo, limit, offset);
    records.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return records;
}

/**
 * Reconcile a single reviewState:"pending" record against live GitHub
 * review data. Skips actively-claimed records without any GitHub call.
 * Issues a PATCH only when GitHub shows a terminal review at the PR's
 * current head commit — a genuine unaddressed finding, a stale-commit-only
 * review, or no review at all are all left completely untouched.
 */
async function reconcileReviewStateRecord(
  deps: PrReviewStateReconcilerDeps,
  record: PrReviewStateRecord,
): Promise<void> {
  const claimTtlMs = deps.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  if (isActivelyClaimed(record, deps.clock, claimTtlMs)) return; // live claim — never overwrite

  const [org, repoName] = splitOrgRepo(record.repo);
  const reviewData = await deps.fetchPrReviews(org, repoName, record.prNumber);
  const newReviewState = classifyReviewState(reviewData);
  if (newReviewState === null) return; // nothing terminal at head — no-op

  await deps.patchPrRecord(record.id, { reviewState: newReviewState });
}

/**
 * Scan every repo's reviewState:"pending" PR records, compare each against
 * live GitHub review data, and PATCH only the ones that have gone terminal
 * at the current head commit (an out-of-band reviewer posted an APPROVED or
 * clean-approve-shaped/terminal review directly to GitHub). A single
 * per-record failure (claim check aside) is logged and does not abort
 * reconciliation of the rest of the batch.
 */
export async function reconcileReviewState(
  deps: PrReviewStateReconcilerDeps,
): Promise<void> {
  for (const repo of deps.repos) {
    let records: PrReviewStateRecord[];
    try {
      records = await listAllPendingReviewRecords(deps, repo);
    } catch (err) {
      console.error(
        `[pr-state-reconciler:review] failed to list pending-review PRs for ${repo}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }

    for (const record of records) {
      try {
        await reconcileReviewStateRecord(deps, record);
      } catch (err) {
        console.error(
          `[pr-state-reconciler:review] failed to reconcile ${repo}#${record.prNumber}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
}

// ─── Production deps ──────────────────────────────────────────────────────────

interface PrListResponseJson {
  prs: PrStateRecord[];
  total: number;
  limit: number;
  offset: number;
}

interface PrReviewListResponseJson {
  prs: PrReviewStateRecord[];
  total: number;
  limit: number;
  offset: number;
}

interface ReviewGraphqlResponse {
  data: {
    repository: {
      pullRequest: PrReviewData;
    };
  };
}

/** Shared PATCH-fetch helper for both production-deps factories in this file. */
function makePatchPrRecord(opts: {
  baseUrl: string;
  headers: Record<string, string>;
  doFetch: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): (id: string, fields: Record<string, unknown>) => Promise<void> {
  const { baseUrl, headers, doFetch } = opts;
  return async (id: string, fields: Record<string, unknown>) => {
    const res = await doFetch(`${baseUrl}/prs/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      throw new Error(`task-store PATCH /prs/${id} → ${res.status}`);
    }
  };
}

export function buildProductionDeps(opts: {
  ghJson: <T>(args: string[]) => T;
  fetchFn?: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): PrStateReconcilerDeps {
  const workspacePath = resolveWorkspacePath();
  const repos = resolveAllRepos(workspacePath);
  const { ghJson } = opts;

  const taskStoreUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "").trim();
  const taskStoreToken = (process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "").trim();
  const baseUrl = taskStoreUrl.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${taskStoreToken}`,
    "Content-Type": "application/json",
  };
  const doFetch = opts.fetchFn ?? fetch;

  return {
    repos,
    listOpenPrRecords: async (repo: string, limit: number, offset: number) => {
      const params = new URLSearchParams({
        repo,
        state: "open",
        limit: String(limit),
        offset: String(offset),
      });
      const res = await doFetch(`${baseUrl}/prs?${params}`, { headers });
      if (!res.ok) {
        throw new Error(`task-store GET /prs?${params} → ${res.status}`);
      }
      const data = (await res.json()) as PrListResponseJson;
      return data.prs;
    },
    patchPrRecord: makePatchPrRecord({ baseUrl, headers, doFetch }),
    ghViewPr: async (repo: string, prNumber: number) => {
      return ghJson<GhPrView>([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "state,mergedAt",
      ]);
    },
  };
}

/**
 * Production deps for `reconcileReviewState()`. Kept as a distinctly-named
 * factory (not a `buildProductionDeps` overload) since its query shape
 * (`state=open&reviewState=pending`) and GitHub call (GraphQL review fetch)
 * are unrelated to `reconcilePrState()`'s (`state=open` list + `gh pr view`).
 */
export function buildReviewStateProductionDeps(opts: {
  ghGraphql: <T>(query: string) => T;
  fetchFn?: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  clock?: Clock;
}): PrReviewStateReconcilerDeps {
  const workspacePath = resolveWorkspacePath();
  const repos = resolveAllRepos(workspacePath);
  const { ghGraphql } = opts;

  const taskStoreUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "").trim();
  const taskStoreToken = (process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "").trim();
  const baseUrl = taskStoreUrl.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${taskStoreToken}`,
    "Content-Type": "application/json",
  };
  const doFetch = opts.fetchFn ?? fetch;

  return {
    repos,
    clock: opts.clock ?? SystemClock(),
    listPendingReviewRecords: async (
      repo: string,
      limit: number,
      offset: number,
    ) => {
      const params = new URLSearchParams({
        repo,
        state: "open",
        reviewState: "pending",
        limit: String(limit),
        offset: String(offset),
      });
      const res = await doFetch(`${baseUrl}/prs?${params}`, { headers });
      if (!res.ok) {
        throw new Error(`task-store GET /prs?${params} → ${res.status}`);
      }
      const data = (await res.json()) as PrReviewListResponseJson;
      return data.prs;
    },
    patchPrRecord: makePatchPrRecord({ baseUrl, headers, doFetch }),
    fetchPrReviews: async (org: string, repo: string, pr: number) => {
      const query = `{
  repository(owner: "${org}", name: "${repo}") {
    pullRequest(number: ${pr}) {
      headRefOid
      reviews(first: 50) {
        nodes {
          author { login }
          state
          submittedAt
          commit { oid }
          body
        }
      }
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 1) {
            nodes {
              author { login }
              body
            }
          }
        }
      }
    }
  }
}`;
      const response = ghGraphql<ReviewGraphqlResponse>(query);
      return response.data.repository.pullRequest;
    },
  };
}
