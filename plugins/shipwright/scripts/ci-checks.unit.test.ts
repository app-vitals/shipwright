// Isolated unit tests for ci-checks.ts's pure classification logic.
//
// Previously this module was only indirectly covered via dev-task.unit.test.ts's
// import graph. This file is self-sufficient: it has no dependency on dev-task.md,
// metrics.md, or any other fixture content — deleting dev-task.unit.test.ts leaves
// full coverage of parseActionsChecks and groupChecksByName intact.

import { describe, expect, it } from "bun:test";
import { groupChecksByName, parseActionsChecks } from "./ci-checks.ts";

// ─── parseActionsChecks ────────────────────────────────────────────────────────

describe("parseActionsChecks", () => {
  it("returns empty array for empty input", () => {
    expect(parseActionsChecks([])).toEqual([]);
  });

  it("returns parsed checks with name and conclusion", () => {
    const jobs = [
      { name: "test/unit", conclusion: "success" },
      { name: "lint/biome", conclusion: "failure" },
    ];
    expect(parseActionsChecks(jobs)).toEqual([
      { name: "test/unit", conclusion: "success" },
      { name: "lint/biome", conclusion: "failure" },
    ]);
  });

  it("handles null conclusions by converting to empty string", () => {
    const jobs = [
      { name: "test/unit", conclusion: null },
      { name: "lint/biome", conclusion: "success" },
    ];
    const result = parseActionsChecks(jobs);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("test/unit");
    expect(result[0].conclusion).toBe("");
    expect(result[1].conclusion).toBe("success");
  });

  it("includes all jobs regardless of conclusion", () => {
    const jobs = [
      { name: "build", conclusion: "success" },
      { name: "test/unit", conclusion: "failure" },
      { name: "test/integration", conclusion: "cancelled" },
      { name: "lint", conclusion: "timed_out" },
    ];
    expect(parseActionsChecks(jobs)).toHaveLength(4);
  });

  it("preserves original name and conclusion values", () => {
    const jobs = [{ name: "my/check-name_1", conclusion: "skipped" }];
    const result = parseActionsChecks(jobs);
    expect(result[0].name).toBe("my/check-name_1");
    expect(result[0].conclusion).toBe("skipped");
  });

  it("preserves job order in the output", () => {
    const jobs = [
      { name: "z-job", conclusion: "success" },
      { name: "a-job", conclusion: "success" },
      { name: "m-job", conclusion: "success" },
    ];
    const result = parseActionsChecks(jobs);
    expect(result.map((c) => c.name)).toEqual(["z-job", "a-job", "m-job"]);
  });
});

// ─── groupChecksByName ──────────────────────────────────────────────────────────

describe("groupChecksByName", () => {
  it("returns empty string for empty input", () => {
    expect(groupChecksByName([])).toBe("");
  });

  it("returns single check with frequency 1×", () => {
    const checks = [{ name: "test/unit", conclusion: "success" }];
    expect(groupChecksByName(checks)).toBe("test/unit (1×)");
  });

  it("counts multiple occurrences of the same check name", () => {
    const checks = [
      { name: "test/unit", conclusion: "failure" },
      { name: "test/unit", conclusion: "failure" },
      { name: "test/unit", conclusion: "failure" },
      { name: "test/unit", conclusion: "failure" },
    ];
    expect(groupChecksByName(checks)).toBe("test/unit (4×)");
  });

  it("sorts by frequency descending and joins with ' | '", () => {
    const checks = [
      { name: "lint/biome", conclusion: "failure" },
      { name: "test/unit", conclusion: "failure" },
      { name: "test/unit", conclusion: "failure" },
      { name: "test/unit", conclusion: "failure" },
      { name: "test/unit", conclusion: "failure" },
      { name: "lint/biome", conclusion: "failure" },
    ];
    expect(groupChecksByName(checks)).toBe("test/unit (4×) | lint/biome (2×)");
  });

  it("handles multiple groups with different frequencies", () => {
    const checks = [
      { name: "a", conclusion: "failure" },
      { name: "b", conclusion: "failure" },
      { name: "b", conclusion: "failure" },
      { name: "b", conclusion: "failure" },
      { name: "c", conclusion: "failure" },
      { name: "c", conclusion: "failure" },
    ];
    expect(groupChecksByName(checks)).toBe("b (3×) | c (2×) | a (1×)");
  });

  it("ignores conclusion values when grouping — groups by name only", () => {
    const checks = [
      { name: "test/unit", conclusion: "success" },
      { name: "test/unit", conclusion: "failure" },
    ];
    expect(groupChecksByName(checks)).toBe("test/unit (2×)");
  });

  it("breaks ties in frequency by name ascending for stable output", () => {
    const checks = [
      { name: "zeta", conclusion: "failure" },
      { name: "alpha", conclusion: "failure" },
      { name: "mid", conclusion: "failure" },
    ];
    // All frequencies tie at 1× — tiebreaker sorts alphabetically.
    expect(groupChecksByName(checks)).toBe("alpha (1×) | mid (1×) | zeta (1×)");
  });

  it("treats an empty-string check name as its own group", () => {
    const checks = [
      { name: "", conclusion: "success" },
      { name: "build", conclusion: "success" },
    ];
    expect(groupChecksByName(checks)).toBe(" (1×) | build (1×)");
  });
});
