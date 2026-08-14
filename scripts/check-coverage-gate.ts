// Pure computation for the dual (feature + line) coverage_gate block.
//
// See planning/dual-coverage-gates/PRODUCT-SPEC.md, Feature 2: computes the
// six-field coverage_gate block (feature_coverage_pct, feature_coverage_source,
// line_coverage_pct, line_coverage_source, verdict, targets) and a
// self-consistency guard — a caller-supplied verdict that doesn't match the
// recomputed one throws, making a contradictory block structurally
// unrenderable rather than policy-enforced by a prompt instruction.
//
// No I/O, no CLI entrypoint, no caller yet — this is bundled with CGT-1.3,
// which wires it into the test-readiness-plan.md render step.

export type CoverageGateTargets = {
  feature: number;
  line: number;
};

export type ComputeCoverageGateInput = {
  featurePct: number;
  featureSource: string;
  linePct: number;
  lineSource: string;
  targets?: CoverageGateTargets;
  /** Caller-supplied verdict, checked against the recomputed verdict. */
  verdict?: string;
};

export type CoverageGate = {
  feature_coverage_pct: number;
  feature_coverage_source: string;
  line_coverage_pct: number;
  line_coverage_source: string;
  verdict: string;
  targets: CoverageGateTargets;
};

const DEFAULT_TARGETS: CoverageGateTargets = { feature: 90, line: 90 };

function requireField<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null || value === "") {
    throw new Error(`computeCoverageGate: missing required field '${name}'`);
  }
  return value;
}

function recomputeVerdict(
  featurePct: number,
  linePct: number,
  targets: CoverageGateTargets,
): string {
  const gaps: string[] = [];
  if (featurePct < targets.feature) {
    gaps.push(
      `feature coverage ${featurePct}% < ${targets.feature}%`,
    );
  }
  if (linePct < targets.line) {
    gaps.push(`line coverage ${linePct}% < ${targets.line}%`);
  }

  if (gaps.length === 0) return "READY";
  return `BLOCKED: ${gaps.join(", ")}`;
}

/**
 * Computes the six-field coverage_gate block plus a READY/BLOCKED verdict
 * naming the specific failing gate(s) and margin.
 *
 * Throws if a required field is missing, or if a caller-supplied `verdict`
 * doesn't match the recomputed verdict (self-consistency guard).
 */
export function computeCoverageGate(
  input: ComputeCoverageGateInput,
): CoverageGate {
  const featurePct = requireField(input.featurePct, "featurePct");
  const featureSource = requireField(input.featureSource, "featureSource");
  const linePct = requireField(input.linePct, "linePct");
  const lineSource = requireField(input.lineSource, "lineSource");
  const targets = input.targets ?? DEFAULT_TARGETS;

  const verdict = recomputeVerdict(featurePct, linePct, targets);

  if (input.verdict !== undefined && input.verdict !== verdict) {
    throw new Error(
      `computeCoverageGate: supplied verdict '${input.verdict}' is inconsistent with the recomputed verdict '${verdict}' for featurePct=${featurePct}%, linePct=${linePct}%, targets=${JSON.stringify(targets)}`,
    );
  }

  return {
    feature_coverage_pct: featurePct,
    feature_coverage_source: featureSource,
    line_coverage_pct: linePct,
    line_coverage_source: lineSource,
    verdict,
    targets,
  };
}
