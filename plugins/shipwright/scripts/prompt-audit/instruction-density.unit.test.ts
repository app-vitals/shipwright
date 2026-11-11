/**
 * plugins/shipwright/scripts/prompt-audit/instruction-density.unit.test.ts
 */

import { describe, expect, test } from "bun:test";
import { analyzeInstructionDensity } from "./instruction-density.ts";

const FIXTURE = [
  "---",
  "name: demo",
  "---",
  "# Demo",
  "",
  "Some background prose here.",
  "1. Run the tests",
  "2. Check the output",
  "- Use the **Fix the build** helper",
  "You MUST commit. NEVER push to main.",
  "```",
  "Run this in a fence ALWAYS ignored",
  "```",
].join("\n");

describe("analyzeInstructionDensity", () => {
  const r = analyzeInstructionDensity(FIXTURE);

  test("counts markers on a known fixture", () => {
    expect(r.numberedSteps).toBe(2);
    expect(r.capsEmphasis).toBe(2);
    expect(r.boldImperatives).toBe(1);
    expect(r.imperatives).toBe(3);
    expect(r.nonBlankLines).toBe(6);
  });

  test("reports first hard constraint line and ratio", () => {
    expect(r.firstHardConstraintLine).toBe(10);
    expect(r.firstHardConstraintRatio).toBeCloseTo(10 / 13);
  });

  test("density is markers per non-blank line", () => {
    expect(r.densityPerLine).toBeCloseTo((3 + 2 + 2 + 1) / 6);
  });

  test("handles text with no constraints and empty input", () => {
    const none = analyzeInstructionDensity("just prose\nmore prose");
    expect(none.firstHardConstraintLine).toBeNull();
    expect(none.firstHardConstraintRatio).toBeNull();
    const empty = analyzeInstructionDensity("");
    expect(empty.densityPerLine).toBe(0);
  });
});
