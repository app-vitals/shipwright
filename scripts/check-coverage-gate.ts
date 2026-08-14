// Pure computation for the dual (feature + line) coverage_gate block.
//
// See planning/dual-coverage-gates/PRODUCT-SPEC.md, Feature 2: computes the
// six-field coverage_gate block (feature_coverage_pct, feature_coverage_source,
// line_coverage_pct, line_coverage_source, verdict, targets) and a
// self-consistency guard — a caller-supplied verdict that doesn't match the
// recomputed one throws, making a contradictory block structurally
// unrenderable rather than policy-enforced by a prompt instruction.
//
// CLI entrypoint (CGT-1.3): wired into the test-readiness-plan.md render
// step in plugins/shipwright/skills/test-roadmap/SKILL.md, which invokes
// this script via Bash rather than hand-computing the verdict text.
//
// CLI:
//   bun run scripts/check-coverage-gate.ts '{"featurePct":92,"featureSource":"...","linePct":87,"lineSource":"..."}'
// or pipe the same JSON blob via stdin.

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

// ─── CLI ──────────────────────────────────────────────────────────────────────

/**
 * Parses and validates the CLI's JSON input blob into a
 * ComputeCoverageGateInput. Throws with a message naming the offending field
 * on malformed JSON, a missing required field, or a wrong-typed field —
 * mirrors compute-review-verdict.ts's parseCliInput convention. Exported so
 * the CLI's input handling is directly unit-testable without spawning a
 * subprocess.
 */
export function parseCliInput(raw: string): ComputeCoverageGateInput {
  const parsed = JSON.parse(raw) as Partial<ComputeCoverageGateInput>;

  if (typeof parsed.featurePct !== "number") {
    throw new Error('Input JSON must have a numeric "featurePct" field');
  }
  if (typeof parsed.featureSource !== "string") {
    throw new Error('Input JSON must have a string "featureSource" field');
  }
  if (typeof parsed.linePct !== "number") {
    throw new Error('Input JSON must have a numeric "linePct" field');
  }
  if (typeof parsed.lineSource !== "string") {
    throw new Error('Input JSON must have a string "lineSource" field');
  }

  const input: ComputeCoverageGateInput = {
    featurePct: parsed.featurePct,
    featureSource: parsed.featureSource,
    linePct: parsed.linePct,
    lineSource: parsed.lineSource,
  };
  if (parsed.targets !== undefined) input.targets = parsed.targets;
  if (parsed.verdict !== undefined) input.verdict = parsed.verdict;
  return input;
}

if (import.meta.main) {
  const arg = process.argv[2];
  const raw = arg && arg.length > 0 ? arg : await Bun.stdin.text();
  try {
    const input = parseCliInput(raw);
    const result = computeCoverageGate(input);
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
