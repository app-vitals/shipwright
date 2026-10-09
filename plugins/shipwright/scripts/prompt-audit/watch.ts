/**
 * plugins/shipwright/scripts/prompt-audit/watch.ts
 *
 * Post-merge regression watch for a merged prompt-fix finding. Compares, per
 * phase, the production series on the finding's before and after context
 * fingerprints: cost per run, turns, skip rate (admin /cron-runs/outcomes)
 * and patch cycles (metrics /metrics/pr-outcomes). A phase with fewer than
 * MIN_WATCH_RUNS runs on either side is "insufficient data". On a regression
 * beyond WATCH_THRESHOLDS the ledger entry is marked `regressed` and ONE
 * hitl:true revert-proposal task is filed. This never reverts, merges or
 * edits files; the revert is a human decision.
 *
 * The series are time-window correlations, not controlled experiments:
 * simultaneous prompt changes and the model cutover confound them
 * (WATCH_CAVEATS, repeated in the task body). Thresholds are documented in
 * skills/prompt-scan/references/thresholds.md. All fetch and clock access is
 * injected.
 */

import type { Ledger, LedgerEntry } from "./ledger.ts";

export const MIN_WATCH_RUNS = 20;

export const WATCH_THRESHOLDS = {
  /** Relative increase in avg first-turn context tokens (the cost proxy). */
  costRelative: 0.2,
  /** Relative increase in avg turns per run. */
  turnsRelative: 0.2,
  /** Absolute increase in skipped / total runs. */
  skipRateAbsolute: 0.1,
  /** Absolute increase in avg patch cycles per PR. */
  patchCyclesAbsolute: 0.5,
} as const;

export const WATCH_CAVEATS = [
  "Time-window correlation, not per-run attribution: simultaneous prompt changes landing in the same window confound the series.",
  "The model cutover shifts cost, turns and skip rate for every phase at once and is not separable from this change.",
  "Patch cycles come from PR windows per context fingerprint, not per phase.",
] as const;

export type WatchFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type WatchPostFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export interface OutcomeRow {
  phase: string | null;
  contextFingerprint: string | null;
  runs: number;
  completed: number;
  failed: number;
  skipped: number;
  avgTurns: number | null;
  avgContextTokens: number | null;
}

export interface PrOutcomeRow {
  contextFingerprint: string;
  prs: number;
  avgPatchCycles: number | null;
}

export type Metric = "cost" | "turns" | "skipRate" | "patchCycles";

export interface MetricCompare {
  metric: Metric;
  before: number;
  after: number;
  regressed: boolean;
}

export type PhaseVerdict = "ok" | "regressed" | "insufficient-data";

export interface PhaseWatch {
  phase: string;
  verdict: PhaseVerdict;
  beforeRuns: number;
  afterRuns: number;
  comparisons: MetricCompare[];
}

export interface WatchResult {
  fingerprint: string;
  verdict: PhaseVerdict;
  phases: PhaseWatch[];
  caveats: readonly string[];
}

export interface WatchSeries {
  outcomes: OutcomeRow[];
  prOutcomes: PrOutcomeRow[];
}

export interface WatchOptions {
  baseUrl: string;
  token: string;
  beforeFingerprint: string;
  afterFingerprint: string;
  /** Restrict to one phase; default is every phase present on both sides. */
  phase?: string;
  /** Series window start: the finding's merge time. */
  from?: string;
  to?: string;
}

/** Non-skipped runs: the real sample behind cost, turns and completion. */
const sample = (r: OutcomeRow) => r.completed + r.failed;

