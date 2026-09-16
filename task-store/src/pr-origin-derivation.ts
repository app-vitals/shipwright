/**
 * task-store/src/pr-origin-derivation.ts
 *
 * Pure origin-derivation logic for POM-1.2 — /prs/claim's server-side
 * counterpart to POM-1.1's stampOrigin(). Given a few caller-supplied signals
 * (whether a Task row already links this (repo, pr), the PR's author login,
 * and its head branch), derives a PrOrigin per an exact precedence table.
 *
 * It is deliberately free of any I/O so it can be unit-tested in isolation
 * (mirrors pr-transition-diff.ts's own doc comment / design). claim() does
 * the actual `tx.task.findFirst(...)` lookup and calls this function with the
 * boolean result, then hands the derived origin to stampOrigin() (whose own
 * first-write-wins semantics mean it's always safe to call this
 * unconditionally on every claim).
 *
 * Precedence (first match wins):
 *   1. hasLinkedTask                                            → "shipwright"
 *   2. authorLogin === "github-actions[bot]" OR headRef matches
 *      /^chore\/(chart|plugin-version)-v/                       → "ci"
 *   3. authorLogin === "renovate[bot]" OR "dependabot[bot]"      → "dependency_bot"
 *   4. authorLogin is a non-empty string                        → "human"
 *   5. otherwise (no authorLogin, no task-row match)             → "unknown"
 *
 * A task-row match always wins, even when authorLogin looks like a bot login
 * — e.g. a Renovate-authored PR that Shipwright itself opened a task against
 * (a bundled task) is still "shipwright", not "dependency_bot".
 */

import type { PrOrigin } from "./index.ts";

/** CI branch-naming convention used by chart/plugin-version bump automation. */
const CI_HEAD_REF_PATTERN = /^chore\/(chart|plugin-version)-v/;

export interface DeriveOriginInput {
  /** True when a Task row exists with matching `repo` + `pr === prNumber`. */
  hasLinkedTask: boolean;
  authorLogin?: string | null;
  headRef?: string | null;
}

export function deriveOrigin(input: DeriveOriginInput): PrOrigin {
  const { hasLinkedTask, authorLogin, headRef } = input;

  if (hasLinkedTask) return "shipwright";

  if (
    authorLogin === "github-actions[bot]" ||
    (headRef != null && CI_HEAD_REF_PATTERN.test(headRef))
  ) {
    return "ci";
  }

  if (authorLogin === "renovate[bot]" || authorLogin === "dependabot[bot]") {
    return "dependency_bot";
  }

  if (typeof authorLogin === "string" && authorLogin.length > 0) {
    return "human";
  }

  return "unknown";
}
