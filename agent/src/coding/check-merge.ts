/**
 * agent/src/coding/check-merge.ts
 *
 * Candidate provider for the merge phase (MPD-1.3). Derived from
 * check-deploy.ts: collects the FULL SET of open PRs that are approved
 * (natively, or via a self-review APPROVE comment), authored by the current
 * user, CI-green, not DIRTY, whose linked task is not blocked/hitl (fail
 * closed on lookup failure), whose bundle is complete, and that carry no
 * claimedBy / PR-record blocked gate — tagged phase: "merge".
 *
 * Unlike check-deploy, there is NO busy-repo / active Deploy workflow run
 * guard: merging does not run the Deploy pipeline, so an in-flight Deploy
 * run must not exclude a repo.
 */

import { agentReposRef } from "@app-vitals/agent-runtime/agent-repos-ref";
import { isCiGreen } from "../../../plugins/shipwright/scripts/is-ci-green.ts";
import { canonicalLogin } from "../../../plugins/shipwright/scripts/login-identity.ts";
import {
  type CheckDeployDeps,
  buildProductionDeps as buildDeployProductionDeps,
  type GhPr,
  hasSelfApproveReview,
  type PrRecord,
} from "./check-deploy.ts";
import type { LinkedTaskInfo } from "./check-helpers.ts";
import {
  candidateId,
  isPrRecordBlockedForDispatch,
  isTaskBlockedForDispatch,
  mapReposTolerant,
  ownerOfRepo,
  splitOrgRepo,
} from "./check-helpers.ts";
import type { WorkPrCandidate } from "./work-selector.ts";

export type { CiRun, GhPr, GhReview, PrRecord } from "./check-deploy.ts";

/** check-deploy's deps minus the Deploy-run busy-repo guard (and its clock). */
export type CheckMergeDeps = Omit<
  CheckDeployDeps,
  "fetchActiveDeployRuns" | "clock"
>;

/**
 * Collect all open PRs ready to merge as WorkPrCandidate[] tagged
 * phase: "merge".
 */
export async function getMergeCandidates(
  deps: CheckMergeDeps,
): Promise<WorkPrCandidate[]> {
  const scopedRepos = new Set(deps.getScopedRepos());
  const repos = deps.getRepos().filter((repo) => scopedRepos.has(repo));

  const candidates: WorkPrCandidate[] = [];
  if (repos.length === 0) return candidates;

  const currentUser = await deps.getCurrentUser(ownerOfRepo(repos[0]));
  const openPrs = await mapReposTolerant<GhPr & { repo: string }>(
    repos,
    "check-merge",
    async (repo) => {
      const prs = await deps.listOpenPrs(repo);
      return prs.map((pr) => ({ ...pr, repo }));
    },
  );

  for (const pr of openPrs) {
    const repo = pr.repo;
    const [org, repoName] = splitOrgRepo(repo);

    try {
      let approved = false;
      if (pr.reviewDecision === "APPROVED") {
        approved = true;
      } else if (
        (await deps.isSelfReviewAllowed()) &&
        canonicalLogin(pr.author.login) === canonicalLogin(currentUser)
      ) {
        const reviews = await deps.fetchPrReviews(org, repoName, pr.number);
        approved = hasSelfApproveReview(reviews, currentUser);
      }
      if (!approved) continue;

      if (canonicalLogin(pr.author.login) !== canonicalLogin(currentUser))
        continue;

      const ciRuns = await deps.fetchCiRuns(org, repoName, pr.headRefOid);
      if (!isCiGreen(ciRuns)) continue;

      if (pr.mergeStateStatus === "DIRTY") continue;

      // Linked task blocked / hitl — a lookup FAILURE fails CLOSED.
      let linkedTask: LinkedTaskInfo | null = null;
      if (deps.queryTaskStatus) {
        try {
          linkedTask = await deps.queryTaskStatus(repo, pr.number);
        } catch (err) {
          process.stderr.write(
            `check-merge: task-status lookup failed for PR ${pr.number}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          continue;
        }
        if (isTaskBlockedForDispatch(linkedTask)) continue;
      }

      if (deps.isBundleComplete) {
        const bundleComplete = await deps
          .isBundleComplete(pr.headRefName)
          .catch(() => true);
        if (!bundleComplete) continue;
      }

      if (deps.queryPrRecord) {
        let record: PrRecord | null = null;
        try {
          record = await deps.queryPrRecord(repo, pr.number);
        } catch {
          // fail open — a transient task-store error must not exclude an
          // otherwise-qualifying PR.
        }
        if (record?.claimedBy != null) continue;
        if (isPrRecordBlockedForDispatch(record)) continue;
      }

      candidates.push({
        id: candidateId(repo, pr.number),
        age: linkedTask?.createdAt ?? pr.createdAt ?? "",
        phase: "merge",
        title: pr.title,
        authorLogin: pr.author.login,
        headRefName: pr.headRefName,
        commitSha: pr.headRefOid,
      });
    } catch (err) {
      process.stderr.write(
        `check-merge: gh query failed for PR ${pr.number}: ${String(err)}\n`,
      );
    }
  }

  return candidates;
}

/**
 * Production deps: identical wiring to check-deploy's, with the Deploy-run
 * guard (fetchActiveDeployRuns) and clock dropped.
 */
export async function buildProductionDeps(opts: {
  ghJson: <T>(args: string[], owner: string) => Promise<T>;
  fetchFn?: typeof fetch;
  getScopedRepos?: () => string[];
}): Promise<CheckMergeDeps> {
  const {
    fetchActiveDeployRuns: _fetchActiveDeployRuns,
    clock: _clock,
    ...deps
  } = await buildDeployProductionDeps({
    ...opts,
    getScopedRepos: opts.getScopedRepos ?? agentReposRef.get,
  });
  return deps;
}
