/**
 * plugins/shipwright/scripts/readiness-api-detectors.ts
 *
 * Deterministic detectors for the readiness-catalogue checks answered outside
 * the checkout: GitHub repo settings and the task store's cron-run /
 * patrol-finding history. No LLM calls, no ambient I/O: every source is an
 * injected client and time comes from an injected Clock.
 *
 * A missing run or an unreachable source yields `fail` with a reason — never
 * a throw (a missing result is not evidence of a pass).
 *
 * Exports: detectorCheckIds, DETECTORS, runApiDetectors, and one function per
 * check (detectDefaultBranchProtected, detectDocsFresh, ...), plus the client
 * interfaces and `daysBetween`.
 */

import type { Clock } from "./clock.ts";
import type { CheckResult } from "./readiness-catalogue.ts";

// ─── Real shapes (task-store openapi-schemas.ts, GitHub REST) ────────────────

export type CronRunOutcome = "ok" | "no_op" | "failed";

/** GET /cron-runs[/latest] row (subset the detectors read). */
export interface CronRun {
  cronId: string;
  repo: string;
  startedAt: string;
  finishedAt: string;
  outcome: CronRunOutcome;
  metrics: Record<string, number>;
}

export type PatrolFindingStatus =
  | "tracking"
  | "ready_to_propose"
  | "open"
  | "resolved"
  | "suppressed";

/** GET /patrol-findings row (subset the detectors read). */
export interface PatrolFinding {
  cronId: string;
  repo: string;
  fingerprint: string;
  status: PatrolFindingStatus;
  firstSeen: string;
  lastSeen: string;
  history: { at: string; status: PatrolFindingStatus; occurrenceCount?: number }[];
  detail: Record<string, unknown> | null;
}

/** GET /system-crons row (subset). */
export interface SystemCron {
  id: string;
  enabled: boolean;
  repoScope: "all" | "selected";
  repos: string[];
}

/** GitHub GET /repos/{r}/branches/{b}/protection (subset). */
export interface BranchProtection {
  required_status_checks?: {
    contexts?: string[];
    checks?: { context: string }[];
  } | null;
}

/** GitHub GET /repos/{r}/rules/branches/{b} item (subset). */
export interface BranchRule {
  type: string;
  parameters?: { required_status_checks?: { context: string }[] };
}

// ─── Injected clients ────────────────────────────────────────────────────────

export interface GitHubSettingsClient {
  getDefaultBranch(repo: string): Promise<string>;
  /** null when the branch has no classic protection (HTTP 404). */
  getBranchProtection(
    repo: string,
    branch: string,
  ): Promise<BranchProtection | null>;
  /** Active ruleset rules applying to the branch. */
  getBranchRules(repo: string, branch: string): Promise<BranchRule[]>;
}

export interface TaskStoreClient {
  /** Newest ok/no_op run, or null on 404. */
  latestRun(cronId: string, repo: string): Promise<CronRun | null>;
  /** Newest run of any outcome, or null when the cron never ran. */
  newestRun(cronId: string, repo: string): Promise<CronRun | null>;
  listFindings(query: {
    cronId: string;
    repo: string;
    status?: PatrolFindingStatus;
  }): Promise<PatrolFinding[]>;
}

export interface SystemCronsClient {
  list(): Promise<SystemCron[]>;
}

export interface DetectorDeps {
  github: GitHubSettingsClient;
  taskStore: TaskStoreClient;
  systemCrons: SystemCronsClient;
  clock: Clock;
}

