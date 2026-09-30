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
 *   1. hasLinkedTask OR hasShipwrightLabel                       → "shipwright"
 *   2. authorIsBot true AND authorLogin matches a known
 *      Renovate/Dependabot identity (any login spelling, e.g.
 *      "renovate[bot]" or gh's normalized "app/renovate")        → "dependency_bot"
 *   3. authorIsBot true (any other bot identity)                 → "ci"
 *   4. hasAutomatedLabel                                         → "ci"
 *   5. authorLogin === "github-actions[bot]" OR headRef matches
 *      /^chore\/(chart|plugin-version)-v/                        → "ci"
 *   6. authorLogin === "renovate[bot]" OR "dependabot[bot]"       → "dependency_bot"
 *   7. authorLogin is a non-empty string                         → "human"
 *   8. otherwise (no authorLogin, no task-row/label match)       → "unknown"
 *
 * A task-row match (or a Shipwright-applied label) always wins, even when
 * authorLogin looks like a bot login — e.g. a Renovate-authored PR that
 * Shipwright itself opened a task against (a bundled task) is still
 * "shipwright", not "dependency_bot".
 *
 * Steps 2–4 (authorIsBot / hasAutomatedLabel, POF-1.1) exist because
 * `gh pr list --json author` normalizes bot authors to `app/<slug>` (e.g.
 * `app/renovate`) while separately reporting `is_bot: true` on the same
 * object — the literal login-string checks in steps 5–6 can never match
 * what `gh` actually sends for a bot author, so those checks remain purely
 * as fallback disambiguation for callers that don't supply the newer
 * signals (e.g. legacy callers, or a census sweep without label/is_bot
 * data).
 */

import type { PrOrigin } from "./index.ts";

/** CI branch-naming convention used by chart/plugin-version bump automation. */
const CI_HEAD_REF_PATTERN = /^chore\/(chart|plugin-version)-v/;

/**
 * Matches known Renovate/Dependabot login spellings regardless of how the
 * caller's GitHub client normalized the author: the classic bot-suffixed
 * login (`renovate[bot]`), gh's `app/<slug>` normalization (`app/renovate`),
 * or the bare slug — case-insensitively.
 */
const DEPENDENCY_BOT_LOGIN_PATTERN = /^(app\/)?(renovate|dependabot)(\[bot\])?$/i;

function isDependencyBotLogin(authorLogin: string | null | undefined): boolean {
  return (
    typeof authorLogin === "string" &&
    DEPENDENCY_BOT_LOGIN_PATTERN.test(authorLogin)
  );
}

export interface DeriveOriginInput {
  /** True when a Task row exists with matching `repo` + `pr === prNumber`. */
  hasLinkedTask: boolean;
  authorLogin?: string | null;
  headRef?: string | null;
  /**
   * True when the caller's GitHub client (e.g. `gh pr list --json author`)
   * reports `is_bot: true` for the PR author. Checked ahead of the legacy
   * login-string matching below (POF-1.1).
   */
  authorIsBot?: boolean;
  /** True when the PR carries a label indicating CI/automation opened it (POF-1.1). */
  hasAutomatedLabel?: boolean;
  /** True when the PR carries a label indicating Shipwright itself opened it (POF-1.1). */
  hasShipwrightLabel?: boolean;
}

export function deriveOrigin(input: DeriveOriginInput): PrOrigin {
  const {
    hasLinkedTask,
    authorLogin,
    headRef,
    authorIsBot,
    hasAutomatedLabel,
    hasShipwrightLabel,
  } = input;

  if (hasLinkedTask || hasShipwrightLabel) return "shipwright";

  if (authorIsBot) {
    return isDependencyBotLogin(authorLogin) ? "dependency_bot" : "ci";
  }

  if (hasAutomatedLabel) return "ci";

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
