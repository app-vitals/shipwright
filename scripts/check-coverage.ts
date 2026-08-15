#!/usr/bin/env bun
// Parse coverage/lcov.info and fail if aggregate coverage is below threshold.
// Gate applies to the weighted aggregate (sum of LH/LF and FNH/FNF across all
// counted files) — not a per-file check. Bun's native bunfig.toml
// coverageThreshold enforces a PER-FILE minimum instead, which would fail CI
// on individual low-coverage files regardless of overall coverage — hence
// this separate aggregate gate.

const THRESHOLD_LINES = 90;
const THRESHOLD_FUNCTIONS = 90;

const EXCLUDE_PREFIXES = [
  // Generated / vendor code
  "node_modules/",

  // Process entrypoints — start a real service or require live
  // credentials/infra to run (DB connections, Docker, mise, GitHub auth,
  // etc.); exercised in practice, not under unit/integration test.
  "admin/src/server.ts",
  "admin/src/main.ts",
  "agent/src/entrypoint-main.ts",
  "task-store/src/main.ts",
  "chat/src/main.ts",
  "mcp-server/src/serve.ts",
  "metrics/src/server.ts",

  // Local-dev-only seed scripts — invoked only by `task stack` against a
  // live database; pure logic they contain is unit-tested and exported,
  // only the import.meta.main CLI/DB-wiring block is uncovered here.
  "scripts/seed-task-store-token.ts",
  "scripts/seed-chat-tokens.ts",
  "scripts/seed-dev-agent.ts",
  "scripts/wait-for-agent.ts",

  // Browser-loaded dashboard client — a plain (non-module) <script>, mostly
  // DOM manipulation and chart rendering with no in-process request seam to
  // unit test. Its pure, injectable-fetch logic (fetchSequential) is
  // unit-tested via a guarded test-only export (see app.unit.test.js); that
  // export requires importing the whole file, which would otherwise drag
  // ~1000 lines of untestable DOM code into the aggregate gate.
  "metrics/src/dashboard/app.js",
];

// Paths containing this substring are excluded regardless of prefix
const EXCLUDE_SUBSTRINGS = ["prisma/client/"];
const LCOV_PATH = "coverage/lcov.info";

export type FileStats = {
  path: string;
  lf: number;
  lh: number;
  fnf: number;
  fnh: number;
};

export interface CoverageParser {
  parse(content: string): FileStats[];
}

// Parses LCOV-format content (SF:/LF:/LH:/FNF:/FNH: records) into an
// ordered FileStats[] — one entry per SF: block, in the order each first
// appears in the content (mirrors the insertion order of the original
// `files: Record<string, FileStats>` map this was extracted from).
export const LcovParser: CoverageParser = {
  parse(content: string): FileStats[] {
    const files: FileStats[] = [];
    let current: FileStats | undefined;

    for (const line of content.split("\n")) {
      if (line.startsWith("SF:")) {
        current = { path: line.slice(3), lf: 0, lh: 0, fnf: 0, fnh: 0 };
        files.push(current);
      } else if (line.startsWith("LF:")) {
        if (current) current.lf = Number.parseInt(line.slice(3), 10);
      } else if (line.startsWith("LH:")) {
        if (current) current.lh = Number.parseInt(line.slice(3), 10);
      } else if (line.startsWith("FNF:")) {
        if (current) current.fnf = Number.parseInt(line.slice(4), 10);
      } else if (line.startsWith("FNH:")) {
        if (current) current.fnh = Number.parseInt(line.slice(4), 10);
      }
    }

    return files;
  },
};

// Filters out files that match an exclude prefix or substring, preserving
// the input order. Mirrors the EXCLUDE_PREFIXES ("process entrypoints")
// and EXCLUDE_SUBSTRINGS (e.g. generated Prisma client code) exclusion
// rules documented above those constants.
export function filterRelevantFiles(
  files: FileStats[],
  excludePrefixes: string[],
  excludeSubstrings: string[],
): FileStats[] {
  return files.filter(
    (file) =>
      !excludePrefixes.some((ex) => file.path.startsWith(ex)) &&
      !excludeSubstrings.some((sub) => file.path.includes(sub)),
  );
}

export type AggregateStats = {
  totalLf: number;
  totalLh: number;
  totalFnf: number;
  totalFnh: number;
};

// Sums LF/LH/FNF/FNH across every file into aggregate totals.
export function aggregateStats(files: FileStats[]): AggregateStats {
  let totalLf = 0;
  let totalLh = 0;
  let totalFnf = 0;
  let totalFnh = 0;

  for (const { lf, lh, fnf, fnh } of files) {
    totalLf += lf;
    totalLh += lh;
    totalFnf += fnf;
    totalFnh += fnh;
  }

  return { totalLf, totalLh, totalFnf, totalFnh };
}

