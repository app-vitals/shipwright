/**
 * Unit tests for scripts/check-coverage.ts
 *
 * Verifies LcovParser (the CoverageParser implementation for the lcov.info
 * format) and CoveragePyParser (the CoverageParser implementation for
 * coverage.py's `coverage json` output) against hand-built fixtures. Pure
 * logic, no I/O: parse(content) takes raw string content and returns
 * FileStats[] — nothing here touches the filesystem or triggers the
 * script's process.exit side effects.
 */
import { describe, expect, test } from "bun:test";
import { CoveragePyParser, LcovParser } from "./check-coverage";

describe("LcovParser.parse", () => {
  test("parses a single-file lcov record into FileStats", () => {
    const fixture = [
      "SF:agent/src/example.ts",
      "FNF:10",
      "FNH:8",
      "LF:100",
      "LH:90",
      "end_of_record",
    ].join("\n");

    const result = LcovParser.parse(fixture);

    expect(result).toEqual([
      { path: "agent/src/example.ts", lf: 100, lh: 90, fnf: 10, fnh: 8 },
    ]);
  });

  test("parses multiple files in the same order they appear in the content", () => {
    const fixture = [
      "SF:a/first.ts",
      "LF:10",
      "LH:5",
      "FNF:2",
      "FNH:1",
      "end_of_record",
      "SF:b/second.ts",
      "LF:20",
      "LH:20",
      "FNF:4",
      "FNH:4",
      "end_of_record",
      "SF:c/third.ts",
      "LF:0",
      "LH:0",
      "FNF:0",
      "FNH:0",
      "end_of_record",
    ].join("\n");

    const result = LcovParser.parse(fixture);

    expect(result).toEqual([
      { path: "a/first.ts", lf: 10, lh: 5, fnf: 2, fnh: 1 },
      { path: "b/second.ts", lf: 20, lh: 20, fnf: 4, fnh: 4 },
      { path: "c/third.ts", lf: 0, lh: 0, fnf: 0, fnh: 0 },
    ]);
  });

  test("returns an empty array for empty content", () => {
    expect(LcovParser.parse("")).toEqual([]);
  });

  test("ignores unrelated lcov prefixes (e.g. DA:, BRF:, BRH:) without disturbing current file stats", () => {
    const fixture = [
      "TN:",
      "SF:agent/src/example.ts",
      "FNF:3",
      "FNH:2",
      "DA:1,1",
      "DA:2,0",
      "BRF:0",
      "BRH:0",
      "LF:5",
      "LH:4",
      "end_of_record",
    ].join("\n");

    const result = LcovParser.parse(fixture);

    expect(result).toEqual([
      { path: "agent/src/example.ts", lf: 5, lh: 4, fnf: 3, fnh: 2 },
    ]);
  });

  test("matches the pre-refactor aggregate computation on a sample multi-file fixture", () => {
    // Same fixture shape as check-coverage.ts would read from coverage/lcov.info:
    // multiple SF: records, each followed by FNF:/FNH:/LF:/LH: lines.
    const fixture = [
      "SF:agent/src/foo.ts",
      "FNF:4",
      "FNH:4",
      "LF:40",
      "LH:38",
      "end_of_record",
      "SF:metrics/src/bar.ts",
      "FNF:6",
      "FNH:3",
      "LF:60",
      "LH:30",
      "end_of_record",
      "SF:node_modules/should-be-parsed-but-excluded-downstream/index.js",
      "FNF:1",
      "FNH:1",
      "LF:1",
      "LH:1",
      "end_of_record",
    ].join("\n");

    const result = LcovParser.parse(fixture);

    // Hand-computed expected values — replicates what the pre-refactor
    // inline SF:/LF:/LH:/FNF:/FNH: loop would have produced as
    // `files: Record<string, FileStats>` entries, now as an ordered array.
    const expected = [
      { path: "agent/src/foo.ts", lf: 40, lh: 38, fnf: 4, fnh: 4 },
      { path: "metrics/src/bar.ts", lf: 60, lh: 30, fnf: 6, fnh: 3 },
      {
        path: "node_modules/should-be-parsed-but-excluded-downstream/index.js",
        lf: 1,
        lh: 1,
        fnf: 1,
        fnh: 1,
      },
    ];

    expect(result).toEqual(expected);

    // Sanity-check the aggregate arithmetic matches what the summary report
    // would compute for the non-excluded files (foo.ts + bar.ts only —
    // exclusion filtering itself is check-coverage.ts's downstream concern,
    // not LcovParser's, but this documents the no-op contract end to end).
    const relevant = result.filter((f) => !f.path.startsWith("node_modules/"));
    const totalLf = relevant.reduce((sum, f) => sum + f.lf, 0);
    const totalLh = relevant.reduce((sum, f) => sum + f.lh, 0);
    const totalFnf = relevant.reduce((sum, f) => sum + f.fnf, 0);
    const totalFnh = relevant.reduce((sum, f) => sum + f.fnh, 0);

    expect(totalLf).toBe(100);
    expect(totalLh).toBe(68);
    expect(totalFnf).toBe(10);
    expect(totalFnh).toBe(7);
  });
});

