/**
 * Unit tests for scripts/check-coverage.ts
 *
 * Verifies LcovParser (the CoverageParser implementation for the lcov.info
 * format), JacocoParser (the CoverageParser implementation for JaCoCo's XML
 * report format), IstanbulParser (the CoverageParser implementation for
 * c8/nyc's native Istanbul JSON format), CoveragePyParser (the CoverageParser
 * implementation for coverage.py's `coverage json` output), and GoCoverParser
 * (the CoverageParser implementation for go cover's text profile format)
 * against hand-built fixtures, plus the pure filtering/aggregation/failure-
 * computation logic extracted out of main() (MTC-1.7) and
 * computeAggregateLinePct's EXCLUDE-filtered weighted aggregation. Pure
 * logic, no I/O: parse(content) takes raw string content and returns
 * FileStats[] — nothing here touches the filesystem or triggers the
 * script's process.exit side effects.
 *
 * Also verifies runCli — the injectable-dependencies orchestrator (mirrors
 * check-coverage-no-decrease.ts's runCli) — via a fake readLcov (and, for the
 * MTC-1.6 dispatch wiring, a fake readCoverageToolDoc) instead of real file
 * reads, so no process.exit or filesystem I/O is involved. main()'s thin
 * I/O/CLI wiring beyond runCli is intentionally left uncovered, consistent
 * with this repo's process-entrypoint exclusion convention (see
 * EXCLUDE_PREFIXES in check-coverage.ts).
 *
 * extractCoverageTool and selectParser (the MTC-1.6 per-repo coverage-tool
 * dispatch) live in and are tested by coverage-tool-dispatch.ts /
 * coverage-tool-dispatch.unit.test.ts.
 */
