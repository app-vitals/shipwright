#!/usr/bin/env bun
// Parse coverage/lcov.info and fail if aggregate coverage is below threshold.
// Gate applies to the weighted aggregate (sum of LH/LF and FNH/FNF across all
// counted files) — not a per-file check. Bun's native bunfig.toml
// coverageThreshold enforces a PER-FILE minimum instead, which would fail CI
// on individual low-coverage files regardless of overall coverage — hence
// this separate aggregate gate.

import { extractCoverageTool, selectParser } from "./coverage-tool-dispatch";

// Live CI aggregate at the time of the last raise attempt (MTC-1.7, 2026-08-14)
// was Lines 89.77% / Functions 89.72% — just short of 90/90. Rather than merge
// a gate the repo doesn't clear (which would break `task ci` for every
// subsequent PR), the floor was landed at 89/89: a real raise from the prior
// 80/80 floor, with margin over the measured baseline. See PR #2659 for the
// full 90/90 attempt and follow-up discussion on closing the remaining gap.
const THRESHOLD_LINES = 89;
const THRESHOLD_FUNCTIONS = 89;

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

  // hitl.ts's real (production) global-patching target for its log-file
  // tee (installLogFileTee()) — every line here does nothing but read or
  // reassign real process.stdout.write/process.stderr.write/console.log/
  // warn/error, which can't be exercised safely in-process (this repo's
  // isolation contract forbids patching real process/console state in the
  // shared `bun test` process; see hitl.integration.test.ts's subprocess
  // fixture for how it's actually exercised). All of installLogFileTee()'s
  // own pure logic (the guard, sink-building, wrapping sequencing) is
  // unit-tested in-process in hitl.unit.test.ts via an injected fake
  // LogFileTeeTarget — only this one small, dedicated, inherently-untestable
  // file is excluded, not hitl.ts as a whole (HTL-1.1 / PR review, 2026-08-20).
  "scripts/hitl-log-file-tee-target.ts",

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

// Matches one <class ...> ... </class> block (non-greedy so consecutive
// classes don't merge into a single match), capturing its attributes and
// inner body separately so nested <method> counters can be stripped before
// scanning for the class's own direct <counter> children.
const CLASS_BLOCK_RE = /<class\b([^>]*)>([\s\S]*?)<\/class>/g;
const NAME_ATTR_RE = /\bname="([^"]*)"/;
const METHOD_BLOCK_RE = /<method\b[^>]*>[\s\S]*?<\/method>/g;

// Extracts a class-level `<counter type="TYPE" missed="M" covered="C"/>`
// pair from XML already stripped of nested <method> blocks. Returns
// { missed: 0, covered: 0 } if the counter type is absent — JaCoCo omits
// counters for types that don't apply (e.g. no METHOD counter on an
// interface with no method bodies).
function readCounter(
  body: string,
  type: string,
): { missed: number; covered: number } {
  const re = new RegExp(
    `<counter\\s+type="${type}"\\s+missed="(\\d+)"\\s+covered="(\\d+)"`,
  );
  const match = body.match(re);
  if (!match) return { missed: 0, covered: 0 };
  return {
    missed: Number.parseInt(match[1], 10),
    covered: Number.parseInt(match[2], 10),
  };
}

