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
 * Usage (CI): bun scripts/platform-bump-retry.ts <pr.json> <attempts-used>
 * Prints `action=<retry|noop|exhausted>`, `version=...`, `reason=...` lines.
 */

import { readFileSync } from "node:fs";
import { BUMP_BRANCH } from "./platform-docs-guard.ts";

export { BUMP_BRANCH };

/** Retries allowed per bump PR; the job stops re-dispatching after this. */
export const MAX_RETRIES = 3;

/** Hidden marker on the PR comment recording one spent retry. */
export const RETRY_MARKER = "<!-- platform-bump-retry -->";

export interface BumpPr {
  title: string;
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
  | { action: "noop"; reason: string };

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

export function decide(
  prs: BumpPr[],
  attemptsUsed: number,
  max = MAX_RETRIES,
): RetryDecision {
  const pr = prs[0];
  if (!pr) return { action: "noop", reason: "no open bump PR" };
  const version = versionFromTitle(pr.title);
  if (!version) {
    return { action: "noop", reason: `cannot read version from "${pr.title}"` };
  }
  const stale = pr.mergeable === "CONFLICTING";
  if (!stale && !isRed(pr)) {
    return { action: "noop", reason: "bump PR is green or still running" };
  }
  const reason = stale ? "conflicts with main" : "required checks are red";
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
  const [file, used] = process.argv.slice(2);
  const prs = JSON.parse(readFileSync(file as string, "utf8")) as BumpPr[];
  const d = decide(prs, Number(used ?? 0));
  console.log(`action=${d.action}`);
  console.log(`version=${"version" in d ? d.version : ""}`);
  console.log(`reason=${d.reason}`);
}