import { describe, expect, test } from "bun:test";
import type { FileStats } from "./check-coverage";
import {
  CoveragePyParser,
  GoCoverParser,
  IstanbulParser,
  JacocoParser,
  LcovParser,
  aggregateStats,
  computeAggregateLinePct,
  computeFailures,
  filterRelevantFiles,
  percentOf,
  runCli,
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

describe("JacocoParser.parse", () => {
  test("parses a single class with LINE and METHOD counters into FileStats", () => {
    const fixture = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">
<report name="example">
  <package name="com/example/foo">
    <class name="com/example/foo/Bar" sourcefilename="Bar.java">
      <counter type="INSTRUCTION" missed="3" covered="20"/>
      <counter type="LINE" missed="1" covered="10"/>
      <counter type="METHOD" missed="0" covered="3"/>
      <counter type="CLASS" missed="0" covered="1"/>
    </class>
  </package>
</report>`;

    const result = JacocoParser.parse(fixture);

    expect(result).toEqual([
      { path: "com/example/foo/Bar", lf: 11, lh: 10, fnf: 3, fnh: 3 },
    ]);
  });

  test("parses multiple classes across multiple packages in document order", () => {
    const fixture = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">
<report name="example">
  <package name="com/example/foo">
    <class name="com/example/foo/Bar" sourcefilename="Bar.java">
      <counter type="LINE" missed="1" covered="10"/>
      <counter type="METHOD" missed="0" covered="3"/>
    </class>
    <class name="com/example/foo/Baz" sourcefilename="Baz.java">
      <counter type="LINE" missed="5" covered="5"/>
      <counter type="METHOD" missed="1" covered="1"/>
    </class>
  </package>
  <package name="com/example/qux">
    <class name="com/example/qux/Quux" sourcefilename="Quux.java">
      <counter type="LINE" missed="0" covered="2"/>
      <counter type="METHOD" missed="0" covered="1"/>
    </class>
  </package>
</report>`;

    const result = JacocoParser.parse(fixture);

    expect(result).toEqual([
      { path: "com/example/foo/Bar", lf: 11, lh: 10, fnf: 3, fnh: 3 },
      { path: "com/example/foo/Baz", lf: 10, lh: 5, fnf: 2, fnh: 1 },
      { path: "com/example/qux/Quux", lf: 2, lh: 2, fnf: 1, fnh: 1 },
    ]);
  });

  test("does not double-count nested <method> counters into class-level totals", () => {
    const fixture = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">
<report name="example">
  <package name="com/example/foo">
    <class name="com/example/foo/Bar" sourcefilename="Bar.java">
      <method name="doThing" desc="()V" line="10">
        <counter type="INSTRUCTION" missed="0" covered="5"/>
        <counter type="LINE" missed="0" covered="2"/>
        <counter type="METHOD" missed="0" covered="1"/>
      </method>
      <method name="doOtherThing" desc="()V" line="20">
        <counter type="INSTRUCTION" missed="1" covered="4"/>
        <counter type="LINE" missed="1" covered="8"/>
        <counter type="METHOD" missed="1" covered="0"/>
      </method>
      <counter type="INSTRUCTION" missed="3" covered="20"/>
      <counter type="LINE" missed="1" covered="10"/>
      <counter type="METHOD" missed="0" covered="3"/>
      <counter type="CLASS" missed="0" covered="1"/>
    </class>
  </package>
</report>`;

    const result = JacocoParser.parse(fixture);

    // If nested <method> LINE/METHOD counters were summed in, lf would be
    // 1+2+1+8=12 additional and fnf/fnh would be off too. Expect only the
    // class's own direct counters (missed=1 covered=10 / missed=0 covered=3).
    expect(result).toEqual([
      { path: "com/example/foo/Bar", lf: 11, lh: 10, fnf: 3, fnh: 3 },
    ]);
  });

  test("ignores report- and package-level counters, attributing nothing to any class", () => {
    const fixture = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">
<report name="example">
  <package name="com/example/foo">
    <class name="com/example/foo/Bar" sourcefilename="Bar.java">
      <counter type="LINE" missed="1" covered="10"/>
      <counter type="METHOD" missed="0" covered="3"/>
    </class>
    <sourcefile name="Bar.java">
      <counter type="LINE" missed="1" covered="10"/>
    </sourcefile>
    <counter type="LINE" missed="1" covered="10"/>
    <counter type="METHOD" missed="0" covered="3"/>
  </package>
  <counter type="LINE" missed="1" covered="10"/>
  <counter type="METHOD" missed="0" covered="3"/>
</report>`;

    const result = JacocoParser.parse(fixture);

    expect(result).toEqual([
      { path: "com/example/foo/Bar", lf: 11, lh: 10, fnf: 3, fnh: 3 },
    ]);
  });

  test("defaults to 0 when a class is missing LINE or METHOD counters", () => {
    const fixture = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">
<report name="example">
  <package name="com/example/foo">
    <class name="com/example/foo/EmptyInterface" sourcefilename="EmptyInterface.java">
      <counter type="INSTRUCTION" missed="0" covered="0"/>
      <counter type="CLASS" missed="0" covered="1"/>
    </class>
  </package>
</report>`;

    const result = JacocoParser.parse(fixture);

    expect(result).toEqual([
      {
        path: "com/example/foo/EmptyInterface",
        lf: 0,
        lh: 0,
        fnf: 0,
        fnh: 0,
      },
    ]);
  });

  test("returns an empty array for empty content", () => {
    expect(JacocoParser.parse("")).toEqual([]);
  });

  test("returns an empty array when there are no <class> elements", () => {
    const fixture = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">
<report name="example">
  <package name="com/example/foo">
    <counter type="LINE" missed="0" covered="0"/>
  </package>
</report>`;

    expect(JacocoParser.parse(fixture)).toEqual([]);
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
    expect(failures).toEqual(["Lines 88.77% < 90%", "Functions 88.19% < 90%"]);
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

describe("computeAggregateLinePct", () => {
  test("computes the weighted aggregate line percentage across relevant files", () => {
    const files = [
      { path: "agent/src/foo.ts", lf: 40, lh: 38, fnf: 4, fnh: 4 },
      { path: "metrics/src/bar.ts", lf: 60, lh: 30, fnf: 6, fnh: 3 },
    ];

    // (38 + 30) / (40 + 60) * 100 = 68
    expect(computeAggregateLinePct(files)).toBe(68);
  });

  test("excludes files matching EXCLUDE_PREFIXES from the aggregate", () => {
    const files = [
      { path: "agent/src/foo.ts", lf: 40, lh: 40, fnf: 4, fnh: 4 },
      {
        path: "node_modules/some-dep/index.js",
        lf: 1000,
        lh: 0,
        fnf: 100,
        fnh: 0,
      },
    ];

    // node_modules/ is excluded, so only foo.ts counts: 40/40 = 100
    expect(computeAggregateLinePct(files)).toBe(100);
  });

  test("excludes files matching EXCLUDE_SUBSTRINGS from the aggregate", () => {
    const files = [
      { path: "agent/src/foo.ts", lf: 10, lh: 5, fnf: 1, fnh: 1 },
      {
        path: "task-store/prisma/client/index.js",
        lf: 500,
        lh: 500,
        fnf: 50,
        fnh: 50,
      },
    ];

    // prisma/client/ is excluded, so only foo.ts counts: 5/10 = 50
    expect(computeAggregateLinePct(files)).toBe(50);
  });

  test("returns 100 when there are no relevant files (no lines found, not a failure)", () => {
    expect(computeAggregateLinePct([])).toBe(100);
  });

  test("returns 100 when total lines-found across relevant files is zero", () => {
    const files = [
      { path: "agent/src/empty.ts", lf: 0, lh: 0, fnf: 0, fnh: 0 },
    ];
    expect(computeAggregateLinePct(files)).toBe(100);
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

function makeLogSpy() {
  const messages: string[] = [];
  return { fn: (msg: string) => messages.push(msg), messages };
}

// lf=10/lh=9 => 90% lines (>= 80% threshold), fnf=2/fnh=2 => 100% functions.
const PASSING_LCOV = [
  "SF:agent/src/example.ts",
  "FNF:2",
  "FNH:2",
  "LF:10",
  "LH:9",
  "end_of_record",
].join("\n");

// lf=10/lh=5 => 50% lines (< 80% threshold) — fails the gate on lines alone.
const FAILING_LCOV = [
  "SF:agent/src/example.ts",
  "FNF:2",
  "FNH:2",
  "LF:10",
  "LH:5",
  "end_of_record",
].join("\n");

describe("runCli", () => {
  test("returns 1 and logs an error when the lcov file can't be read", async () => {
    const { fn: error, messages } = makeLogSpy();
    const exitCode = await runCli({
      readLcov: () => Promise.reject(new Error("ENOENT")),
      log: () => {},
      error,
    });
    expect(exitCode).toBe(1);
    expect(messages.some((m) => m.includes("No coverage file at"))).toBe(true);
  });

  test("returns 0 and logs 'no source files' when every file is excluded", async () => {
    const { fn: log, messages } = makeLogSpy();
    const excludedOnlyLcov = [
      "SF:node_modules/foo/index.js",
      "FNF:1",
      "FNH:1",
      "LF:1",
      "LH:1",
      "end_of_record",
    ].join("\n");
    const exitCode = await runCli({
      readLcov: () => Promise.resolve(excludedOnlyLcov),
      log,
    });
    expect(exitCode).toBe(0);
    expect(
      messages.some((m) => m.includes("No source files in coverage report")),
    ).toBe(true);
  });

  test("returns 0 and logs success when lines and functions both meet threshold", async () => {
    const { fn: log, messages } = makeLogSpy();
    const exitCode = await runCli({
      readLcov: () => Promise.resolve(PASSING_LCOV),
      log,
    });
    expect(exitCode).toBe(0);
    expect(messages.some((m) => m.includes("✅ Coverage gate passed"))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes("Lines:"))).toBe(true);
    expect(messages.some((m) => m.includes("Functions:"))).toBe(true);
  });

  test("returns 1 and logs the failure reason when line coverage is below threshold", async () => {
    const { fn: error, messages: errMessages } = makeLogSpy();
    const exitCode = await runCli({
      readLcov: () => Promise.resolve(FAILING_LCOV),
      log: () => {},
      error,
    });
    expect(exitCode).toBe(1);
    expect(errMessages.some((m) => m.includes("❌ Coverage gate failed"))).toBe(
      true,
    );
    expect(errMessages.some((m) => m.includes("Lines"))).toBe(true);
  });

  test("returns 1 and reports both lines and functions when both are below threshold", async () => {
    const { fn: error, messages: errMessages } = makeLogSpy();
    const bothFailingLcov = [
      "SF:agent/src/example.ts",
      "FNF:10",
      "FNH:1",
      "LF:10",
      "LH:1",
      "end_of_record",
    ].join("\n");
    const exitCode = await runCli({
      readLcov: () => Promise.resolve(bothFailingLcov),
      log: () => {},
      error,
    });
    expect(exitCode).toBe(1);
    const failureLine = errMessages.find((m) =>
      m.includes("❌ Coverage gate failed"),
    );
    expect(failureLine).toBeDefined();
    expect(failureLine).toContain("Lines");
    expect(failureLine).toContain("Functions");
  });

  test("uses LcovParser (default behavior) when readCoverageToolDoc is not provided", async () => {
    const { fn: log, messages } = makeLogSpy();
    const exitCode = await runCli({
      readLcov: () => Promise.resolve(PASSING_LCOV),
      log,
    });
    expect(exitCode).toBe(0);
    expect(messages.some((m) => m.includes("✅ Coverage gate passed"))).toBe(
      true,
    );
  });

  test("uses LcovParser when readCoverageToolDoc resolves to content with no tool field", async () => {
    const { fn: log, messages } = makeLogSpy();
    const exitCode = await runCli({
      readLcov: () => Promise.resolve(PASSING_LCOV),
      readCoverageToolDoc: () =>
        Promise.resolve("- **Some other field:** `not-a-tool-field`"),
      log,
    });
    expect(exitCode).toBe(0);
    expect(messages.some((m) => m.includes("✅ Coverage gate passed"))).toBe(
      true,
    );
  });

  test("uses LcovParser when readCoverageToolDoc throws (e.g. missing doc file)", async () => {
    const { fn: log, messages } = makeLogSpy();
    const exitCode = await runCli({
      readLcov: () => Promise.resolve(PASSING_LCOV),
      readCoverageToolDoc: () => Promise.reject(new Error("ENOENT")),
      log,
    });
    expect(exitCode).toBe(0);
    expect(messages.some((m) => m.includes("✅ Coverage gate passed"))).toBe(
      true,
    );
  });

  test("still fails the gate correctly using LcovParser when readCoverageToolDoc records lcov explicitly", async () => {
    const { fn: error, messages: errMessages } = makeLogSpy();
    const exitCode = await runCli({
      readLcov: () => Promise.resolve(FAILING_LCOV),
      readCoverageToolDoc: () =>
        Promise.resolve(
          "- **Coverage toolchain:** `lcov` (Bun's native coverage reporter)",
        ),
      log: () => {},
      error,
    });
    expect(exitCode).toBe(1);
    expect(errMessages.some((m) => m.includes("❌ Coverage gate failed"))).toBe(
      true,
    );
  });

  test.each([
    ["jacoco", "- **Coverage toolchain:** `jacoco`"],
    ["coverage.py", "- **Coverage toolchain:** `coverage.py`"],
    ["c8", "- **Coverage toolchain:** `c8`"],
    ["nyc", "- **Coverage toolchain:** `nyc`"],
    ["c8-nyc", "- **Coverage toolchain:** `c8-nyc`"],
    ["go-cover", "- **Coverage toolchain:** `go-cover`"],
  ])(
    "fails loudly instead of silently passing when a %s tool is recorded (no report-path dispatch yet)",
    async (tool, toolDoc) => {
      const { fn: error, messages: errMessages } = makeLogSpy();
      const { fn: log, messages: logMessages } = makeLogSpy();
      const exitCode = await runCli({
        // lcov content — the report file check-coverage.ts always reads,
        // regardless of the recorded tool — fed to a mismatched parser.
        readLcov: () => Promise.resolve(PASSING_LCOV),
        readCoverageToolDoc: () => Promise.resolve(toolDoc),
        log,
        error,
      });
      expect(exitCode).toBe(1);
      expect(
        errMessages.some(
          (m) => m.includes(tool) && m.includes("no report-path dispatch"),
        ),
      ).toBe(true);
      expect(
        logMessages.some((m) => m.includes("No source files")),
      ).toBe(false);
      expect(
        logMessages.some((m) => m.includes("Coverage gate passed")),
      ).toBe(false);
    },
  );
});
