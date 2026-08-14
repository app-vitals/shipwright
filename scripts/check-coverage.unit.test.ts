/**
 * Unit tests for scripts/check-coverage.ts
 *
 * Verifies LcovParser (the CoverageParser implementation for the lcov.info
 * format) and IstanbulParser (the CoverageParser implementation for c8/nyc's
 * native Istanbul JSON format) against hand-built fixtures. Pure logic, no
 * I/O: parse(content) takes a raw string and returns FileStats[] — nothing
 * here touches the filesystem or triggers the script's process.exit side
 * effects.
 */
import { describe, expect, test } from "bun:test";
import { GoCoverParser, IstanbulParser, LcovParser } from "./check-coverage";

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

describe("IstanbulParser.parse", () => {
  test("derives line coverage from statement starting lines, not a raw statement count", () => {
    // Two statements on line 1 (one hit, one not — line still counts as
    // covered because at least one statement on it was hit), one statement
    // on line 3 (not hit). Distinct starting lines = 2 (line 1, line 3), so
    // lf must be 2, not 3 (the raw statementMap count).
    const fixture = {
      "/abs/path/to/file.js": {
        path: "/abs/path/to/file.js",
        statementMap: {
          "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
          "1": { start: { line: 1, column: 12 }, end: { line: 1, column: 20 } },
          "2": { start: { line: 3, column: 2 }, end: { line: 3, column: 30 } },
        },
        fnMap: {
          "0": { name: "foo" },
        },
        s: { "0": 5, "1": 0, "2": 0 },
        f: { "0": 3 },
        branchMap: {},
        b: {},
      },
    };

    const result = IstanbulParser.parse(JSON.stringify(fixture));

    expect(result).toEqual([
      { path: "/abs/path/to/file.js", lf: 2, lh: 1, fnf: 1, fnh: 1 },
    ]);
  });

  test("counts function coverage from fnMap size and hit count in f", () => {
    const fixture = {
      "/abs/path/to/multi-fn.js": {
        path: "/abs/path/to/multi-fn.js",
        statementMap: {
          "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        },
        fnMap: {
          "0": { name: "hitFn" },
          "1": { name: "missedFn" },
        },
        s: { "0": 1 },
        f: { "0": 4, "1": 0 },
        branchMap: {},
        b: {},
      },
    };

    const result = IstanbulParser.parse(JSON.stringify(fixture));

    expect(result).toEqual([
      { path: "/abs/path/to/multi-fn.js", lf: 1, lh: 1, fnf: 2, fnh: 1 },
    ]);
  });

  test("parses multiple files, preserving Object.entries key order", () => {
    const fixture = {
      "/abs/path/to/first.js": {
        path: "/abs/path/to/first.js",
        statementMap: {
          "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
          "1": { start: { line: 2, column: 0 }, end: { line: 2, column: 5 } },
        },
        fnMap: {},
        s: { "0": 1, "1": 1 },
        f: {},
        branchMap: {},
        b: {},
      },
      "/abs/path/to/second.js": {
        path: "/abs/path/to/second.js",
        statementMap: {
          "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
        },
        fnMap: {
          "0": { name: "bar" },
        },
        s: { "0": 0 },
        f: { "0": 0 },
        branchMap: {},
        b: {},
      },
    };

    const result = IstanbulParser.parse(JSON.stringify(fixture));

    expect(result).toEqual([
      { path: "/abs/path/to/first.js", lf: 2, lh: 2, fnf: 0, fnh: 0 },
      { path: "/abs/path/to/second.js", lf: 1, lh: 0, fnf: 1, fnh: 0 },
    ]);
  });

  test("returns an empty array for empty content", () => {
    expect(IstanbulParser.parse("")).toEqual([]);
  });

  test("returns an empty array for an empty JSON object", () => {
    expect(IstanbulParser.parse("{}")).toEqual([]);
  });
});

describe("GoCoverParser.parse", () => {
  test("parses a single file, single block, fully covered", () => {
    const fixture = [
      "mode: set",
      "github.com/example/repo/pkg/foo.go:10.13,12.2 1 1",
    ].join("\n");

    const result = GoCoverParser.parse(fixture);

    expect(result).toEqual([
      {
        path: "github.com/example/repo/pkg/foo.go",
        lf: 3,
        lh: 3,
        fnf: 0,
        fnh: 0,
      },
    ]);
  });

  test("parses a single file, single block, uncovered", () => {
    const fixture = [
      "mode: set",
      "github.com/example/repo/pkg/foo.go:14.2,14.20 1 0",
    ].join("\n");

    const result = GoCoverParser.parse(fixture);

    expect(result).toEqual([
      {
        path: "github.com/example/repo/pkg/foo.go",
        lf: 1,
        lh: 0,
        fnf: 0,
        fnh: 0,
      },
    ]);
  });

  test("a block spanning multiple physical lines counts every line in range", () => {
    const fixture = [
      "mode: set",
      "github.com/example/repo/pkg/bar.go:5.10,7.2 2 3",
    ].join("\n");

    const result = GoCoverParser.parse(fixture);

    // lines 5, 6, 7 => lf 3; count 3 > 0 => all hit => lh 3
    expect(result).toEqual([
      {
        path: "github.com/example/repo/pkg/bar.go",
        lf: 3,
        lh: 3,
        fnf: 0,
        fnh: 0,
      },
    ]);
  });

  test("a multi-line uncovered block counts every line as found but none hit", () => {
    const fixture = [
      "mode: set",
      "github.com/example/repo/pkg/baz.go:20.1,23.2 3 0",
    ].join("\n");

    const result = GoCoverParser.parse(fixture);

    // lines 20, 21, 22, 23 => lf 4; count 0 => lh 0
    expect(result).toEqual([
      {
        path: "github.com/example/repo/pkg/baz.go",
        lf: 4,
        lh: 0,
        fnf: 0,
        fnh: 0,
      },
    ]);
  });

  test("parses multiple files in first-appearance order", () => {
    const fixture = [
      "mode: set",
      "github.com/example/repo/pkg/foo.go:10.13,12.2 1 1",
      "github.com/example/repo/pkg/foo.go:14.2,14.20 1 0",
      "github.com/example/repo/pkg/bar.go:5.10,7.2 2 3",
    ].join("\n");

    const result = GoCoverParser.parse(fixture);

    expect(result).toEqual([
      {
        path: "github.com/example/repo/pkg/foo.go",
        // block1: lines 10,11,12 hit; block2: line 14 not hit => lf 4, lh 3
        lf: 4,
        lh: 3,
        fnf: 0,
        fnh: 0,
      },
      {
        path: "github.com/example/repo/pkg/bar.go",
        lf: 3,
        lh: 3,
        fnf: 0,
        fnh: 0,
      },
    ]);
  });

  test("mode: count / mode: atomic header lines are skipped, not treated as data or errors", () => {
    const countFixture = [
      "mode: count",
      "github.com/example/repo/pkg/foo.go:1.1,1.10 1 5",
    ].join("\n");
    const atomicFixture = [
      "mode: atomic",
      "github.com/example/repo/pkg/foo.go:1.1,1.10 1 5",
    ].join("\n");

    expect(GoCoverParser.parse(countFixture)).toEqual([
      {
        path: "github.com/example/repo/pkg/foo.go",
        lf: 1,
        lh: 1,
        fnf: 0,
        fnh: 0,
      },
    ]);
    expect(GoCoverParser.parse(atomicFixture)).toEqual([
      {
        path: "github.com/example/repo/pkg/foo.go",
        lf: 1,
        lh: 1,
        fnf: 0,
        fnh: 0,
      },
    ]);
  });

  test("returns an empty array for empty content", () => {
    expect(GoCoverParser.parse("")).toEqual([]);
  });

  test("returns an empty array for a profile with only the mode line", () => {
    expect(GoCoverParser.parse("mode: set")).toEqual([]);
    expect(GoCoverParser.parse("mode: set\n")).toEqual([]);
  });
});
