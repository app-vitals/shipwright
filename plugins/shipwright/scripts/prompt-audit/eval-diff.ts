/**
 * plugins/shipwright/scripts/prompt-audit/eval-diff.ts
 *
 * Diff of two eval result JSONs using paired statistics: cases are paired
 * across arms (same case, same seed index) and analysed with the exact
 * McNemar test on discordant pairs, never independent-sample statistics.
 * Every result prints the minimum detectable effect (MDE) and uses the
 * "no-regression-detected-within-MDE" wording.
 */

import { MIN_SEEDS } from "./eval-cost.ts";

/** Per-case, per-seed pass/fail for one arm. */
export interface EvalResult {
  arm: string;
  cases: Record<string, boolean[]>;
}

export type Verdict =
  | "regression-detected"
  | "improvement-detected"
  | "inconclusive-unpaired-cases"
  | "no-regression-detected-within-MDE";

export interface EvalDiff {
  before: string;
  after: string;
  pairs: number;
  /** before passed, after failed. */
  regressions: number;
  /** before failed, after passed. */
  improvements: number;
  pValue: number;
  /** Minimum detectable pass-rate difference at alpha 0.05, power 0.8. */
  mde: number;
  verdict: Verdict;
  unpairedCases: string[];
}

const Z_ALPHA = 1.96;
const Z_BETA = 0.8416;
const ALPHA = 0.05;

/** Two-sided exact McNemar p-value (binomial, p = 0.5, on b + c discordant pairs). */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let cdf = 0;
  let term = 0.5 ** n;
  for (let i = 0; i <= k; i++) {
    cdf += term;
    term = (term * (n - i)) / (i + 1);
  }
  return Math.min(1, 2 * cdf);
}

/** MDE of a paired binary comparison: (z_a + z_b) * sqrt(discordant rate / pairs). */
export function minimumDetectableEffect(
  pairs: number,
  discordant: number,
): number {
  if (pairs === 0) return 1;
  const rate = Math.max(discordant, 1) / pairs;
  return Math.min(1, (Z_ALPHA + Z_BETA) * Math.sqrt(rate / pairs));
}

export function diffEvals(before: EvalResult, after: EvalResult): EvalDiff {
  let pairs = 0;
  let b = 0;
  let c = 0;
  const unpairedCases: string[] = [];
  const ids = new Set([
    ...Object.keys(before.cases),
    ...Object.keys(after.cases),
  ]);
  for (const id of [...ids].sort()) {
    const x = before.cases[id];
    const y = after.cases[id];
    if (!x || !y || x.length !== y.length) {
      unpairedCases.push(id);
      continue;
    }
    if (x.length < MIN_SEEDS) {
      throw new Error(`case ${id} has ${x.length} seeds; need >= ${MIN_SEEDS}`);
    }
    x.forEach((pass, i) => {
      pairs++;
      if (pass && !y[i]) b++;
      else if (!pass && y[i]) c++;
    });
  }
  if (pairs === 0) throw new Error("no paired cases to compare");
  const pValue = mcnemarExact(b, c);
  const verdict: Verdict =
    pValue < ALPHA && b > c
      ? "regression-detected"
      : pValue < ALPHA && c > b
        ? "improvement-detected"
        : unpairedCases.length > 0
          ? "inconclusive-unpaired-cases"
          : "no-regression-detected-within-MDE";
  return {
    before: before.arm,
    after: after.arm,
    pairs,
    regressions: b,
    improvements: c,
    pValue,
    mde: minimumDetectableEffect(pairs, b + c),
    verdict,
    unpairedCases,
  };
}

export function renderDiff(d: EvalDiff): string {
  return [
    `Paired eval diff (exact McNemar): ${d.before} -> ${d.after}`,
    `pairs: ${d.pairs}  regressions: ${d.regressions}  improvements: ${d.improvements}  p: ${d.pValue.toFixed(4)}`,
    `minimum detectable effect: ${(d.mde * 100).toFixed(1)} pp`,
    `verdict: ${d.verdict}`,
    ...(d.unpairedCases.length
      ? [
          `unpaired (excluded, verdict inconclusive): ${d.unpairedCases.join(", ")}`,
        ]
      : []),
  ].join("\n");
}
