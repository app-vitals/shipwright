/**
 * agent/src/patch-outcome-check.ts
 *
 * PHS-3.1 — state-based post-dispatch outcome check for the patch phase.
 *
 * Invariant (planning/patch-handled-state/PLAN.md): every patch dispatch ends
 * with the PR settled, changed, or escalated. Candidacy is recomputed from
 * live state before and after the dispatch, so the check holds for any exit —
 * completed, `[silent]`, or thrown — without parsing transcripts. A PR that is
 * still a patch candidate at the same head with the same unsettled findings
 * broke the invariant and is escalated on the first occurrence via the
 * existing PR-level blocked mechanism, instead of being re-dispatched.
 */

import { unaddressedFindingRefs } from "../../plugins/shipwright/scripts/compute-unaddressed-findings.ts";
import {
  PATCH_NO_PROGRESS_REASON_PREFIX,
  splitOrgRepo,
} from "./check-helpers.ts";
import {
  type CheckPatchDeps,
  isCiPatchTrigger,
  type PrReviewData,
} from "./check-patch.ts";

/** The slice of live PR state that decides patch candidacy. */
export interface PatchStateSnapshot {
  headSha: string;
  /** Refs of findings `hasUnaddressedFindings` still counts (sorted). */
  findingRefs: string[];
  mergeDirty: boolean;
  /** Failing or cancelled CI at `headSha`, not settled by a `ci:` rejected ref. */
  ciFailing: boolean;
}

export type PatchOutcome =
  | { kind: "settled" }
  | { kind: "changed" }
  | { kind: "escalated"; reason: string; headSha: string };

function isCandidate(s: PatchStateSnapshot): boolean {
  return s.findingRefs.length > 0 || s.mergeDirty || s.ciFailing;
}

/**
 * Compares the state before and after a patch dispatch.
 *
 * - `changed`: a new head, or any difference in the open findings / merge /
 *   CI state — the run did something, whatever it was.
 * - `settled`: nothing left that makes the PR a patch candidate.
 * - `escalated`: still a candidate, identical state — the run was a no-op.
 */
export function evaluatePatchOutcome(
  before: PatchStateSnapshot,
  after: PatchStateSnapshot,
): PatchOutcome {
  if (
    before.headSha !== after.headSha ||
    before.mergeDirty !== after.mergeDirty ||
    before.ciFailing !== after.ciFailing ||
    before.findingRefs.join("\n") !== after.findingRefs.join("\n")
  ) {
    return { kind: "changed" };
  }
  if (!isCandidate(after)) return { kind: "settled" };

  const unsettled = [
    ...after.findingRefs,
    ...(after.mergeDirty ? ["merge conflict"] : []),
    ...(after.ciFailing ? ["failing CI"] : []),
  ];
  return {
    kind: "escalated",
    headSha: after.headSha,
    reason: `${PATCH_NO_PROGRESS_REASON_PREFIX} at ${after.headSha.slice(0, 7)} — still unsettled: ${unsettled.join(", ")}`,
  };
}

/**
 * Builds the live-state reader over the same deps getPatchCandidates uses, so
 * candidacy here cannot drift from candidacy there. Returns null (callers fail
 * open — no escalation) when any read fails or the PR cannot be resolved.
 */
export function createPatchStateSnapshotter(
  deps: CheckPatchDeps,
): (
  candidateId: string,
  prAuthor?: string,
) => Promise<PatchStateSnapshot | null> {
  return async (candidateId, prAuthor) => {
    const hash = candidateId.lastIndexOf("#");
    const prNumber = Number(candidateId.slice(hash + 1));
    if (hash < 1 || !Number.isInteger(prNumber)) return null;
    const repoFull = candidateId.slice(0, hash);
    const [org, repo] = splitOrgRepo(repoFull);
    try {
      const currentUser = await deps.getCurrentUser();
      const record = deps.queryPrRecord
        ? await deps.queryPrRecord(repoFull, prNumber).catch(() => null)
        : null;
      const fetched = await deps.fetchPrReviews(org, repo, prNumber);
      const reviewData: PrReviewData = {
        ...fetched,
        findings: record?.findings,
        prAuthor: prAuthor ?? currentUser,
      };
      const headSha = fetched.headRefOid;
      const [merge, ci] = await Promise.all([
        deps.fetchMergeStatus(org, repo, prNumber),
        deps.fetchCiStatus(org, repo, prNumber, headSha),
      ]);
      return {
        headSha,
        findingRefs: unaddressedFindingRefs(reviewData, currentUser).sort(),
        mergeDirty: merge.isDirty,
        ciFailing: isCiPatchTrigger(ci, headSha, record?.findings),
      };
    } catch (err) {
      console.warn(
        `[patch-outcome-check] snapshot failed for ${candidateId}: ${String(err)} — skipping outcome check`,
      );
      return null;
    }
  };
}
