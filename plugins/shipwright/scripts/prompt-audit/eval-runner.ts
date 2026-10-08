/**
 * plugins/shipwright/scripts/prompt-audit/eval-runner.ts
 *
 * Eval runners: `runPluginEval` wraps `claude plugin eval`, `abOnTwoCheckouts`
 * runs identical cases on a base and head git worktree and diffs them, and
 * `productionSeries` compares two context fingerprints from the admin
 * /outcomes and /stats endpoints. Each produces a ledger `Measured` record.
 *
 * `claude plugin eval` loads only the plugin under test, so findings in
 * CLAUDE.md-class files cannot be A/B'd by checkout: use `productionSeries`
 * or a with/without run via `appendSystemPrompt`.
 *
 * All exec, fetch, fs and clock access is injected; nothing here spawns
 * claude or touches the network on its own.
 */

import { diffEvals, type EvalDiff, type EvalResult } from "./eval-diff.ts";
import type { Measured } from "./ledger.ts";

export const MIN_SERIES_RUNS = 20;

export interface RunnerDeps {
  exec(cwd: string, cmd: string[]): string;
  /** Create a scratch directory and return its path. */
  mkTmp(prefix: string): string;
  now(): Date;
}

/** Normalised result of one `claude plugin eval --json` run. */
export interface PluginEvalRun extends EvalResult {
  /** Pass rate over all case x seed results, 0..1. */
  score: number;
  costUsd: number;
}

export interface PluginEvalOptions {
  /** Required cap passed through as --max-cost-usd. */
  maxCostUsd: number;
  /** With/without runs for CLAUDE.md-class findings. */
  appendSystemPrompt?: string;
}

/** Accepts the per-case result shapes the eval JSON may carry. */
interface RawCase {
  id?: string;
  name?: string;
  passed?: boolean;
  pass?: boolean;
  seeds?: boolean[];
  results?: boolean[];
}

function caseResults(c: RawCase): boolean[] {
  if (Array.isArray(c.seeds)) return c.seeds;
  if (Array.isArray(c.results)) return c.results;
  const single = c.passed ?? c.pass;
  return typeof single === "boolean" ? [single] : [];
}

export function parsePluginEvalJson(arm: string, raw: string): PluginEvalRun {
  const parsed = JSON.parse(raw) as {
    cases?: RawCase[];
    costUsd?: number;
    cost_usd?: number;
    totalCostUsd?: number;
  };
  if (!parsed || !Array.isArray(parsed.cases)) {
    throw new Error(`plugin eval output for ${arm} has no cases array`);
  }
  const cases: Record<string, boolean[]> = {};
  for (const c of parsed.cases) {
    const id = c.id ?? c.name;
    if (!id) throw new Error(`plugin eval case without id in ${arm}`);
    cases[id] = caseResults(c);
  }
  const all = Object.values(cases).flat();
  if (all.length === 0)
    throw new Error(`plugin eval for ${arm} has no results`);
  const costUsd = parsed.costUsd ?? parsed.cost_usd ?? parsed.totalCostUsd ?? 0;
  return {
    arm,
    cases,
    score: all.filter(Boolean).length / all.length,
    costUsd,
  };
}

export function runPluginEval(
  arm: string,
  pluginDir: string,
  casesPath: string,
  opts: PluginEvalOptions,
  deps: Pick<RunnerDeps, "exec">,
): PluginEvalRun {
  if (!(opts.maxCostUsd > 0)) {
    throw new Error("runPluginEval requires a positive maxCostUsd");
  }
  const cmd = [
    "claude",
    "plugin",
    "eval",
    pluginDir,
    "--cases",
    casesPath,
    "--json",
    "--trust-plugin",
    "--no-publish",
    "--max-cost-usd",
    String(opts.maxCostUsd),
  ];
  if (opts.appendSystemPrompt !== undefined) {
    cmd.push("--append-system-prompt", opts.appendSystemPrompt);
  }
  return parsePluginEvalJson(arm, deps.exec(pluginDir, cmd));
}

export interface AbOptions {
  repoDir: string;
  baseRef: string;
  headRef: string;
  /** Plugin directory relative to the repo root. */
  pluginRel: string;
  /** Frozen cases file, relative to the repo root; identical for both arms. */
  casesRel: string;
  /** Total cap; split evenly between the two arms. */
  maxCostUsd: number;
}

export interface AbResult {
  measured: Measured;
  diff: EvalDiff;
  base: PluginEvalRun;
  head: PluginEvalRun;
}

