/**
 * scripts/platform-bump-retry.ts
 *
 * Retry selector for a stalled platform bump PR (XPF-1.1). platform-release.yml
 * admin-merges chore/platform-release only when its gate passes at run time; a
 * red gate (e.g. a breaking agent change that needed a shipwright fix first)
 * leaves the PR open and nothing retried it once the fix merged (0.16.2 /
 * shipwright#4693). platform-release-retry.yml runs this on every push to main
 * and re-dispatches the bump for the open PR's version.
 *
 * Pure decision logic; the workflow feeds it `gh pr list` JSON and the number
 * of retries already spent on the PR (marker comments).
 *
 * XPF-1.3: a green open bump PR (e.g. fixed by hand or by a patch pass after
 * the gate gave up) gets `action=merge`: the workflow runs
 * scripts/platform-bump-gate.sh on it without re-dispatching platform-release,
 * which would force-push the branch and discard those fix commits. One merge
 * attempt per head SHA (MERGE_MARKER_PREFIX comment).
 *
 * XPF-1.4: a red or conflicting PR whose branch holds non-bot commits is never
 * retried (a re-dispatch force-pushes over them; platform-release.yml refuses):
 * it is `exhausted`, i.e. needs a human.
 *
 * Usage (CI): bun scripts/platform-bump-retry.ts <pr.json> <attempts-used> [merge-tried] [foreign-commits]
 * Prints `action=<retry|merge|noop|exhausted>`, `version=...`, `reason=...` lines.
 */

import { readFileSync } from "node:fs";
import { BUMP_BRANCH } from "./platform-docs-guard.ts";

export { BUMP_BRANCH };

/** Retries allowed per bump PR; the job stops re-dispatching after this. */
export const MAX_RETRIES = 3;

/** Hidden marker on the PR comment recording one spent retry. */
export const RETRY_MARKER = "<!-- platform-bump-retry -->";

/** Hidden marker prefix on the PR comment recording a merge-only attempt; the head SHA follows. */
export const MERGE_MARKER_PREFIX = "<!-- platform-bump-merge:";

export interface BumpPr {
  title: string;
  headRefOid?: string;
  mergeable?: string;
  statusCheckRollup?: Array<{
    status?: string;
    conclusion?: string | null;
    state?: string;
  }>;
}

export type RetryDecision =
  | { action: "retry"; version: string; reason: string }
  | { action: "exhausted"; version: string; reason: string }
  | { action: "merge"; version: string; reason: string }
  | { action: "noop"; reason: string };

const GREEN = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

const RED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
  "ERROR",
]);

/** Version the bump PR pins, from its title (`... to X.Y.Z`); null if absent. */
export function versionFromTitle(title: string): string | null {
  return title.match(/\bto (\d+\.\d+\.\d+)\s*$/)?.[1] ?? null;
}

/** True when any check on the PR has finished red. */
export function isRed(pr: BumpPr): boolean {
  return (pr.statusCheckRollup ?? []).some((c) =>
    RED.has((c.conclusion ?? c.state ?? "").toUpperCase()),
  );
}

/** True when the PR has checks and every one finished SUCCESS / SKIPPED / NEUTRAL. */
export function isGreen(pr: BumpPr): boolean {
  const checks = pr.statusCheckRollup ?? [];
  return (
    checks.length > 0 &&
    checks.every((c) => {
      const done = c.status === undefined || c.status === "COMPLETED";
      return done && GREEN.has((c.conclusion ?? c.state ?? "").toUpperCase());
    })
  );
}

/**
 * `mergeTried`: a merge-only attempt was already made for this head SHA.
 * `foreignCommits`: the bump branch holds commits the bump bot did not author.
 */
export function decide(
  prs: BumpPr[],
  attemptsUsed: number,
  max = MAX_RETRIES,
  mergeTried = false,
  foreignCommits = false,
): RetryDecision {
  const pr = prs[0];
  if (!pr) return { action: "noop", reason: "no open bump PR" };
  const version = versionFromTitle(pr.title);
  if (!version) {
    return { action: "noop", reason: `cannot read version from "${pr.title}"` };
  }
  const stale = pr.mergeable === "CONFLICTING";
  if (!stale && isGreen(pr)) {
    if (mergeTried) {
      return {
        action: "noop",
        reason: "merge already attempted for this head commit",
      };
    }
    return { action: "merge", version, reason: "required checks are green" };
  }
  if (!stale && !isRed(pr)) {
    return { action: "noop", reason: "bump PR is green or still running" };
  }
  const reason = stale ? "conflicts with main" : "required checks are red";
  if (foreignCommits) {
    return {
      action: "exhausted",
      version,
      reason: `${reason}; branch holds non-bot commits a re-dispatch would discard, needs a human`,
    };
  }
  if (attemptsUsed >= max) {
    return {
      action: "exhausted",
      version,
      reason: `${reason}; ${attemptsUsed}/${max} retries spent`,
    };
  }
  return { action: "retry", version, reason };
}

if (import.meta.main) {
  const [file, used, mergeTried, foreign] = process.argv.slice(2);
  const prs = JSON.parse(readFileSync(file as string, "utf8")) as BumpPr[];
  const d = decide(
    prs,
    Number(used ?? 0),
    MAX_RETRIES,
    Number(mergeTried ?? 0) > 0,
    Number(foreign ?? 0) > 0,
  );
  console.log(`action=${d.action}`);
  console.log(`version=${"version" in d ? d.version : ""}`);
  console.log(`reason=${d.reason}`);
}