async function getJson<T>(
  fetchFn: WatchFetch,
  url: string,
  token: string,
): Promise<T> {
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchWatchSeries(
  opts: WatchOptions,
  fetchFn: WatchFetch,
): Promise<WatchSeries> {
  const qs = new URLSearchParams();
  if (opts.from) qs.set("from", opts.from);
  if (opts.to) qs.set("to", opts.to);
  const q = qs.size ? `?${qs}` : "";
  const base = opts.baseUrl.replace(/\/$/, "");
  const [outcomes, prs] = await Promise.all([
    getJson<{ series?: OutcomeRow[] }>(
      fetchFn,
      `${base}/agents/all/cron-runs/outcomes${q}`,
      opts.token,
    ),
    getJson<{ series?: PrOutcomeRow[] }>(
      fetchFn,
      `${base}/metrics/pr-outcomes${q}`,
      opts.token,
    ).catch(() => ({ series: [] as PrOutcomeRow[] })),
  ]);
  return { outcomes: outcomes.series ?? [], prOutcomes: prs.series ?? [] };
}

const relativeRise = (before: number, after: number, limit: number) =>
  before > 0 ? (after - before) / before > limit : false;

function compare(
  before: OutcomeRow,
  after: OutcomeRow,
  prBefore?: PrOutcomeRow,
  prAfter?: PrOutcomeRow,
): MetricCompare[] {
  const out: MetricCompare[] = [];
  if (before.avgContextTokens != null && after.avgContextTokens != null) {
    out.push({
      metric: "cost",
      before: before.avgContextTokens,
      after: after.avgContextTokens,
      regressed: relativeRise(
        before.avgContextTokens,
        after.avgContextTokens,
        WATCH_THRESHOLDS.costRelative,
      ),
    });
  }
  if (before.avgTurns != null && after.avgTurns != null) {
    out.push({
      metric: "turns",
      before: before.avgTurns,
      after: after.avgTurns,
      regressed: relativeRise(
        before.avgTurns,
        after.avgTurns,
        WATCH_THRESHOLDS.turnsRelative,
      ),
    });
  }
  const skipRate = (r: OutcomeRow) => (r.runs > 0 ? r.skipped / r.runs : 0);
  out.push({
    metric: "skipRate",
    before: skipRate(before),
    after: skipRate(after),
    regressed:
      skipRate(after) - skipRate(before) > WATCH_THRESHOLDS.skipRateAbsolute,
  });
  if (
    prBefore?.avgPatchCycles != null &&
    prAfter?.avgPatchCycles != null &&
    prBefore.prs >= MIN_WATCH_RUNS &&
    prAfter.prs >= MIN_WATCH_RUNS
  ) {
    out.push({
      metric: "patchCycles",
      before: prBefore.avgPatchCycles,
      after: prAfter.avgPatchCycles,
      regressed:
        prAfter.avgPatchCycles - prBefore.avgPatchCycles >
        WATCH_THRESHOLDS.patchCyclesAbsolute,
    });
  }
  return out;
}

/** Pure comparison of the two fingerprints' series, per phase. */
export function evaluateWatch(
  fingerprint: string,
  opts: Pick<WatchOptions, "beforeFingerprint" | "afterFingerprint" | "phase">,
  series: WatchSeries,
): WatchResult {
  const rows = (fp: string) =>
    new Map(
      series.outcomes
        .filter((r) => r.contextFingerprint === fp && r.phase)
        .map((r) => [r.phase as string, r]),
    );
  const before = rows(opts.beforeFingerprint);
  const after = rows(opts.afterFingerprint);
  const pr = (fp: string) =>
    series.prOutcomes.find((r) => r.contextFingerprint === fp);
  const phases = opts.phase
    ? [opts.phase]
    : [...new Set([...before.keys(), ...after.keys()])].sort();

  const results: PhaseWatch[] = phases.map((phase) => {
    const b = before.get(phase);
    const a = after.get(phase);
    const beforeRuns = b ? sample(b) : 0;
    const afterRuns = a ? sample(a) : 0;
    if (!b || !a || beforeRuns < MIN_WATCH_RUNS || afterRuns < MIN_WATCH_RUNS) {
      return {
        phase,
        verdict: "insufficient-data",
        beforeRuns,
        afterRuns,
        comparisons: [],
      };
    }
    const comparisons = compare(
      b,
      a,
      pr(opts.beforeFingerprint),
      pr(opts.afterFingerprint),
    );
    return {
      phase,
      verdict: comparisons.some((c) => c.regressed) ? "regressed" : "ok",
      beforeRuns,
      afterRuns,
      comparisons,
    };
  });

  const verdict: PhaseVerdict = results.some((p) => p.verdict === "regressed")
    ? "regressed"
    : results.some((p) => p.verdict === "ok")
      ? "ok"
      : "insufficient-data";
  return { fingerprint, verdict, phases: results, caveats: WATCH_CAVEATS };
}

// ─── revert-proposal task ────────────────────────────────────────────────────

export interface RevertProposalTask {
  id: string;
  title: string;
  status: "pending";
  repo: string;
  branch: string;
  hitl: true;
  description: string;
  acceptanceCriteria: string[];
}

const fmt = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(3));

