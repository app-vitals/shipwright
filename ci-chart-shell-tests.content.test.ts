/**
 * Content guard for .github/workflows/ci.yml: the chart-bump shell suites must
 * run inside the required `ci` job so a failure fails it, and the step cannot
 * be silently dropped. See library-chart-release.content.test.ts for the
 * precedent.
 *
 * Lives at the repo root (not under .github/) because `bun test` never walks
 * dot-directories.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir);

type Step = { name?: string; run?: string; "continue-on-error"?: boolean };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

describe("ci.yml chart-bump shell tests", () => {
  const text = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const wf = Bun.YAML.parse(text) as Workflow;
  const step = wf.jobs.ci.steps.find((s) =>
    s.run?.includes("test-auto-bump-chart.sh"),
  );

  it("runs test-auto-bump-chart.sh in the required ci job", () => {
    expect(step?.run).toContain("bash .github/workflows/test-auto-bump-chart.sh");
  });

  it("runs test-check-chart-drift.sh in the same step", () => {
    expect(step?.run).toContain("bash .github/workflows/test-check-chart-drift.sh");
  });

  it("does not swallow failures", () => {
    expect(step?.["continue-on-error"]).toBeUndefined();
    expect(step?.run).not.toMatch(/\|\|\s*true/);
  });

  it("keeps both scripts present on disk", () => {
    for (const f of ["test-auto-bump-chart.sh", "test-check-chart-drift.sh"]) {
      expect(() => readFileSync(join(ROOT, ".github/workflows", f))).not.toThrow();
    }
  });
});