// Parses JaCoCo XML report content into an ordered FileStats[] — one entry
// per <class> element, in document order. Uses the class's `name` attribute
// (a slash-separated fully-qualified class name) as the FileStats `path`,
// the closest JaCoCo analog to LCOV's SF: path. Only class-level counters
// (direct children of <class>) are counted; per-method nested counters and
// package/report-level rollup counters are ignored to avoid double-counting.
// String/regex-based, no XML parsing library — mirrors LcovParser's
// lightweight, dependency-free style. DOCTYPE and other non-<class> content
// is inert text that's simply never matched.
export const JacocoParser: CoverageParser = {
  parse(content: string): FileStats[] {
    const files: FileStats[] = [];

    for (const classMatch of content.matchAll(CLASS_BLOCK_RE)) {
      const [, attrs, body] = classMatch;
      const nameMatch = attrs.match(NAME_ATTR_RE);
      const path = nameMatch ? nameMatch[1] : "";

      // Strip nested <method> blocks so only the class's own direct
      // <counter> children remain for readCounter to scan.
      const classOwnBody = body.replace(METHOD_BLOCK_RE, "");

      const line = readCounter(classOwnBody, "LINE");
      const method = readCounter(classOwnBody, "METHOD");

      files.push({
        path,
        lf: line.missed + line.covered,
        lh: line.covered,
        fnf: method.missed + method.covered,
        fnh: method.covered,
      });
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

// Applies the same EXCLUDE_PREFIXES/EXCLUDE_SUBSTRINGS filtering as main()'s
// report, then returns the weighted aggregate line-coverage percentage
// (sum of LH / sum of LF across relevant files) — the single number both
// this gate and check-coverage-no-decrease.ts's PR-vs-base comparison need.
// 100 when there are no relevant files or no lines found, mirroring the
// "nothing to fail on" convention used throughout this module.
export function computeAggregateLinePct(files: FileStats[]): number {
  const relevant = filterRelevantFiles(
    files,
    EXCLUDE_PREFIXES,
    EXCLUDE_SUBSTRINGS,
  );

  const { totalLf, totalLh } = aggregateStats(relevant);

  return percentOf(totalLh, totalLf);
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

const COVERAGE_TOOL_DOC_PATH = "docs/test-readiness/test-system.md";

export type CliDeps = {
  readLcov?: () => Promise<string>;
  readCoverageToolDoc?: () => Promise<string>;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
};

// Orchestrates the CLI end to end and returns an exit code, rather than
// calling process.exit directly — the same injectable-dependencies pattern
// as check-coverage-no-decrease.ts's runCli, so this can be unit tested
// without a real filesystem/process.exit. import.meta.main below is the only
// caller that still needs a real process exit code.
export async function runCli(deps: CliDeps = {}): Promise<number> {
  const {
    readLcov = () => Bun.file(LCOV_PATH).text(),
    readCoverageToolDoc = () => Bun.file(COVERAGE_TOOL_DOC_PATH).text(),
    log = console.log,
    error = console.error,
  } = deps;

  let lcov: string;
  try {
    lcov = await readLcov();
  } catch {
    error(
      `No coverage file at ${LCOV_PATH}. Run: bun test --coverage --coverage-reporter=lcov`,
    );
    return 1;
  }

  // A missing/unreadable test-system.md is not fatal — treat the tool as
  // unset so selectParser falls back to LcovParser, same as any other repo
  // without a recorded Coverage toolchain field.
  let toolDoc: string;
  try {
    toolDoc = await readCoverageToolDoc();
  } catch {
    toolDoc = "";
  }
  const tool = extractCoverageTool(toolDoc);
  const parser = selectParser(tool);

  // MTC-1.6 only wires parser *selection* — readLcov always reads the fixed
  // LCOV_PATH regardless of which tool was recorded, and no per-tool
  // report-path dispatch exists yet. Feeding lcov-format content into a
  // non-lcov parser (Jacoco/CoveragePy/Istanbul/GoCover) produces zero
  // matches — filterRelevantFiles below would then hit the
  // relevant.length === 0 branch and the gate would silently pass instead of
  // evaluating real coverage. Fail loudly here instead until report-path
  // dispatch is added.
  if (parser !== LcovParser) {
    error(
      `Coverage toolchain "${tool}" is recorded, but check-coverage.ts only reads the lcov report file (${LCOV_PATH}) — no report-path dispatch exists yet for non-lcov tools. Refusing to parse lcov content with the ${tool} parser (would silently produce a false-positive pass).`,
    );
    return 1;
  }

  const files = parser.parse(lcov);

  const relevant = filterRelevantFiles(
    files,
    EXCLUDE_PREFIXES,
    EXCLUDE_SUBSTRINGS,
  );

  if (relevant.length === 0) {
    log("No source files in coverage report.");
    return 0;
  }

  for (const { path, lf, lh } of relevant) {
    const linePct = percentOf(lh, lf);
    const icon = linePct >= THRESHOLD_LINES ? "✅" : "⚠️";
    log(`${icon}  ${linePct.toFixed(1).padStart(5)}%  ${path}`);
  }

  const { totalLf, totalLh, totalFnf, totalFnh } = aggregateStats(relevant);
  const overallLines = percentOf(totalLh, totalLf);
  const overallFunctions = percentOf(totalFnh, totalFnf);

  log(`
Lines:     ${overallLines.toFixed(2)}% (${totalLh}/${totalLf}) — threshold: ${THRESHOLD_LINES}%
Functions: ${overallFunctions.toFixed(2)}% (${totalFnh}/${totalFnf}) — threshold: ${THRESHOLD_FUNCTIONS}%`);

  const failures = computeFailures(
    overallLines,
    overallFunctions,
    THRESHOLD_LINES,
    THRESHOLD_FUNCTIONS,
  );

  if (failures.length > 0) {
    error(`\n❌ Coverage gate failed: ${failures.join(", ")}`);
    return 1;
  }
  log("✅ Coverage gate passed");
  return 0;
}

if (import.meta.main) {
  process.exit(await runCli());
}
