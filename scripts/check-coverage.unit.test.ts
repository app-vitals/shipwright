/**
 * Unit tests for scripts/check-coverage.ts
 *
 * Verifies LcovParser (the CoverageParser implementation for the lcov.info
 * format) against a hand-built fixture, plus the pure filtering/aggregation/
 * failure-computation logic extracted out of main() (MTC-1.7): the file
 * itself measures coverage but was, until this refactor, not meaningfully
 * covered by it. Nothing here touches the filesystem or triggers the
 * script's process.exit side effects — main()'s thin I/O/CLI wiring is
 * intentionally left uncovered, consistent with this repo's process-
 * entrypoint exclusion convention (see EXCLUDE_PREFIXES in check-coverage.ts).
 */
import { describe, expect, test } from "bun:test";
import type { FileStats } from "./check-coverage";
import {
  aggregateStats,
  computeFailures,
  filterRelevantFiles,
  LcovParser,
  percentOf,
} from "./check-coverage";

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

describe("filterRelevantFiles", () => {
  const files: FileStats[] = [
    { path: "node_modules/foo/index.js", lf: 10, lh: 10, fnf: 1, fnh: 1 },
    { path: "admin/src/main.ts", lf: 20, lh: 20, fnf: 2, fnh: 2 },
    {
      path: "admin/prisma/client/index.ts",
      lf: 30,
      lh: 30,
      fnf: 3,
      fnh: 3,
    },
    { path: "agent/src/check-patch.ts", lf: 40, lh: 20, fnf: 4, fnh: 2 },
  ];

  test("excludes files matching an exclude prefix", () => {
    const result = filterRelevantFiles(files, ["admin/src/main.ts"], []);
    expect(result.map((f) => f.path)).toEqual([
      "node_modules/foo/index.js",
      "admin/prisma/client/index.ts",
      "agent/src/check-patch.ts",
    ]);
  });

  test("excludes files matching an exclude substring regardless of prefix", () => {
    const result = filterRelevantFiles(files, [], ["prisma/client/"]);
    expect(result.map((f) => f.path)).toEqual([
      "node_modules/foo/index.js",
      "admin/src/main.ts",
      "agent/src/check-patch.ts",
    ]);
  });

  test("applies both prefix and substring exclusions together", () => {
    const result = filterRelevantFiles(
      files,
      ["node_modules/"],
      ["prisma/client/"],
    );
    expect(result.map((f) => f.path)).toEqual([
      "admin/src/main.ts",
      "agent/src/check-patch.ts",
    ]);
  });

  test("keeps files that match neither prefix nor substring exclusions", () => {
    const result = filterRelevantFiles(
      files,
      ["some/other/prefix.ts"],
      ["some-other-substring"],
    );
    expect(result).toEqual(files);
  });

  test("returns an empty array when every file is excluded", () => {
    const result = filterRelevantFiles(files, [""], []);
    expect(result).toEqual([]);
  });

  test("returns an empty array for empty input", () => {
    expect(filterRelevantFiles([], ["node_modules/"], [])).toEqual([]);
  });
});

describe("aggregateStats", () => {
  test("sums lf/lh/fnf/fnh across multiple files", () => {
    const files: FileStats[] = [
      { path: "a.ts", lf: 10, lh: 8, fnf: 2, fnh: 1 },
      { path: "b.ts", lf: 20, lh: 20, fnf: 4, fnh: 4 },
      { path: "c.ts", lf: 0, lh: 0, fnf: 0, fnh: 0 },
    ];

    expect(aggregateStats(files)).toEqual({
      totalLf: 30,
      totalLh: 28,
      totalFnf: 6,
      totalFnh: 5,
    });
  });

  test("returns all-zero totals for an empty array", () => {
    expect(aggregateStats([])).toEqual({
      totalLf: 0,
      totalLh: 0,
      totalFnf: 0,
      totalFnh: 0,
    });
  });

  test("sums a single file as-is", () => {
    const files: FileStats[] = [
      { path: "solo.ts", lf: 5, lh: 3, fnf: 1, fnh: 1 },
    ];
    expect(aggregateStats(files)).toEqual({
      totalLf: 5,
      totalLh: 3,
      totalFnf: 1,
      totalFnh: 1,
    });
  });
});

describe("percentOf", () => {
  test("computes a straightforward percentage", () => {
    expect(percentOf(45, 90)).toBe(50);
  });

  test("returns 100 by convention when found is 0 (nothing to have missed)", () => {
    expect(percentOf(0, 0)).toBe(100);
  });

  test("returns 100 when hit equals found", () => {
    expect(percentOf(10, 10)).toBe(100);
  });

  test("returns 0 when nothing was hit", () => {
    expect(percentOf(0, 10)).toBe(0);
  });
});

describe("computeFailures", () => {
  test("reports both lines and functions when both are below threshold", () => {
    const failures = computeFailures(88.77, 88.19, 90, 90);
    expect(failures).toEqual([
      "Lines 88.77% < 90%",
      "Functions 88.19% < 90%",
    ]);
  });

  test("reports only lines when only lines are below threshold", () => {
    const failures = computeFailures(85, 95, 90, 90);
    expect(failures).toEqual(["Lines 85.00% < 90%"]);
  });

  test("reports only functions when only functions are below threshold", () => {
    const failures = computeFailures(95, 85, 90, 90);
    expect(failures).toEqual(["Functions 85.00% < 90%"]);
  });

  test("returns an empty array when both are exactly at threshold", () => {
    expect(computeFailures(90, 90, 90, 90)).toEqual([]);
  });

  test("returns an empty array when both are above threshold", () => {
    expect(computeFailures(95, 99, 90, 90)).toEqual([]);
  });

  test("treats the lf === 0 / fnf === 0 100% convention as passing", () => {
    // percentOf(0, 0) yields 100, which should never trigger a failure.
    expect(computeFailures(100, 100, 90, 90)).toEqual([]);
  });
});
