/**
 * plugins/shipwright/scripts/readiness-catalogue.ts
 *
 * The open, versioned agent-readiness model: five levels, pass/fail checks,
 * and exactly one owning system cron per check. This module is the source of
 * truth; docs/readiness.md mirrors it and a content test keeps them in sync.
 *
 * Exports:
 *   READINESS_CATALOGUE_VERSION, READINESS_LEVELS, READINESS_OWNERS,
 *   READINESS_CATALOGUE, computeLevel(results)
 *
 * Pure: no I/O, no clock.
 */

export const READINESS_CATALOGUE_VERSION = 1;

export type ReadinessLevel = 1 | 2 | 3 | 4 | 5;

export const READINESS_LEVELS: Record<ReadinessLevel, string> = {
  1: "Basic",
  2: "Reproducible",
  3: "Agent-ready",
  4: "Fast feedback",
  5: "Autonomous",
};

export const READINESS_OWNERS = [
  "docs-freshness",
  "entropy",
  "test-readiness",
  "environments",
  "security",
  "consolidation",
  "operator",
] as const;

export type ReadinessOwner = (typeof READINESS_OWNERS)[number];

export type CheckResult = "pass" | "fail" | "n/a";

export interface ReadinessCheck {
  level: ReadinessLevel;
  id: string;
  title: string;
  owner: ReadinessOwner;
}

const check = (
  level: ReadinessLevel,
  id: string,
  title: string,
  owner: ReadinessOwner,
): ReadinessCheck => ({ level, id, title, owner });

export const READINESS_CATALOGUE: readonly ReadinessCheck[] = [
  check(1, "readme-present", "README present", "docs-freshness"),
  check(1, "linter-configured", "Linter configured", "entropy"),
  check(
    1,
    "type-checker-configured",
    "Type checker configured (where the language has one)",
    "entropy",
  ),
  check(1, "unit-tests-exist", "Unit tests exist", "test-readiness"),

  check(2, "agent-instructions-present", "AGENTS.md or CLAUDE.md present", "docs-freshness"),
  check(2, "build-test-documented", "Build and test commands documented", "docs-freshness"),
  check(2, "dependencies-pinned", "Dependencies pinned (lockfile)", "environments"),
  check(2, "formatter-configured", "Formatter configured", "entropy"),
  check(2, "pre-commit-configured", "Pre-commit hooks configured", "entropy"),
  check(
    2,
    "tool-versions-pinned",
    "Tool versions pinned (tool-version file, container or devcontainer)",
    "environments",
  ),
  check(
    2,
    "default-branch-protected",
    "Default branch protected and requires CI",
    "security",
  ),
  check(2, "codeowners-present", "CODEOWNERS present", "security"),

  check(3, "ci-runs-lint-typecheck", "CI runs lint and type check", "entropy"),
  check(3, "ci-runs-tests", "CI runs tests", "test-readiness"),
  check(3, "smoke-e2e-layer-exists", "Smoke or end-to-end test layer exists", "test-readiness"),
  check(
    3,
    "docs-fresh",
    "Docs fresh (last docs-freshness run ok within 30 days)",
    "docs-freshness",
  ),
  check(3, "secret-scanning-ci", "Secret scanning in CI", "security"),
  check(3, "dependency-automation", "Dependency update/scan automation", "security"),
  check(3, "no-critical-security-findings", "No open critical security findings", "security"),
  check(3, "structured-logging", "Structured logging", "environments"),
  check(3, "error-tracking-configured", "Error tracking configured", "environments"),
  check(
    3,
    "preview-environment",
    "Preview environment: the stack comes up from a PR's own source, locally and in CI, and the smoke/e2e layer runs against it",
    "environments",
  ),

  check(4, "test-suite-speed-budget", "Test suite within its speed budget", "test-readiness"),
  check(4, "no-high-entropy-findings", "No high-severity entropy findings open", "entropy"),
  check(4, "large-files-within-limit", "Source files over 500 lines ≤ 5%", "entropy"),
  check(4, "tracing-metrics-instrumented", "Tracing and metrics instrumented", "environments"),
  check(4, "staged-canary-deploy", "Staged or canary deploy", "environments"),

  check(
    5,
    "owner-crons-running",
    "Every owning cron enabled for the repo and its latest run ok",
    "operator",
  ),
  check(
    5,
    "no-stale-consolidation-pattern",
    "No consolidation pattern ready for over 30 days",
    "consolidation",
  ),
];

/**
 * Highest N where every check at levels 1..N passes; `n/a` counts as pass.
 * Returns 0 when a Level 1 check fails. A catalogue check with no entry in
 * `results` is treated as failing (a missing result is not evidence of a pass).
 */
export function computeLevel(
  results: Readonly<Record<string, CheckResult>>,
  catalogue: readonly ReadinessCheck[] = READINESS_CATALOGUE,
): 0 | ReadinessLevel {
  let level: 0 | ReadinessLevel = 0;
  for (const n of [1, 2, 3, 4, 5] as const) {
    const ok = catalogue
      .filter((c) => c.level === n)
      .every((c) => {
        const r = results[c.id];
        return r === "pass" || r === "n/a";
      });
    if (!ok) break;
    level = n;
  }
  return level;
}
