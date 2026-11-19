/**
 * Content guard for .github/workflows/ci.yml: the chart shell suites must run
 * inside the required `ci` job so a failure fails it, and the step cannot be
 * silently dropped. The bump-PR suite (test-auto-bump-chart.sh) is retired
 * with auto-bump-chart.yml (ADR 0001) and must not come back. See
 * library-chart-release.content.test.ts for the precedent.
 *
 * Lives at the repo root (not under .github/) because `bun test` never walks
 * dot-directories.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir);

type Step = { name?: string; run?: string; "continue-on-error"?: boolean };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

const SUITES = [
  "test-chart-release.sh",
  "test-library-pin.sh",
  "test-check-chart-drift.sh",
];

describe("ci.yml chart shell tests", () => {
  const text = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const wf = Bun.YAML.parse(text) as Workflow;
  const step = wf.jobs.ci.steps.find((s) =>
    s.run?.includes("test-chart-release.sh"),
  );

  it("runs every chart shell suite in the same required ci job step", () => {
    for (const f of SUITES) {
      expect(step?.run).toContain(`bash .github/workflows/${f}`);
    }
  });

  it("does not swallow failures", () => {
    expect(step?.["continue-on-error"]).toBeUndefined();
    expect(step?.run).not.toMatch(/\|\|\s*true/);
  });

  it("keeps the suites and the shared libs present on disk", () => {
    for (const f of SUITES) {
      expect(existsSync(join(ROOT, ".github/workflows", f))).toBe(true);
    }
    for (const f of ["chart-release.sh", "chart-tag-utils.sh"]) {
      expect(existsSync(join(ROOT, ".github/workflows/lib", f))).toBe(true);
    }
  });

  it("no longer runs or ships the retired bump-PR suite", () => {
    expect(text).not.toContain("test-auto-bump-chart.sh");
    expect(text).not.toContain("auto-bump-chart.yml");
    expect(
      existsSync(join(ROOT, ".github/workflows/test-auto-bump-chart.sh")),
    ).toBe(false);
    expect(
      existsSync(join(ROOT, ".github/workflows/auto-bump-chart.yml")),
    ).toBe(false);
  });
});