/** Run the same cases on base and head worktrees, then diff and record. */
export function abOnTwoCheckouts(
  opts: AbOptions,
  deps: RunnerDeps,
  run: typeof runPluginEval = runPluginEval,
): AbResult {
  const root = deps.mkTmp("prompt-eval-ab-");
  const trees: string[] = [];
  const checkout = (name: string, ref: string) => {
    const dir = `${root}/${name}`;
    deps.exec(opts.repoDir, ["git", "worktree", "add", "--detach", dir, ref]);
    trees.push(dir);
    return dir;
  };
  try {
    const baseDir = checkout("base", opts.baseRef);
    const headDir = checkout("head", opts.headRef);
    const perArm = { maxCostUsd: opts.maxCostUsd / 2 };
    const base = run(
      "base",
      `${baseDir}/${opts.pluginRel}`,
      `${baseDir}/${opts.casesRel}`,
      perArm,
      deps,
    );
    const head = run(
      "head",
      `${headDir}/${opts.pluginRel}`,
      `${headDir}/${opts.casesRel}`,
      perArm,
      deps,
    );
    const diff = diffEvals(base, head);
    const measured: Measured = {
      kind: "ab-eval",
      before: base.score,
      after: head.score,
      delta: +(head.score - base.score).toFixed(6),
      costUsd: +(base.costUsd + head.costUsd).toFixed(4),
      series: {
        verdict: diff.verdict,
        pValue: diff.pValue,
        mde: diff.mde,
        pairs: diff.pairs,
      },
      artifacts: [opts.casesRel],
      runAt: deps.now().toISOString(),
    };
    return { measured, diff, base, head };
  } finally {
    for (const dir of trees) {
      try {
        deps.exec(opts.repoDir, ["git", "worktree", "remove", "--force", dir]);
      } catch {
        // best-effort cleanup; the scratch dir is disposable
      }
    }
  }
}

export type SeriesFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface SeriesOptions {
  baseUrl: string;
  token: string;
  phase: string;
  beforeFingerprint: string;
  afterFingerprint: string;
  from?: string;
  to?: string;
  /** Override MIN_SERIES_RUNS only upward. */
  minRuns?: number;
}

interface OutcomeRow {
  phase: string | null;
  contextFingerprint: string | null;
  runs: number;
  completed: number;
}

interface StatsBody {
  baselines?: {
    phase: string | null;
    contextFingerprint: string | null;
    runs: number;
  }[];
  byCron?: unknown;
  totals?: { costUsd?: number };
}

async function getJson<T>(
  fetchFn: SeriesFetch,
  url: string,
  token: string,
): Promise<T> {
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Compare two context fingerprints by completion rate from production runs.
 * Refuses to produce a result unless both arms have at least MIN_SERIES_RUNS
 * runs; both run counts are recorded in `series`.
 */
export async function productionSeries(
  opts: SeriesOptions,
  fetchFn: SeriesFetch,
  now: () => Date,
): Promise<Measured> {
  const min = Math.max(opts.minRuns ?? MIN_SERIES_RUNS, MIN_SERIES_RUNS);
  const qs = new URLSearchParams();
  if (opts.from) qs.set("from", opts.from);
  if (opts.to) qs.set("to", opts.to);
  const q = qs.size ? `?${qs}` : "";
  const base = opts.baseUrl.replace(/\/$/, "");
  const outcomes = await getJson<{ series: OutcomeRow[] }>(
    fetchFn,
    `${base}/agents/all/cron-runs/outcomes${q}`,
    opts.token,
  );
  const stats = await getJson<StatsBody>(
    fetchFn,
    `${base}/agents/all/cron-runs/stats${q}`,
    opts.token,
  );
  const find = (fp: string) =>
    (outcomes.series ?? []).find(
      (s) => s.phase === opts.phase && s.contextFingerprint === fp,
    );
  const before = find(opts.beforeFingerprint);
  const after = find(opts.afterFingerprint);
  const beforeRuns = before?.runs ?? 0;
  const afterRuns = after?.runs ?? 0;
  if (!before || !after || beforeRuns < min || afterRuns < min) {
    throw new Error(
      `refusing to call production series: need >= ${min} runs per arm ` +
        `(before ${beforeRuns}, after ${afterRuns})`,
    );
  }
  const rate = (r: OutcomeRow) => r.completed / r.runs;
  return {
    kind: "production-series",
    before: rate(before),
    after: rate(after),
    delta: +(rate(after) - rate(before)).toFixed(6),
    costUsd: stats.totals?.costUsd ?? 0,
    series: {
      phase: opts.phase,
      beforeFingerprint: opts.beforeFingerprint,
      afterFingerprint: opts.afterFingerprint,
      beforeRuns,
      afterRuns,
    },
    runAt: now().toISOString(),
  };
}
