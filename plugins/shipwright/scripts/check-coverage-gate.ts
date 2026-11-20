// Pure computation for the coverage_gate block (feature + line, plus branch
// when the toolchain measures it).
//
// See planning/dual-coverage-gates/PRODUCT-SPEC.md, Feature 2: computes the
// eight-field coverage_gate block (feature_coverage_pct, feature_coverage_source,
// line_coverage_pct, line_coverage_source, branch_coverage_pct,
// branch_coverage_source, verdict, targets) and a
// self-consistency guard — a caller-supplied verdict that doesn't match the
// recomputed one throws, making a contradictory block structurally
// unrenderable rather than policy-enforced by a prompt instruction.
//
// CLI entrypoint (CGT-1.3): wired into the test-readiness-plan.md render
// step in plugins/shipwright/skills/test-roadmap/SKILL.md, which invokes
// this script via Bash rather than hand-computing the verdict text.
//
// linePct may be null (unmeasured, e.g. no shipwright-coverage artifact);
// the verdict is then "BLOCKED: line coverage not reporting".
//
// branchPct is optional. Branch data is optional in the coverage contract
// (references/coverage-output.md) and several toolchains never emit it, so an
// absent or null branchPct is "not measured": it is reported as null and does
// NOT block. A measured branchPct below targets.branch blocks like any gate.
//
// CLI:
//   bun run "${CLAUDE_PLUGIN_ROOT}/scripts/check-coverage-gate.ts" '{"featurePct":92,"featureSource":"...","linePct":87,"lineSource":"...","branchPct":81,"branchSource":"..."}'
// or pipe the same JSON blob via stdin.

type CoverageGateTargets = {
  feature: number;
  line: number;
  branch: number;
};

/** Source text reported when branch coverage is unmeasured and no reason was given. */
export const BRANCH_NOT_MEASURED_SOURCE = "not measured";

export type ComputeCoverageGateInput = {
  featurePct: number;
  featureSource: string;
  /** `null` = line coverage unmeasured (reader returned not_reporting); `lineSource` carries the reason. */
  linePct: number | null;
  lineSource: string;
  /** Absent or `null` = branch coverage unmeasured (the artifact carries no branch data); never blocks. */
  branchPct?: number | null;
  /** Required when `branchPct` is a number; optional reason text when it is unmeasured. */
  branchSource?: string;
  /** Any omitted target falls back to its default. */
  targets?: Partial<CoverageGateTargets>;
  /** Caller-supplied verdict, checked against the recomputed verdict. */
  verdict?: string;
};

type CoverageGate = {
  feature_coverage_pct: number;
  feature_coverage_source: string;
  line_coverage_pct: number | null;
  line_coverage_source: string;
  branch_coverage_pct: number | null;
  branch_coverage_source: string;
  verdict: string;
  targets: CoverageGateTargets;
};

// Branch defaults to the test-design blueprint's ≥80% floor: branch coverage
// runs structurally lower than line coverage for the same suite.
const DEFAULT_TARGETS: CoverageGateTargets = {
  feature: 90,
  line: 90,
  branch: 80,
};

function requireDefined<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`computeCoverageGate: missing required field '${name}'`);
  }
  return value;
}

function requireField<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null || value === "") {
    throw new Error(`computeCoverageGate: missing required field '${name}'`);
  }
  return value;
}

function recomputeVerdict(
  featurePct: number,
  linePct: number | null,
  branchPct: number | null,
  targets: CoverageGateTargets,
): string {
  const gaps: string[] = [];
  if (featurePct < targets.feature) {
    gaps.push(`feature coverage ${featurePct}% < ${targets.feature}%`);
  }
  if (linePct === null) {
    gaps.push("line coverage not reporting");
  } else if (linePct < targets.line) {
    gaps.push(`line coverage ${linePct}% < ${targets.line}%`);
  }
  // Unmeasured branch coverage (null) is not a gap — see the header comment.
  if (branchPct !== null && branchPct < targets.branch) {
    gaps.push(`branch coverage ${branchPct}% < ${targets.branch}%`);
  }

  if (gaps.length === 0) return "READY";
  return `BLOCKED: ${gaps.join(", ")}`;
}

/**
 * Computes the eight-field coverage_gate block plus a READY/BLOCKED verdict
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
  const linePct = requireDefined(input.linePct, "linePct");
  const lineSource = requireField(input.lineSource, "lineSource");
  const branchPct = input.branchPct ?? null;
  const branchSource =
    branchPct === null
      ? input.branchSource || BRANCH_NOT_MEASURED_SOURCE
      : requireField(input.branchSource, "branchSource");
  const targets: CoverageGateTargets = { ...DEFAULT_TARGETS };
  for (const key of ["feature", "line", "branch"] as const) {
    const value = input.targets?.[key];
    if (value !== undefined && value !== null) targets[key] = value;
  }

  const verdict = recomputeVerdict(featurePct, linePct, branchPct, targets);

  if (input.verdict !== undefined && input.verdict !== verdict) {
    throw new Error(
      `computeCoverageGate: supplied verdict '${input.verdict}' is inconsistent with the recomputed verdict '${verdict}' for featurePct=${featurePct}%, linePct=${linePct}%, branchPct=${branchPct === null ? "unmeasured" : `${branchPct}%`}, targets=${JSON.stringify(targets)}`,
    );
  }

  return {
    feature_coverage_pct: featurePct,
    feature_coverage_source: featureSource,
    line_coverage_pct: linePct,
    line_coverage_source: lineSource,
    branch_coverage_pct: branchPct,
    branch_coverage_source: branchSource,
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
  if (typeof parsed.linePct !== "number" && parsed.linePct !== null) {
    throw new Error('Input JSON must have a numeric or null "linePct" field');
  }
  if (typeof parsed.lineSource !== "string") {
    throw new Error('Input JSON must have a string "lineSource" field');
  }
  if (
    parsed.branchPct !== undefined &&
    parsed.branchPct !== null &&
    typeof parsed.branchPct !== "number"
  ) {
    throw new Error(
      'Input JSON "branchPct" must be a number or null when present',
    );
  }
  if (
    parsed.branchSource !== undefined &&
    typeof parsed.branchSource !== "string"
  ) {
    throw new Error('Input JSON "branchSource" must be a string when present');
  }
  if (typeof parsed.branchPct === "number" && !parsed.branchSource) {
    throw new Error(
      'Input JSON must have a string "branchSource" field when "branchPct" is a number',
    );
  }
  if (parsed.targets !== undefined) {
    if (
      typeof parsed.targets !== "object" ||
      parsed.targets === null ||
      Array.isArray(parsed.targets)
    ) {
      throw new Error('Input JSON "targets" must be an object when present');
    }
    for (const [key, value] of Object.entries(parsed.targets)) {
      if (typeof value !== "number") {
        throw new Error(`Input JSON "targets.${key}" must be a number`);
      }
    }
  }

  const input: ComputeCoverageGateInput = {
    featurePct: parsed.featurePct,
    featureSource: parsed.featureSource,
    linePct: parsed.linePct,
    lineSource: parsed.lineSource,
  };
  if (parsed.branchPct !== undefined) input.branchPct = parsed.branchPct;
  if (parsed.branchSource !== undefined)
    input.branchSource = parsed.branchSource;
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
