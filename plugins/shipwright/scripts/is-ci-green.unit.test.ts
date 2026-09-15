// Unit tests for is-ci-green.ts — pure logic, no I/O.
//
// Covers the CI Gate's "dedup latest run per workflow_id, then require every
// deduped run to be green" classification used by
// plugins/shipwright/commands/dev-task.md's Step 9b.2 CI Gate logic, and by
// any other command that needs a shared, self-contained CI-green check
// (plugins/shipwright must stay installable standalone — no
// @shipwright/lib import).

import { describe, expect, it } from "bun:test";
import { isCiGreen, type WorkflowRun } from "./is-ci-green";

function run(
  overrides: Partial<WorkflowRun> & { conclusion: string | null },
): WorkflowRun {
  return {
    workflow_id: 1,
    run_number: 1,
    ...overrides,
  };
}

describe("isCiGreen — individual conclusion values (single run)", () => {
  it("success -> true", () => {
    expect(isCiGreen([run({ conclusion: "success" })])).toBe(true);
  });

  it("skipped -> true", () => {
    expect(isCiGreen([run({ conclusion: "skipped" })])).toBe(true);
  });

  it("neutral -> true", () => {
    expect(isCiGreen([run({ conclusion: "neutral" })])).toBe(true);
  });

  it("failure -> false", () => {
    expect(isCiGreen([run({ conclusion: "failure" })])).toBe(false);
  });

  it("cancelled -> false", () => {
    expect(isCiGreen([run({ conclusion: "cancelled" })])).toBe(false);
  });

  it("timed_out -> false", () => {
    expect(isCiGreen([run({ conclusion: "timed_out" })])).toBe(false);
  });

  it("action_required -> false", () => {
    expect(isCiGreen([run({ conclusion: "action_required" })])).toBe(false);
  });

  it("stale -> false", () => {
    expect(isCiGreen([run({ conclusion: "stale" })])).toBe(false);
  });

  it("startup_failure -> false", () => {
    expect(isCiGreen([run({ conclusion: "startup_failure" })])).toBe(false);
  });

  it("null (not-yet-concluded) -> false", () => {
    expect(isCiGreen([run({ conclusion: null })])).toBe(false);
  });
});

describe("isCiGreen — dedup by workflow_id (highest run_number wins)", () => {
  it("stale failed run superseded by a successful rerun -> true", () => {
    const runs: WorkflowRun[] = [
      { workflow_id: 42, run_number: 1, conclusion: "failure" },
      { workflow_id: 42, run_number: 2, conclusion: "success" },
    ];
    expect(isCiGreen(runs)).toBe(true);
  });

  it("stale successful run superseded by a failed rerun -> false (proves dedup picks highest run_number, not 'any success')", () => {
    const runs: WorkflowRun[] = [
      { workflow_id: 42, run_number: 1, conclusion: "success" },
      { workflow_id: 42, run_number: 2, conclusion: "failure" },
    ];
    expect(isCiGreen(runs)).toBe(false);
  });

  it("multiple distinct workflow_ids: true only when every deduped workflow is green", () => {
    const allGreen: WorkflowRun[] = [
      { workflow_id: 1, run_number: 1, conclusion: "success" },
      { workflow_id: 2, run_number: 1, conclusion: "skipped" },
      { workflow_id: 3, run_number: 1, conclusion: "neutral" },
    ];
    expect(isCiGreen(allGreen)).toBe(true);

    const oneNotGreen: WorkflowRun[] = [
      { workflow_id: 1, run_number: 1, conclusion: "success" },
      { workflow_id: 2, run_number: 1, conclusion: "failure" },
      { workflow_id: 3, run_number: 1, conclusion: "neutral" },
    ];
    expect(isCiGreen(oneNotGreen)).toBe(false);
  });

  it("distinct workflow_ids with dedup: latest run per workflow decides, not stale reruns", () => {
    const runs: WorkflowRun[] = [
      // workflow 1: stale failure, latest success
      { workflow_id: 1, run_number: 1, conclusion: "failure" },
      { workflow_id: 1, run_number: 2, conclusion: "success" },
      // workflow 2: only one run, success
      { workflow_id: 2, run_number: 1, conclusion: "success" },
    ];
    expect(isCiGreen(runs)).toBe(true);
  });
});

describe("isCiGreen — empty run list", () => {
  it("returns false (fail-closed)", () => {
    expect(isCiGreen([])).toBe(false);
  });
});