describe("CoveragePyParser.parse", () => {
  test("parses a single-file JSON report into FileStats", () => {
    const fixture = JSON.stringify({
      meta: { format: 3, version: "7.4.0" },
      files: {
        "mypackage/module.py": {
          executed_lines: [1, 2, 3, 5, 6],
          summary: {
            covered_lines: 5,
            num_statements: 7,
            percent_covered: 71.42857142857143,
            percent_covered_display: "71",
            missing_lines: 2,
            excluded_lines: 0,
          },
          missing_lines: [4, 7],
          excluded_lines: [],
        },
      },
      totals: {
        covered_lines: 5,
        num_statements: 7,
        percent_covered: 71.42857142857143,
        percent_covered_display: "71",
        missing_lines: 2,
        excluded_lines: 0,
      },
    });

    const result = CoveragePyParser.parse(fixture);

    expect(result).toEqual([
      { path: "mypackage/module.py", lf: 7, lh: 5, fnf: 0, fnh: 0 },
    ]);
  });

  test("parses multiple files, preserving the order they appear in the files object", () => {
    const fixture = JSON.stringify({
      meta: { format: 3, version: "7.4.0" },
      files: {
        "a/first.py": {
          executed_lines: [1, 2],
          summary: { covered_lines: 2, num_statements: 4 },
          missing_lines: [3, 4],
          excluded_lines: [],
        },
        "b/second.py": {
          executed_lines: [1, 2, 3],
          summary: { covered_lines: 3, num_statements: 3 },
          missing_lines: [],
          excluded_lines: [],
        },
        "c/third.py": {
          executed_lines: [],
          summary: { covered_lines: 0, num_statements: 0 },
          missing_lines: [],
          excluded_lines: [],
        },
      },
      totals: { covered_lines: 5, num_statements: 7 },
    });

    const result = CoveragePyParser.parse(fixture);

    expect(result).toEqual([
      { path: "a/first.py", lf: 4, lh: 2, fnf: 0, fnh: 0 },
      { path: "b/second.py", lf: 3, lh: 3, fnf: 0, fnh: 0 },
      { path: "c/third.py", lf: 0, lh: 0, fnf: 0, fnh: 0 },
    ]);
  });

  test("returns an empty array for a report with an empty files object", () => {
    const fixture = JSON.stringify({
      meta: { format: 3, version: "7.4.0" },
      files: {},
      totals: { covered_lines: 0, num_statements: 0 },
    });

    expect(CoveragePyParser.parse(fixture)).toEqual([]);
  });

  test("returns an empty array for malformed/invalid JSON input without throwing", () => {
    expect(CoveragePyParser.parse("{not valid json")).toEqual([]);
    expect(CoveragePyParser.parse("")).toEqual([]);
  });

  test("returns an empty array if the parsed JSON has no files key", () => {
    const fixture = JSON.stringify({
      meta: { format: 3, version: "7.4.0" },
      totals: { covered_lines: 0, num_statements: 0 },
    });

    expect(CoveragePyParser.parse(fixture)).toEqual([]);
  });

  test("returns an empty array if files is not an object", () => {
    const fixture = JSON.stringify({
      meta: { format: 3, version: "7.4.0" },
      files: "not-an-object",
      totals: { covered_lines: 0, num_statements: 0 },
    });

    expect(CoveragePyParser.parse(fixture)).toEqual([]);

    const arrayFixture = JSON.stringify({
      meta: { format: 3, version: "7.4.0" },
      files: [],
      totals: { covered_lines: 0, num_statements: 0 },
    });

    expect(CoveragePyParser.parse(arrayFixture)).toEqual([]);
  });
});
