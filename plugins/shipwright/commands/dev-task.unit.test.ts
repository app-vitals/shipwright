import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { groupChecksByName, parseActionsChecks } from "../scripts/ci-checks.ts";

const DEV_TASK_MD_PATH = join(import.meta.dir, "dev-task.md");
const METRICS_MD_PATH = join(import.meta.dir, "metrics.md");

let devTaskContent: string;
let metricsContent: string;

beforeAll(() => {
  devTaskContent = readFileSync(DEV_TASK_MD_PATH, "utf-8");
  metricsContent = readFileSync(METRICS_MD_PATH, "utf-8");
});

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
});

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
    const result = groupChecksByName(checks);
    expect(result).toBe("b (3×) | c (2×) | a (1×)");
  });

  it("ignores conclusion values when grouping — groups by name only", () => {
    const checks = [
      { name: "test/unit", conclusion: "success" },
      { name: "test/unit", conclusion: "failure" },
    ];
    expect(groupChecksByName(checks)).toBe("test/unit (2×)");
  });
});

describe("dev-task.md Step 9b — structured check data collection", () => {
  it("mentions collecting structured check data into ci_checks", () => {
    const hasCheckData =
      devTaskContent.includes("ci_checks") &&
      (devTaskContent.includes("structured check") ||
        devTaskContent.includes("ci_checks_json_array") ||
        devTaskContent.includes("ci_checks = []"));
    expect(hasCheckData).toBe(true);
  });
});

describe("dev-task.md Step 10a — execution metric fields in PATCH body", () => {
  it("includes ciFixAttempts in the Step 10a PATCH body", () => {
    expect(devTaskContent.includes("ciFixAttempts")).toBe(true);
  });

  it("includes simplifyTotal in the Step 10a PATCH body", () => {
    expect(devTaskContent.includes("simplifyTotal")).toBe(true);
  });

  it("includes coverageDelta in the Step 10a PATCH body", () => {
    expect(devTaskContent.includes("coverageDelta")).toBe(true);
  });

  it("includes model (EFFECTIVE_MODEL) in the Step 10a PATCH body", () => {
    expect(devTaskContent.includes('\\"model\\": \\"{EFFECTIVE_MODEL}\\"')).toBe(true);
  });
});

describe("metrics.md CI Gate section — check-name grouping", () => {
  it("includes check-name grouping instruction text", () => {
    const hasGrouping =
      metricsContent.includes("check name") ||
      metricsContent.includes("Check name") ||
      metricsContent.includes("groupChecksByName") ||
      metricsContent.includes("check-name");
    expect(hasGrouping).toBe(true);
  });

  it("shows frequency notation (e.g. 4×)", () => {
    const hasFrequency =
      metricsContent.includes("×)") ||
      metricsContent.includes("frequency") ||
      metricsContent.includes("4×");
    expect(hasFrequency).toBe(true);
  });
});
