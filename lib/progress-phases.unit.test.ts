import { describe, expect, test } from "bun:test";
import { PROGRESS_LABELS, PROGRESS_PHASES } from "./progress-phases.ts";

describe("PROGRESS_PHASES", () => {
  test("is the closed set of exactly eleven phases", () => {
    expect(PROGRESS_PHASES).toHaveLength(11);
    expect(new Set(PROGRESS_PHASES).size).toBe(11);
  });

  test("contains exactly the documented phase names", () => {
    expect([...PROGRESS_PHASES].sort()).toEqual(
      [
        "starting",
        "thinking",
        "reading",
        "searching",
        "web",
        "editing",
        "running",
        "delegating",
        "planning",
        "tool",
        "writing",
      ].sort(),
    );
  });
});

describe("PROGRESS_LABELS", () => {
  test("has exactly one label per phase in PROGRESS_PHASES", () => {
    const labelKeys = Object.keys(PROGRESS_LABELS).sort();
    expect(labelKeys).toEqual([...PROGRESS_PHASES].sort());
  });

  test("every label is a non-empty human-readable string", () => {
    for (const phase of PROGRESS_PHASES) {
      expect(typeof PROGRESS_LABELS[phase]).toBe("string");
      expect(PROGRESS_LABELS[phase].length).toBeGreaterThan(0);
    }
  });

  // STS2-1.1: every in-progress label must end in "…" for consistent
  // Thinking Steps stream rendering (a bare, un-ellipsized label like
  // "Reading files" reads as a completed action, not an in-progress one).
  test("every label ends in an ellipsis (…), consistently", () => {
    for (const phase of PROGRESS_PHASES) {
      expect(PROGRESS_LABELS[phase].endsWith("…")).toBe(true);
    }
  });
});
