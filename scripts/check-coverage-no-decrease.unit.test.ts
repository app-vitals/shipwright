/**
 * Unit tests for scripts/check-coverage-no-decrease.ts
 *
 * Verifies evaluateCoverageDelta — the pure comparison function that decides
 * whether a PR's line-coverage percentage decreased relative to the base
 * branch. Pure logic, no I/O: nothing here touches the filesystem, git, or
 * the script's process.exit side effects.
 */
import { describe, expect, test } from "bun:test";
import { evaluateCoverageDelta } from "./check-coverage-no-decrease";

describe("evaluateCoverageDelta", () => {
  test("passes when current coverage increased over base", () => {
    const result = evaluateCoverageDelta(85.5, 80.0);
    expect(result).toEqual({ decreased: false });
  });

  test("fails when current coverage decreased from base", () => {
    const result = evaluateCoverageDelta(75.0, 80.0);
    expect(result).toEqual({ decreased: true });
  });

  test("passes when current coverage is unchanged from base", () => {
    const result = evaluateCoverageDelta(80.0, 80.0);
    expect(result).toEqual({ decreased: false });
  });

  test("passes at the exact equal-at-boundary case (current === base)", () => {
    // Explicitly called out by the AC as distinct from "no-change" — a PR
    // that holds coverage exactly flat must pass, not fail on an off-by
    // epsilon comparison.
    const result = evaluateCoverageDelta(80.0, 80.0);
    expect(result.decreased).toBe(false);
  });

  test("passes at a fractional equal-at-boundary case", () => {
    const result = evaluateCoverageDelta(83.33, 83.33);
    expect(result.decreased).toBe(false);
  });

  test("fails on a small fractional decrease", () => {
    const result = evaluateCoverageDelta(79.99, 80.0);
    expect(result.decreased).toBe(true);
  });

  test("passes on a small fractional increase", () => {
    const result = evaluateCoverageDelta(80.01, 80.0);
    expect(result.decreased).toBe(false);
  });

  test("passes when both are 100%", () => {
    const result = evaluateCoverageDelta(100, 100);
    expect(result.decreased).toBe(false);
  });

  test("passes when both are 0%", () => {
    const result = evaluateCoverageDelta(0, 0);
    expect(result.decreased).toBe(false);
  });
});
