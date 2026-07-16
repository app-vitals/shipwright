/**
 * agent/src/check-review.ts
 *
 * Native, directly-importable equivalent of
 * plugins/shipwright/scripts/check-review.ts — candidate provider for the
 * review phase.
 *
 * Unlike the plugin script (a boolean gate that exits 0/1 for a cron
 * precheck), this function collects and returns the FULL SET of open PRs
 * with unreviewed commits as WorkPrCandidate[], tagged phase: "review". It
 * does not early-return after the first match — the selector needs the whole
 * candidate set to pick the globally-oldest ready item.
 *
 * Dedup uses the task-store PR record (commitSha + reviewState), same as the
 * plugin: a missing record means the PR has not been reviewed yet and is
 * eligible; a query failure is also treated as eligible (graceful
 * degradation, matching the plugin's "err permissive" precheck philosophy).
 *
 * age is populated from the linked task's createdAt (via queryTaskStatus,
 * LPF-3.2), falling back to the PR's GitHub createdAt when no task is linked
 * or the lookup fails — readyForReviewAt is a necessarily-recent
 * phase-readiness stamp, not the work item's true origination age, and is no
 * longer used for age sourcing (it remains in PrRecord solely for
 * queryPrRecord's other historical callers). Unlike check-deploy.ts's
 * queryTaskStatus usage, a lookup failure here is NOT gating — it is only
 * ever consumed for its createdAt field, so a thrown error just falls back to
 * pr.createdAt rather than disqualifying the PR.
 */

import { agentReposRef } from "./agent-repos-ref.ts";
import {
  candidateId,
  createPrRecordQuery,
  createTaskStatusQuery,
  getCurrentUser,
  mapReposTolerant,
  readAllowSelfReview,
  resolveAllRepos,
  resolveWorkspacePath,
} from "./check-helpers.ts";
import type { LinkedTaskInfo } from "./check-helpers.ts";
import type { WorkPrCandidate } from "./work-selector.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PrInfo {
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  headRefOid: string;
  repo?: string;
  isDraft: boolean;
  labels?: { name: string }[];
  createdAt?: string;
}

export interface PrRecord {
  commitSha?: string | null;
  reviewState: string;
  readyForReviewAt?: string | null;
  claimedBy?: string | null;
}