export interface DetectorResult {
  id: string;
  result: CheckResult;
  reason: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const FRESHNESS_DAYS = 30;
export const STALE_CONSOLIDATION_DAYS = 30;
/** speed-budgets skill: full PR pipeline < 15 min wall (repos may only tighten). */
export const DEFAULT_SUITE_BUDGET_SECONDS = 900;

/** System-cron id per owner that has one (docs/task-store.md seeded crons). */
export const OWNER_CRON_IDS = [
  "docs-freshness",
  "test-readiness",
  "entropy-patrol",
  "security-patrol",
  "consolidation-patrol",
] as const;

const DAY_MS = 86_400_000;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Whole-and-fractional days from `from` to `to` (negative if `from` is later). */
export function daysBetween(from: string | Date, to: Date): number {
  return (to.getTime() - new Date(from).getTime()) / DAY_MS;
}

const pass = (id: string, reason: string): DetectorResult => ({
  id,
  result: "pass",
  reason,
});
const fail = (id: string, reason: string): DetectorResult => ({
  id,
  result: "fail",
  reason,
});

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs a detector body, converting any throw into a `fail` result. */
async function guarded(
  id: string,
  body: () => Promise<DetectorResult>,
): Promise<DetectorResult> {
  try {
    return await body();
  } catch (e) {
    return fail(id, `source unreachable: ${msg(e)}`);
  }
}

/**
 * Date the finding most recently became `ready_to_propose`: the start of the
 * trailing run of ready entries in its history (firstSeen when no history).
 */
export function readySince(f: PatrolFinding): string {
  let since: string | null = null;
  for (let i = f.history.length - 1; i >= 0; i--) {
    const h = f.history[i];
    if (h?.status !== "ready_to_propose") break;
    since = h.at;
  }
  return since ?? f.firstSeen;
}

// ─── Detectors ───────────────────────────────────────────────────────────────

export function detectDefaultBranchProtected(
  repo: string,
  deps: DetectorDeps,
): Promise<DetectorResult> {
  const id = "default-branch-protected";
  return guarded(id, async () => {
    const branch = await deps.github.getDefaultBranch(repo);
    const protection = await deps.github.getBranchProtection(repo, branch);
    const rsc = protection?.required_status_checks;
    if ((rsc?.contexts?.length ?? 0) + (rsc?.checks?.length ?? 0) > 0) {
      return pass(id, `${branch} requires status checks (branch protection)`);
    }
    const rules = await deps.github.getBranchRules(repo, branch);
    const ruleChecks = rules
      .filter((r) => r.type === "required_status_checks")
      .flatMap((r) => r.parameters?.required_status_checks ?? []);
    if (ruleChecks.length > 0) {
      return pass(id, `${branch} requires status checks (ruleset)`);
    }
    return fail(
      id,
      protection || rules.length > 0
        ? `${branch} is protected but requires no CI status checks`
        : `${branch} has no branch protection or ruleset`,
    );
  });
}

export function detectDocsFresh(
  repo: string,
  deps: DetectorDeps,
): Promise<DetectorResult> {
  const id = "docs-fresh";
  return guarded(id, async () => {
    const run = await deps.taskStore.latestRun("docs-freshness", repo);
    if (!run) return fail(id, "no docs-freshness run recorded for this repo");
    const age = daysBetween(run.finishedAt, deps.clock.now());
    if (age > FRESHNESS_DAYS) {
      return fail(
        id,
        `last docs-freshness run finished ${Math.floor(age)} days ago (limit ${FRESHNESS_DAYS})`,
      );
    }
    return pass(id, `last docs-freshness run finished ${run.finishedAt}`);
  });
}

export function detectNoCriticalSecurityFindings(
  repo: string,
  deps: DetectorDeps,
): Promise<DetectorResult> {
  const id = "no-critical-security-findings";
  return guarded(id, async () => {
    const run = await deps.taskStore.latestRun("security-patrol", repo);
    if (!run) return fail(id, "no security-patrol run recorded for this repo");
    const open = await deps.taskStore.listFindings({
      cronId: "security-patrol",
      repo,
      status: "open",
    });
    const critical = open.filter(
      (f) => f.status === "open" && f.detail?.severity === "critical",
    );
    return critical.length > 0
      ? fail(id, `${critical.length} open critical security finding(s)`)
      : pass(id, "no open critical security findings");
  });
}

export function detectTestSuiteSpeedBudget(
  repo: string,
  deps: DetectorDeps,
): Promise<DetectorResult> {
  const id = "test-suite-speed-budget";
  return guarded(id, async () => {
    const run = await deps.taskStore.latestRun("test-readiness", repo);
    if (!run) return fail(id, "no test-readiness run recorded for this repo");
    const wall = run.metrics.suiteWallSeconds;
    if (typeof wall !== "number" || !Number.isFinite(wall)) {
      return fail(id, "latest test-readiness run recorded no suiteWallSeconds");
    }
    const budget = run.metrics.suiteBudgetSeconds ?? DEFAULT_SUITE_BUDGET_SECONDS;
    return wall <= budget
      ? pass(id, `suite ran in ${wall}s (budget ${budget}s)`)
      : fail(id, `suite ran in ${wall}s, over its ${budget}s budget`);
  });
}

export function detectNoHighEntropyFindings(
  repo: string,
  deps: DetectorDeps,
): Promise<DetectorResult> {
  const id = "no-high-entropy-findings";
  return guarded(id, async () => {
    const run = await deps.taskStore.latestRun("entropy-patrol", repo);
    if (!run) return fail(id, "no entropy-patrol run recorded for this repo");
    const high = run.metrics.high;
    if (typeof high !== "number" || !Number.isFinite(high)) {
      return fail(id, "latest entropy-patrol run recorded no `high` count");
    }
    return high === 0
      ? pass(id, "latest entropy run found no high-severity findings")
      : fail(id, `${high} high-severity entropy finding(s) open`);
  });
}

export function detectNoStaleConsolidationPattern(
  repo: string,
  deps: DetectorDeps,
): Promise<DetectorResult> {
  const id = "no-stale-consolidation-pattern";
  return guarded(id, async () => {
    const run = await deps.taskStore.latestRun("consolidation-patrol", repo);
    if (!run) {
      return fail(id, "no consolidation-patrol run recorded for this repo");
    }
    const ready = await deps.taskStore.listFindings({
      cronId: "consolidation-patrol",
      repo,
      status: "ready_to_propose",
    });
    const now = deps.clock.now();
    const stale = ready.filter(
      (f) =>
        f.status === "ready_to_propose" &&
        daysBetween(readySince(f), now) > STALE_CONSOLIDATION_DAYS,
    );
    return stale.length > 0
      ? fail(
          id,
          `${stale.length} pattern(s) ready_to_propose for over ${STALE_CONSOLIDATION_DAYS} days`,
        )
      : pass(id, "no consolidation pattern ready for over 30 days");
  });
}

export function detectOwnerCronsRunning(
  repo: string,
  deps: DetectorDeps,
): Promise<DetectorResult> {
  const id = "owner-crons-running";
  return guarded(id, async () => {
    const crons = await deps.systemCrons.list();
    const problems: string[] = [];
    for (const cronId of OWNER_CRON_IDS) {
      const def = crons.find((c) => c.id === cronId);
      if (!def) {
        problems.push(`${cronId}: not defined`);
        continue;
      }
      const inScope = def.repoScope === "all" || def.repos.includes(repo);
      if (!def.enabled || !inScope) {
        problems.push(`${cronId}: not enabled for this repo`);
        continue;
      }
      const run = await deps.taskStore.newestRun(cronId, repo);
      if (!run) problems.push(`${cronId}: no run recorded`);
      else if (run.outcome === "failed") problems.push(`${cronId}: latest run failed`);
    }
    return problems.length > 0
      ? fail(id, problems.join("; "))
      : pass(id, "every owning cron is enabled with its latest run ok");
  });
}

// ─── Registry ────────────────────────────────────────────────────────────────

export const DETECTORS: Record<
  string,
  (repo: string, deps: DetectorDeps) => Promise<DetectorResult>
> = {
  "default-branch-protected": detectDefaultBranchProtected,
  "docs-fresh": detectDocsFresh,
  "no-critical-security-findings": detectNoCriticalSecurityFindings,
  "test-suite-speed-budget": detectTestSuiteSpeedBudget,
  "no-high-entropy-findings": detectNoHighEntropyFindings,
  "no-stale-consolidation-pattern": detectNoStaleConsolidationPattern,
  "owner-crons-running": detectOwnerCronsRunning,
};

export const detectorCheckIds: string[] = Object.keys(DETECTORS);

/** Runs every detector for `repo`; never throws. */
export async function runApiDetectors(
  repo: string,
  deps: DetectorDeps,
): Promise<DetectorResult[]> {
  return Promise.all(Object.values(DETECTORS).map((d) => d(repo, deps)));
}
