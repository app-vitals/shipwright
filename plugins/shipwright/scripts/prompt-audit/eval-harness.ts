/**
 * plugins/shipwright/scripts/prompt-audit/eval-harness.ts
 *
 * Entry for the prompt-audit eval harness (case building, mechanical graders,
 * cost gate, paired diff). Does not run any eval: the plugin-eval runner is a
 * separate task. All fs/exec access is injected; nothing here spawns claude or
 * touches the network.
 */

import { buildEvalCases, type CaseDeps, writeEvalCases } from "./eval-cases.ts";
import {
  assertCostGate,
  type CostInput,
  parseMaxCostUsd,
} from "./eval-cost.ts";
import { diffEvals, type EvalResult, renderDiff } from "./eval-diff.ts";
import type { Finding } from "./finding.ts";

export * from "./eval-cases.ts";
export * from "./eval-cost.ts";
export * from "./eval-diff.ts";
export * from "./eval-graders.ts";

export interface HarnessDeps extends CaseDeps {
  readFile(path: string): string;
}

/** Build cases, enforce the cost gate, then write them. Returns a summary. */
export function prepareEvals(
  finding: Finding,
  repoDir: string,
  opts: {
    arms: number;
    runs: number;
    maxCostUsd?: string;
    lastPerCaseUsd?: number;
  },
  deps: CaseDeps,
): { cases: number; estimateUsd: number; maxCostUsd: number } {
  const cases = buildEvalCases(finding, repoDir, deps);
  const input: CostInput = {
    cases: cases.length,
    runs: opts.runs,
    arms: opts.arms,
    lastPerCaseUsd: opts.lastPerCaseUsd,
  };
  const gate = assertCostGate(input, parseMaxCostUsd(opts.maxCostUsd));
  writeEvalCases(cases, repoDir, deps);
  return { cases: cases.length, ...gate };
}

/** Diff two eval result JSON files and render the paired report. */
export function runEvalDiff(
  beforePath: string,
  afterPath: string,
  deps: Pick<HarnessDeps, "readFile">,
): string {
  const load = (p: string) => JSON.parse(deps.readFile(p)) as EvalResult;
  return renderDiff(diffEvals(load(beforePath), load(afterPath)));
}