/** One task body per finding, however many phases regressed. */
export function buildRevertProposal(
  entry: LedgerEntry,
  result: WatchResult,
  repo: string,
): RevertProposalTask {
  const id = `PAU-REVERT-${entry.fingerprint}`;
  const regressed = result.phases.filter((p) => p.verdict === "regressed");
  const lines = regressed.flatMap((p) =>
    p.comparisons
      .filter((c) => c.regressed)
      .map(
        (c) =>
          `- ${p.phase}: ${c.metric} ${fmt(c.before)} -> ${fmt(c.after)} (runs ${p.beforeRuns} before / ${p.afterRuns} after)`,
      ),
  );
  return {
    id,
    title: `Review revert of prompt fix ${entry.fingerprint} (${entry.file})`,
    status: "pending",
    repo,
    branch: `revert/${id.toLowerCase()}`,
    hitl: true,
    description: [
      `The post-merge watch flagged finding ${entry.fingerprint} (${entry.rule} in ${entry.file}) as regressed. A human decides whether to revert; the watch changed nothing.`,
      "",
      "Regressions:",
      ...lines,
      "",
      "Caveats:",
      ...result.caveats.map((c) => `- ${c}`),
    ].join("\n"),
    acceptanceCriteria: [
      "A human confirmed or dismissed the regression against the caveats",
      "If confirmed, the revert PR is opened through plan-session",
    ],
  };
}

export interface WatchOutcome {
  result: WatchResult;
  ledger: Ledger;
  task?: RevertProposalTask;
  filed: boolean;
}

export interface WatchDeps {
  fetchFn: WatchFetch;
  postFn: WatchPostFetch;
  now: () => Date;
  taskStoreUrl?: string;
  taskStoreToken?: string;
}

/**
 * Run the watch for one ledger finding. On regression: mark it `regressed`
 * (appending history) and file the revert proposal once; an already
 * `regressed` finding is not re-filed. A 409 on POST means it already exists.
 */
export async function watchFinding(
  ledger: Ledger,
  fingerprint: string,
  opts: WatchOptions,
  repo: string,
  deps: WatchDeps,
): Promise<WatchOutcome> {
  const entry = ledger.findings[fingerprint];
  if (!entry) throw new Error(`finding ${fingerprint} is not in the ledger`);
  const series = await fetchWatchSeries(opts, deps.fetchFn);
  const result = evaluateWatch(fingerprint, opts, series);
  if (result.verdict !== "regressed" || entry.status === "regressed") {
    return { result, ledger, filed: false };
  }

  const task = buildRevertProposal(entry, result, repo);
  let filed = false;
  if (deps.taskStoreUrl && deps.taskStoreToken) {
    const res = await deps.postFn(
      `${deps.taskStoreUrl.replace(/\/$/, "")}/tasks`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.taskStoreToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(task),
      },
    );
    if (!res.ok && res.status !== 409) {
      throw new Error(`POST /tasks failed: ${res.status}`);
    }
    filed = res.ok;
  }
  const at = deps.now().toISOString();
  const next: LedgerEntry = {
    ...entry,
    status: "regressed",
    history: [
      ...entry.history,
      { at, event: "regressed", status: "regressed" },
    ],
  };
  return {
    result,
    task,
    filed,
    ledger: { ...ledger, findings: { ...ledger.findings, [fingerprint]: next } },
  };
}

export function formatWatch(r: WatchResult): string {
  const rows = r.phases.map((p) =>
    p.verdict === "insufficient-data"
      ? `  ${p.phase}: insufficient data (${p.beforeRuns} before / ${p.afterRuns} after, need ${MIN_WATCH_RUNS})`
      : `  ${p.phase}: ${p.verdict}${p.comparisons
          .map((c) => ` ${c.metric} ${fmt(c.before)}->${fmt(c.after)}${c.regressed ? "!" : ""}`)
          .join(",")}`,
  );
  return `${[`Watch ${r.fingerprint}: ${r.verdict}`, ...rows, ...r.caveats.map((c) => `  note: ${c}`)].join("\n")}\n`;
}