// A file (or the aggregate) with zero countable lines/functions is treated
// as 100% by convention — there's nothing to have missed.
export function percentOf(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

// Builds the list of human-readable gate failure messages for the overall
// line/function percentages against their thresholds. Returns an empty
// array when both are at or above threshold (gate passes).
export function computeFailures(
  overallLines: number,
  overallFunctions: number,
  thresholdLines: number,
  thresholdFunctions: number,
): string[] {
  const failures: string[] = [];
  if (overallLines < thresholdLines)
    failures.push(`Lines ${overallLines.toFixed(2)}% < ${thresholdLines}%`);
  if (overallFunctions < thresholdFunctions)
    failures.push(
      `Functions ${overallFunctions.toFixed(2)}% < ${thresholdFunctions}%`,
    );
  return failures;
}

// Raw Istanbul coverage shapes (c8/nyc's native `coverage-final.json`), pared
// down to the fields FileStats derivation needs. branchMap/b are present in
// real output but irrelevant here.
type IstanbulStatement = { start: { line: number } };
type IstanbulFileCoverage = {
  path: string;
  statementMap: Record<string, IstanbulStatement>;
  fnMap: Record<string, unknown>;
  s: Record<string, number>;
  f: Record<string, number>;
};

// Derives line coverage the same way istanbul-lib-coverage does: Istanbul
// tracks coverage per *statement*, not per line, so a single line with
// multiple statements (e.g. a chained expression split across `;`s on one
// line) must be deduplicated onto its starting line number rather than
// counted per statement. A line counts as "found" once if any statement
// starts on it, and as "hit" if at least one statement starting on that
// line has a hit count > 0.
function deriveLineCoverage(
  statementMap: Record<string, IstanbulStatement>,
  hits: Record<string, number>,
): { lf: number; lh: number } {
  const maxHitsByLine = new Map<number, number>();

  for (const [id, statement] of Object.entries(statementMap)) {
    const line = statement.start.line;
    const hit = hits[id] ?? 0;
    const current = maxHitsByLine.get(line) ?? 0;
    maxHitsByLine.set(line, Math.max(current, hit));
  }

  let lh = 0;
  for (const maxHit of maxHitsByLine.values()) {
    if (maxHit > 0) lh++;
  }

  return { lf: maxHitsByLine.size, lh };
}

// Parses c8/nyc's native Istanbul JSON format (e.g. `c8 --reporter=json` or
// `nyc report --reporter=json`, a.k.a. `coverage-final.json`): a JSON object
// keyed by absolute file path, each value carrying statementMap/s (statement
// hit counts) and fnMap/f (function hit counts). Line coverage is NOT a raw
// statement count — see deriveLineCoverage above.
export const IstanbulParser: CoverageParser = {
  parse(content: string): FileStats[] {
    if (!content.trim()) return [];

    let raw: Record<string, IstanbulFileCoverage>;
    try {
      raw = JSON.parse(content);
    } catch {
      return [];
    }

    const files: FileStats[] = [];

    for (const [, file] of Object.entries(raw)) {
      const { lf, lh } = deriveLineCoverage(file.statementMap, file.s);
      const fnf = Object.keys(file.fnMap).length;
      const fnh = Object.values(file.f).filter((hit) => hit > 0).length;

      files.push({ path: file.path, lf, lh, fnf, fnh });
    }

    return files;
  },
};

// Shape of a single entry in coverage.py's `coverage json` `files` map —
// only the fields this parser reads.
type CoveragePyFileEntry = {
  summary?: {
    num_statements?: unknown;
    covered_lines?: unknown;
  };
};

// Parses coverage.py's `coverage json` report format into an ordered
// FileStats[] — one entry per key in the top-level `files` object, in the
// order those keys appear in the parsed JSON (Object.entries() preserves
// string-key insertion order, matching the file's original ordering).
//   - `lf`/`lh` map to each file's `summary.num_statements` /
//     `summary.covered_lines` — the closest analog to "lines found/hit"
//     this format supports.
//   - `fnf`/`fnh` are always 0: coverage.py's JSON report carries no
//     function-level granularity in its default/summary form.
// The whole document is parsed as JSON up front, so unlike the line-oriented
// parsers above, defensive handling happens at the whole-input level: any
// JSON.parse failure, or a missing/non-object `files` key, yields [].
export const CoveragePyParser: CoverageParser = {
  parse(content: string): FileStats[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return [];
    }

    if (typeof parsed !== "object" || parsed === null) return [];

    const files = (parsed as { files?: unknown }).files;
    if (typeof files !== "object" || files === null || Array.isArray(files))
      return [];

    return Object.entries(files as Record<string, CoveragePyFileEntry>).map(
      ([path, fileData]) => {
        const summary = fileData?.summary ?? {};
        const lf = Number(summary.num_statements) || 0;
        const lh = Number(summary.covered_lines) || 0;
        return { path, lf, lh, fnf: 0, fnh: 0 };
      },
    );
  },
};

