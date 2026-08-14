/**
 * Unit tests for scripts/check-coverage.ts
 *
 * Verifies LcovParser (the CoverageParser implementation for the lcov.info
 * format) against a hand-built fixture. Pure logic, no I/O: parse(content)
 * takes a raw lcov string and returns FileStats[] — nothing here touches
 * the filesystem or triggers the script's process.exit side effects.
 */
import { describe, expect, test } from "bun:test";
import { LcovParser } from "./check-coverage";

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