export interface CheckReviewDeps {
  getCurrentUser: () => Promise<string>;
  isSelfReviewAllowed: boolean;
  listOpenPrs: (repo: string) => Promise<PrInfo[]>;
  queryPrRecord: (repo: string, prNumber: number) => Promise<PrRecord | null>;
  /**
   * Returns the agent's currently configured repo scope (org/repo strings).
   * Called at the top of every getReviewCandidates() invocation — not once at
   * deps-build time — so a repo present in the local clone list (and
   * therefore returned by listOpenPrs) but absent from this call's result is
   * excluded from candidates, and a later scope change is picked up on the
   * very next call.
   */
  getScopedRepos: () => string[];
  /**
   * True once the agent's repo scope has been successfully synced at least
   * once. When false (e.g. a persistent 404 on the agent's config bundle —
   * see index.ts's syncConfig), getReviewCandidates() fails open and does
   * not filter by scope at all, matching pre-scoping behavior — otherwise a
   * config-sync outage would silently exclude every repo from review
   * candidacy, indistinguishable from "no work found".
   */
  hasScopeSynced: () => boolean;
  // Task status lookup for the linked task (if any), used PURELY to source
  // the age field via its createdAt — unlike check-deploy.ts, this is never
  // used as a gating/disqualifying check here. A thrown error is treated the
  // same as "no linked task" (age falls back to pr.createdAt); it must not
  // disqualify an otherwise-eligible PR from review candidacy.
  queryTaskStatus?: (
    repo: string,
    prNumber: number,
  ) => Promise<LinkedTaskInfo | null>;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Collect all open PRs with unreviewed commits, across all repos returned by
 * listOpenPrs, as WorkPrCandidate[] tagged phase: "review".
 */
export async function getReviewCandidates(
  deps: CheckReviewDeps,
): Promise<WorkPrCandidate[]> {
  const currentUser = await deps.getCurrentUser();

  // Fail open when scope has never synced (e.g. a persistent config-bundle
  // 404) — filtering by an unpopulated scope would silently drop every repo
  // from candidacy, a failure mode that didn't exist before scoping.
  const scopeSynced = deps.hasScopeSynced();
  const scopedRepos = new Set(deps.getScopedRepos());
  const allPrs = await deps.listOpenPrs("default");
  const prs = scopeSynced
    ? allPrs.filter((pr) => scopedRepos.has(pr.repo ?? ""))
    : allPrs;
  const candidates: WorkPrCandidate[] = [];

  for (const pr of prs) {
    if (pr.isDraft) continue;
    if (pr.author.login === "app/dependabot") continue;
    if (pr.labels?.some((l) => l.name === "automated")) continue;
    if (!deps.isSelfReviewAllowed && pr.author.login === currentUser) continue;

    let record: PrRecord | null = null;
    try {
      record = await deps.queryPrRecord(pr.repo ?? "", pr.number);
    } catch {
      // Query failed → treat as eligible (no dedup)
    }

    // Task-store task lookup, used purely to source the age field from the
    // linked task's createdAt (LPF-3.2) — not a gating check. A thrown error
    // is treated as "no linked task" so it never disqualifies an otherwise-
    // eligible PR from review candidacy.
    let linkedTask: LinkedTaskInfo | null = null;
    if (deps.queryTaskStatus) {
      try {
        linkedTask = await deps.queryTaskStatus(pr.repo ?? "", pr.number);
      } catch {
        linkedTask = null;
      }
    }
    const age = linkedTask?.createdAt ?? pr.createdAt ?? "";

    // No record → eligible
    if (!record) {
      candidates.push({
        id: candidateId(pr.repo ?? "unknown", pr.number),
        age,
        phase: "review",
      });
      continue;
    }

    // A record with claimedBy set means another agent is currently mid-review
    // on this PR (POST /prs/claim already called) — never re-add as a
    // candidate, regardless of what the commitSha/reviewState check below
    // would otherwise say (this is NOT queried with ready=true, since a
    // missing record here must stay distinguishable from "no record yet").
    if (record.claimedBy != null) continue;

    // commitSha matches and reviewState is not pending → already reviewed at this HEAD, skip
    if (record.commitSha === pr.headRefOid && record.reviewState !== "pending") {
      continue;
    }

    // Different SHA or pending → eligible
    candidates.push({
      id: candidateId(pr.repo ?? "unknown", pr.number),
      age,
      phase: "review",
    });
  }

  return candidates;
}

// ─── Production deps ──────────────────────────────────────────────────────────

export async function buildProductionDeps(opts: {
  ghJson: <T>(args: string[]) => Promise<T>;
  fetchFn?: typeof fetch;
  getScopedRepos?: () => string[];
  hasScopeSynced?: () => boolean;
}): Promise<CheckReviewDeps> {
  const workspacePath = resolveWorkspacePath();
  const allRepos = resolveAllRepos(workspacePath);
  const { ghJson: ghJsonFn } = opts;

  return {
    getCurrentUser,
    isSelfReviewAllowed: readAllowSelfReview(workspacePath),
    getScopedRepos: opts.getScopedRepos ?? agentReposRef.get,
    hasScopeSynced: opts.hasScopeSynced ?? agentReposRef.hasSynced,
    listOpenPrs: async (_repo: string) => {
      return mapReposTolerant(allRepos, "check-review", async (repo) => {
        const repoPrs = await ghJsonFn<PrInfo[]>([
          "pr",
          "list",
          "--state",
          "open",
          "--repo",
          repo,
          "--json",
          "number,title,author,headRefName,headRefOid,isDraft,labels,createdAt",
        ]);
        return repoPrs.map((pr) => ({ ...pr, repo }));
      });
    },
    queryPrRecord: createPrRecordQuery<PrRecord>({ fetchFn: opts.fetchFn }),
    queryTaskStatus: createTaskStatusQuery({ fetchFn: opts.fetchFn }),
  };
}
