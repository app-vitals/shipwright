/**
 * plugins/shipwright/scripts/prompt-audit/eval-cost.ts
 *
 * Eval cost estimate and gate: cases x runs x arms x per-case cost. The
 * per-case cost defaults to the spec's $0.10 and is overridden by the last
 * observed per-case cost. The gate refuses to run without an explicit cap
 * (--max-cost-usd) or when the estimate exceeds it.
 */

export const DEFAULT_COST_PER_CASE_USD = 0.1;
export const MIN_SEEDS = 3;

export interface CostInput {
  cases: number;
  /** Seeds per case per arm; at least MIN_SEEDS. */
  runs: number;
  arms: number;
  /** Last observed per-case cost; falls back to the default. */
  lastPerCaseUsd?: number;
}

export function estimateEvalCost(input: CostInput): number {
  const { cases, runs, arms } = input;
  if (runs < MIN_SEEDS) {
    throw new Error(`evals need >= ${MIN_SEEDS} seeds per case (got ${runs})`);
  }
  const per = input.lastPerCaseUsd ?? DEFAULT_COST_PER_CASE_USD;
  return +(cases * runs * arms * per).toFixed(2);
}

/** Parse a --max-cost-usd value; undefined when absent or not a positive number. */
export function parseMaxCostUsd(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface GateResult {
  estimateUsd: number;
  maxCostUsd: number;
}

/** Throws unless a cap is given and the estimate fits under it. */
export function assertCostGate(
  input: CostInput,
  maxCostUsd: number | undefined,
): GateResult {
  const estimateUsd = estimateEvalCost(input);
  if (maxCostUsd === undefined) {
    throw new Error(
      `refusing to run evals: --max-cost-usd is required (estimate $${estimateUsd.toFixed(2)})`,
    );
  }
  if (estimateUsd > maxCostUsd) {
    throw new Error(
      `refusing to run evals: estimate $${estimateUsd.toFixed(2)} exceeds --max-cost-usd $${maxCostUsd.toFixed(2)}`,
    );
  }
  return { estimateUsd, maxCostUsd };
}
