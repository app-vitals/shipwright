/**
 * Unit tests for plugins/shipwright/scripts/check-coverage-gate.ts
 *
 * Pure function, no I/O: computeCoverageGate() computes the dual (feature +
 * line) coverage_gate block and a self-consistency guard over a
 * caller-supplied verdict. See planning/dual-coverage-gates/PRODUCT-SPEC.md,
 * Feature 2.
 *
 * Also covers the CLI entrypoint (CGT-1.3): parseCliInput() is exported and
 * unit-testable directly, plus a thin subprocess-level test exercises the
 * real `bun run` invocation the test-roadmap render step performs via Bash.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  BRANCH_NOT_MEASURED_SOURCE,
  computeCoverageGate,
  parseCliInput,
} from "./check-coverage-gate";

const SCRIPT_PATH = join(import.meta.dir, "check-coverage-gate.ts");

async function runCli(
  stdin: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT_PATH], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const BASE_INPUT = {
  featurePct: 95,
  featureSource: "test-inventory feature matrix",
  linePct: 95,
  lineSource: "coverage/lcov.info",
};

describe("computeCoverageGate", () => {
  it("returns READY when both featurePct and linePct are >= 90%", () => {
    const result = computeCoverageGate(BASE_INPUT);
    expect(result.verdict).toBe("READY");
    expect(result.feature_coverage_pct).toBe(95);
    expect(result.feature_coverage_source).toBe(
      "test-inventory feature matrix",
    );
    expect(result.line_coverage_pct).toBe(95);
    expect(result.line_coverage_source).toBe("coverage/lcov.info");
    expect(result.targets).toEqual({ feature: 90, line: 90, branch: 80 });
  });

  it("treats exactly 90% as passing for both gates (boundary)", () => {
    const result = computeCoverageGate({
      ...BASE_INPUT,
      featurePct: 90,
      linePct: 90,
    });
    expect(result.verdict).toBe("READY");
  });

  it("returns BLOCKED naming feature coverage when only the feature gate fails", () => {
    const result = computeCoverageGate({
      ...BASE_INPUT,
      featurePct: 84,
      linePct: 95,
    });
    expect(result.verdict).toContain("BLOCKED");
    expect(result.verdict).toContain("feature coverage 84% < 90%");
    expect(result.verdict).not.toContain("line coverage");
  });

  it("returns BLOCKED naming line coverage when only the line gate fails", () => {
    const result = computeCoverageGate({
      ...BASE_INPUT,
      featurePct: 95,
      linePct: 84,
    });
    expect(result.verdict).toContain("BLOCKED");
    expect(result.verdict).toContain("line coverage 84% < 90%");
    expect(result.verdict).not.toContain("feature coverage");
  });

  it("returns BLOCKED naming both gates when both fail, with margins", () => {
    const result = computeCoverageGate({
      ...BASE_INPUT,
      featurePct: 70,
      linePct: 84,
    });
    expect(result.verdict).toContain("BLOCKED");
    expect(result.verdict).toContain("feature coverage 70% < 90%");
    expect(result.verdict).toContain("line coverage 84% < 90%");
  });

  it("defaults targets to { feature: 90, line: 90, branch: 80 } when not supplied", () => {
    const result = computeCoverageGate(BASE_INPUT);
    expect(result.targets).toEqual({ feature: 90, line: 90, branch: 80 });
  });

  it("respects caller-supplied targets", () => {
    const result = computeCoverageGate({
      ...BASE_INPUT,
      featurePct: 92,
      linePct: 92,
      targets: { feature: 95, line: 95 },
    });
    expect(result.verdict).toContain("BLOCKED");
    expect(result.verdict).toContain("feature coverage 92% < 95%");
    expect(result.verdict).toContain("line coverage 92% < 95%");
    expect(result.targets).toEqual({ feature: 95, line: 95, branch: 80 });
  });

  it("throws when featurePct is missing", () => {
    expect(() =>
      computeCoverageGate({
        ...BASE_INPUT,
        featurePct: undefined as unknown as number,
      }),
    ).toThrow();
  });

  it("throws when linePct is missing", () => {
    expect(() =>
      computeCoverageGate({
        ...BASE_INPUT,
        linePct: undefined as unknown as number,
      }),
    ).toThrow();
  });

  it("returns null line_coverage_pct and a not-reporting verdict when linePct is null and feature is ok", () => {
    const r = computeCoverageGate({
      ...BASE_INPUT,
      linePct: null,
      lineSource: "no shipwright-coverage artifact",
    });
    expect(r.line_coverage_pct).toBeNull();
    expect(r.line_coverage_source).toBe("no shipwright-coverage artifact");
    expect(r.verdict).toBe("BLOCKED: line coverage not reporting");
  });

  it("combines the feature-gap clause with not-reporting when linePct is null and feature is short", () => {
    const r = computeCoverageGate({
      ...BASE_INPUT,
      featurePct: 80,
      linePct: null,
      lineSource: "no artifact",
    });
    expect(r.verdict).toBe(
      "BLOCKED: feature coverage 80% < 90%, line coverage not reporting",
    );
  });

  it("still throws on a mismatched supplied verdict when linePct is null", () => {
    expect(() =>
      computeCoverageGate({
        ...BASE_INPUT,
        linePct: null,
        lineSource: "no artifact",
        verdict: "READY",
      }),
    ).toThrow(/inconsistent/);
  });

  it("throws when featureSource is missing", () => {
    expect(() =>
      computeCoverageGate({
        ...BASE_INPUT,
        featureSource: undefined as unknown as string,
      }),
    ).toThrow();
  });

  it("throws when lineSource is missing", () => {
    expect(() =>
      computeCoverageGate({
        ...BASE_INPUT,
        lineSource: undefined as unknown as string,
      }),
    ).toThrow();
  });

  it("throws a clear error naming the missing field", () => {
    expect(() =>
      computeCoverageGate({
        ...BASE_INPUT,
        featurePct: undefined as unknown as number,
      }),
    ).toThrow(/featurePct/);
  });

  it("throws when a caller-supplied verdict is inconsistent with the recomputed READY verdict", () => {
    expect(() =>
      computeCoverageGate({
        ...BASE_INPUT,
        featurePct: 70,
        linePct: 95,
        verdict: "READY",
      }),
    ).toThrow();
  });

  it("throws when a caller-supplied verdict is inconsistent with the recomputed BLOCKED verdict", () => {
    expect(() =>
      computeCoverageGate({
        ...BASE_INPUT,
        featurePct: 95,
        linePct: 95,
        verdict: "BLOCKED: line coverage 10% < 90%",
      }),
    ).toThrow();
  });

  it("does not throw when a caller-supplied verdict matches the recomputed READY verdict", () => {
    expect(() =>
      computeCoverageGate({
        ...BASE_INPUT,
        featurePct: 95,
        linePct: 95,
        verdict: "READY",
      }),
    ).not.toThrow();
  });

  it("does not throw when a caller-supplied verdict matches the recomputed BLOCKED verdict text exactly", () => {
    const recomputed = computeCoverageGate({
      ...BASE_INPUT,
      featurePct: 84,
      linePct: 95,
    });
    expect(() =>
      computeCoverageGate({
        ...BASE_INPUT,
        featurePct: 84,
        linePct: 95,
        verdict: recomputed.verdict,
      }),
    ).not.toThrow();
  });
});

describe("computeCoverageGate — branch coverage", () => {
  const BRANCH_INPUT = {
    ...BASE_INPUT,
    branchPct: 85,
    branchSource: "CI run https://example.invalid/run/1 @ abc1234",
  };

  it("reports branch coverage and stays READY when branchPct meets the 80% default", () => {
    const r = computeCoverageGate(BRANCH_INPUT);
    expect(r.verdict).toBe("READY");
    expect(r.branch_coverage_pct).toBe(85);
    expect(r.branch_coverage_source).toBe(BRANCH_INPUT.branchSource);
  });

  it("treats exactly 80% as passing (boundary)", () => {
    expect(
      computeCoverageGate({ ...BRANCH_INPUT, branchPct: 80 }).verdict,
    ).toBe("READY");
  });

  it("returns BLOCKED naming branch coverage when only the branch gate fails", () => {
    const r = computeCoverageGate({ ...BRANCH_INPUT, branchPct: 40 });
    expect(r.verdict).toBe("BLOCKED: branch coverage 40% < 80%");
  });

  it("names all three gates in feature, line, branch order when all fail", () => {
    const r = computeCoverageGate({
      ...BRANCH_INPUT,
      featurePct: 70,
      linePct: 84,
      branchPct: 40,
    });
    expect(r.verdict).toBe(
      "BLOCKED: feature coverage 70% < 90%, line coverage 84% < 90%, branch coverage 40% < 80%",
    );
  });

  it("does not block when branchPct is absent (unmeasured)", () => {
    const r = computeCoverageGate(BASE_INPUT);
    expect(r.verdict).toBe("READY");
    expect(r.branch_coverage_pct).toBeNull();
    expect(r.branch_coverage_source).toBe(BRANCH_NOT_MEASURED_SOURCE);
  });

  it("does not block when branchPct is null, and keeps a supplied reason", () => {
    const r = computeCoverageGate({
      ...BASE_INPUT,
      branchPct: null,
      branchSource: "artifact carries no branch data",
    });
    expect(r.verdict).toBe("READY");
    expect(r.branch_coverage_pct).toBeNull();
    expect(r.branch_coverage_source).toBe("artifact carries no branch data");
  });

  it("treats a measured 0% as a real failing value, not as unmeasured", () => {
    const r = computeCoverageGate({ ...BRANCH_INPUT, branchPct: 0 });
    expect(r.branch_coverage_pct).toBe(0);
    expect(r.verdict).toBe("BLOCKED: branch coverage 0% < 80%");
  });

  it("throws when branchPct is a number but branchSource is missing", () => {
    expect(() => computeCoverageGate({ ...BASE_INPUT, branchPct: 85 })).toThrow(
      /branchSource/,
    );
  });

  it("respects a caller-supplied branch target", () => {
    const r = computeCoverageGate({
      ...BRANCH_INPUT,
      targets: { feature: 90, line: 90, branch: 90 },
    });
    expect(r.verdict).toBe("BLOCKED: branch coverage 85% < 90%");
  });

  it("fills the branch target default when targets omits it (pre-branch callers)", () => {
    const r = computeCoverageGate({
      ...BRANCH_INPUT,
      branchPct: 75,
      targets: { feature: 95, line: 95 },
    });
    expect(r.targets).toEqual({ feature: 95, line: 95, branch: 80 });
    expect(r.verdict).toBe("BLOCKED: branch coverage 75% < 80%");
  });

  it("throws on a supplied READY verdict when the branch gate fails", () => {
    expect(() =>
      computeCoverageGate({ ...BRANCH_INPUT, branchPct: 40, verdict: "READY" }),
    ).toThrow(/inconsistent/);
  });
});

describe("parseCliInput — branch coverage", () => {
  it("passes branchPct and branchSource through", () => {
    const input = parseCliInput(
      JSON.stringify({ ...BASE_INPUT, branchPct: 81, branchSource: "run" }),
    );
    expect(input.branchPct).toBe(81);
    expect(input.branchSource).toBe("run");
  });

  it("omits the branch fields when absent", () => {
    const input = parseCliInput(JSON.stringify(BASE_INPUT));
    expect("branchPct" in input).toBe(false);
    expect("branchSource" in input).toBe(false);
  });

  it("accepts an explicit null branchPct", () => {
    const input = parseCliInput(
      JSON.stringify({ ...BASE_INPUT, branchPct: null }),
    );
    expect(input.branchPct).toBeNull();
  });

  it("throws when branchPct is not a number or null", () => {
    expect(() =>
      parseCliInput(JSON.stringify({ ...BASE_INPUT, branchPct: "81" })),
    ).toThrow(/branchPct/);
  });

  it("throws when branchPct is a number without a branchSource", () => {
    expect(() =>
      parseCliInput(JSON.stringify({ ...BASE_INPUT, branchPct: 81 })),
    ).toThrow(/branchSource/);
  });

  it("throws when branchSource is not a string", () => {
    expect(() =>
      parseCliInput(JSON.stringify({ ...BASE_INPUT, branchSource: 5 })),
    ).toThrow(/branchSource/);
  });

  it("throws when a target is not a number", () => {
    expect(() =>
      parseCliInput(
        JSON.stringify({ ...BASE_INPUT, targets: { branch: "80" } }),
      ),
    ).toThrow(/targets\.branch/);
  });

  it("throws when targets is not an object", () => {
    expect(() =>
      parseCliInput(JSON.stringify({ ...BASE_INPUT, targets: 90 })),
    ).toThrow(/targets/);
  });
});

describe("CLI entrypoint (subprocess) — branch coverage", () => {
  it("prints the branch fields and a branch-gap verdict", async () => {
    const { exitCode, stdout } = await runCli(
      JSON.stringify({ ...BASE_INPUT, branchPct: 40, branchSource: "run" }),
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.branch_coverage_pct).toBe(40);
    expect(parsed.branch_coverage_source).toBe("run");
    expect(parsed.targets.branch).toBe(80);
    expect(parsed.verdict).toBe("BLOCKED: branch coverage 40% < 80%");
  });
});

describe("parseCliInput", () => {
  it("parses a valid JSON blob into a ComputeCoverageGateInput", () => {
    const result = parseCliInput(JSON.stringify(BASE_INPUT));
    expect(result).toEqual(BASE_INPUT);
  });

  it("parses optional targets and verdict fields when present", () => {
    const raw = JSON.stringify({
      ...BASE_INPUT,
      targets: { feature: 95, line: 95 },
      verdict: "READY",
    });
    const result = parseCliInput(raw);
    expect(result.targets).toEqual({ feature: 95, line: 95 });
    expect(result.verdict).toBe("READY");
  });

  it("omits targets/verdict from the parsed result when absent", () => {
    const result = parseCliInput(JSON.stringify(BASE_INPUT));
    expect(result.targets).toBeUndefined();
    expect(result.verdict).toBeUndefined();
  });

  it("throws on malformed JSON", () => {
    expect(() => parseCliInput("not json")).toThrow();
  });

  it("throws when featurePct is missing from the input JSON", () => {
    const { featurePct: _drop, ...rest } = BASE_INPUT;
    expect(() => parseCliInput(JSON.stringify(rest))).toThrow(/featurePct/);
  });

  it("throws when featureSource is missing from the input JSON", () => {
    const { featureSource: _drop, ...rest } = BASE_INPUT;
    expect(() => parseCliInput(JSON.stringify(rest))).toThrow(/featureSource/);
  });

  it("throws when linePct is missing from the input JSON", () => {
    const { linePct: _drop, ...rest } = BASE_INPUT;
    expect(() => parseCliInput(JSON.stringify(rest))).toThrow(/linePct/);
  });

  it("accepts an explicit null linePct in the input JSON", () => {
    const input = parseCliInput(
      JSON.stringify({ ...BASE_INPUT, linePct: null, lineSource: "reason" }),
    );
    expect(input.linePct).toBeNull();
  });

  it("throws when lineSource is missing from the input JSON", () => {
    const { lineSource: _drop, ...rest } = BASE_INPUT;
    expect(() => parseCliInput(JSON.stringify(rest))).toThrow(/lineSource/);
  });

  it("throws when featurePct is not a number", () => {
    expect(() =>
      parseCliInput(JSON.stringify({ ...BASE_INPUT, featurePct: "95" })),
    ).toThrow(/featurePct/);
  });
});

describe("CLI entrypoint (subprocess)", () => {
  it("prints the computed coverage_gate JSON to stdout and exits 0 on valid input", async () => {
    const { exitCode, stdout, stderr } = await runCli(
      JSON.stringify(BASE_INPUT),
    );
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toEqual(computeCoverageGate(BASE_INPUT));
  });

  it("exits nonzero and prints an error to stderr when a required field is missing", async () => {
    const { featurePct: _drop, ...rest } = BASE_INPUT;
    const { exitCode, stdout, stderr } = await runCli(JSON.stringify(rest));
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("featurePct");
    expect(stdout.trim()).toBe("");
  });

  it("exits nonzero and prints an error to stderr when the supplied verdict is inconsistent", async () => {
    const { exitCode, stderr } = await runCli(
      JSON.stringify({
        ...BASE_INPUT,
        featurePct: 70,
        verdict: "READY",
      }),
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("inconsistent");
  });

  it("exits 0 and prints null line_coverage_pct with a not-reporting verdict for linePct null", async () => {
    const { exitCode, stdout } = await runCli(
      JSON.stringify({
        ...BASE_INPUT,
        linePct: null,
        lineSource: "no artifact",
      }),
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.line_coverage_pct).toBeNull();
    expect(parsed.verdict).toContain("line coverage not reporting");
  });

  it("accepts the JSON blob as argv[2] instead of stdin", async () => {
    const proc = Bun.spawn(
      ["bun", "run", SCRIPT_PATH, JSON.stringify(BASE_INPUT)],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual(computeCoverageGate(BASE_INPUT));
  });
});