// Matches a single go cover text-profile data line:
//   <file>:<startLine>.<startCol>,<endLine>.<endCol> <numStmt> <count>
// e.g. "github.com/example/repo/pkg/foo.go:10.13,12.2 1 1"
// Columns and numStmt aren't needed for line-level FileStats; only the file
// path, the line range, and the hit count matter here.
const GO_COVER_LINE_RE = /^(.+):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/;

// Parses go cover's text profile format (`go test -coverprofile=cover.out`):
// a `mode: <set|count|atomic>` header line followed by one block-coverage
// record per line. Unlike LCOV/Istanbul, go cover reports coverage per
// *block* (a span of lines), not per line or per statement — there is no
// per-line hit count in the source format. Line coverage is derived by
// expanding each block's [startLine, endLine] span across a per-file
// Map<lineNumber, maxHitCount>, mirroring how IstanbulParser's
// deriveLineCoverage dedupes multiple statements landing on the same line:
// a line is "found" if any block touches it, and "hit" if the max hit count
// of any block touching it is > 0. Go's blocks don't normally overlap, but
// taking the max is defensive in case they ever do.
// go cover's text profile carries no function-level granularity, so fnf/fnh
// are always 0 (same limitation as CoveragePyParser's statement-only format).
export const GoCoverParser: CoverageParser = {
  parse(content: string): FileStats[] {
    const lineHitsByFile = new Map<string, Map<number, number>>();

    for (const line of content.split("\n")) {
      if (!line.trim() || line.startsWith("mode:")) continue;

      const match = line.match(GO_COVER_LINE_RE);
      if (!match) continue;

      const [, path, startLineStr, endLineStr, countStr] = match;
      const startLine = Number.parseInt(startLineStr, 10);
      const endLine = Number.parseInt(endLineStr, 10);
      const count = Number.parseInt(countStr, 10);

      let lineHits = lineHitsByFile.get(path);
      if (!lineHits) {
        lineHits = new Map<number, number>();
        lineHitsByFile.set(path, lineHits);
      }

      for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
        const current = lineHits.get(lineNum) ?? 0;
        lineHits.set(lineNum, Math.max(current, count));
      }
    }

    const files: FileStats[] = [];
    for (const [path, lineHits] of lineHitsByFile.entries()) {
      let lh = 0;
      for (const hit of lineHits.values()) {
        if (hit > 0) lh++;
      }
      files.push({ path, lf: lineHits.size, lh, fnf: 0, fnh: 0 });
    }

    return files;
  },
};

async function main() {
  const lcov = await Bun.file(LCOV_PATH)
    .text()
    .catch(() => {
      console.error(
        `No coverage file at ${LCOV_PATH}. Run: bun test --coverage --coverage-reporter=lcov`,
      );
      process.exit(1);
    });

  const files = LcovParser.parse(lcov);

  const relevant = filterRelevantFiles(
    files,
    EXCLUDE_PREFIXES,
    EXCLUDE_SUBSTRINGS,
  );

  if (relevant.length === 0) {
    console.log("No source files in coverage report.");
    process.exit(0);
  }

  for (const { path, lf, lh } of relevant) {
    const linePct = percentOf(lh, lf);
    const icon = linePct >= THRESHOLD_LINES ? "✅" : "⚠️";
    console.log(`${icon}  ${linePct.toFixed(1).padStart(5)}%  ${path}`);
  }

  const { totalLf, totalLh, totalFnf, totalFnh } = aggregateStats(relevant);
  const overallLines = percentOf(totalLh, totalLf);
  const overallFunctions = percentOf(totalFnh, totalFnf);

  console.log(`
Lines:     ${overallLines.toFixed(2)}% (${totalLh}/${totalLf}) — threshold: ${THRESHOLD_LINES}%
Functions: ${overallFunctions.toFixed(2)}% (${totalFnh}/${totalFnf}) — threshold: ${THRESHOLD_FUNCTIONS}%`);

  const failures = computeFailures(
    overallLines,
    overallFunctions,
    THRESHOLD_LINES,
    THRESHOLD_FUNCTIONS,
  );

  if (failures.length > 0) {
    console.error(`\n❌ Coverage gate failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("✅ Coverage gate passed");
}

if (import.meta.main) {
  await main();
}
