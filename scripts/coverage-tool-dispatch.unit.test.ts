/**
 * Unit tests for scripts/coverage-tool-dispatch.ts
 *
 * Verifies extractCoverageTool (parses the `**Coverage toolchain:**` field
 * out of test-system.md-style markdown) and selectParser (the MTC-1.6
 * per-repo dispatch from a recorded tool name to its CoverageParser,
 * defaulting to LcovParser when unset/unrecognized). Pure logic, no I/O.
 */
import { describe, expect, test } from "bun:test";
import {
  CoveragePyParser,
  GoCoverParser,
  IstanbulParser,
  JacocoParser,
  LcovParser,
} from "./check-coverage";
import { extractCoverageTool, selectParser } from "./coverage-tool-dispatch";

describe("extractCoverageTool", () => {
  test("extracts the tool name from a realistic test-system.md-style fixture", () => {
    const fixture = [
      "- **Budget:** <15min total per PR — see Speed budgets below.",
      "- **Coverage toolchain:** `lcov` (Bun's native coverage reporter) — `bun test --coverage",
      "  --coverage-reporter=lcov`, gated by `scripts/check-coverage.ts` (the 80/80 line/function",
      "  floor parser referenced throughout this document).",
    ].join("\n");

    expect(extractCoverageTool(fixture)).toBe("lcov");
  });

  test("extracts each known tool name (jacoco, coverage.py, c8, nyc, go-cover)", () => {
    for (const tool of ["jacoco", "coverage.py", "c8", "nyc", "go-cover"]) {
      const fixture = `- **Coverage toolchain:** \`${tool}\` (some description) — details.`;
      expect(extractCoverageTool(fixture)).toBe(tool);
    }
  });

  test("returns undefined when the Coverage toolchain field is absent", () => {
    const fixture = [
      "- **Budget:** <15min total per PR — see Speed budgets below.",
      "- **Some other field:** `lcov` — not the field we want.",
    ].join("\n");

    expect(extractCoverageTool(fixture)).toBeUndefined();
  });

  test("returns undefined for empty content", () => {
    expect(extractCoverageTool("")).toBeUndefined();
  });
});

describe("selectParser", () => {
  test('dispatches "lcov" to LcovParser', () => {
    expect(selectParser("lcov")).toBe(LcovParser);
  });

  test('dispatches "jacoco" to JacocoParser', () => {
    expect(selectParser("jacoco")).toBe(JacocoParser);
  });

  test('dispatches "coverage.py" to CoveragePyParser', () => {
    expect(selectParser("coverage.py")).toBe(CoveragePyParser);
  });

  test('dispatches "c8", "nyc", and "c8-nyc" to IstanbulParser', () => {
    expect(selectParser("c8")).toBe(IstanbulParser);
    expect(selectParser("nyc")).toBe(IstanbulParser);
    expect(selectParser("c8-nyc")).toBe(IstanbulParser);
  });

  test('dispatches "go-cover" to GoCoverParser', () => {
    expect(selectParser("go-cover")).toBe(GoCoverParser);
  });

  test("falls back to LcovParser when the tool is undefined", () => {
    expect(selectParser(undefined)).toBe(LcovParser);
  });

  test("falls back to LcovParser for an unrecognized tool string", () => {
    expect(selectParser("some-unknown-tool")).toBe(LcovParser);
  });
});
