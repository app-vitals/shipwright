#!/usr/bin/env bun
// Parse coverage/lcov.info and fail if aggregate coverage is below threshold.
// Gate applies to the weighted aggregate (sum of LH/LF and FNH/FNF across all
// counted files) — not a per-file check. Bun's native bunfig.toml
// coverageThreshold enforces a PER-FILE minimum instead, which would fail CI
// on individual low-coverage files regardless of overall coverage — hence
// this separate aggregate gate.

const THRESHOLD_LINES = 80;
const THRESHOLD_FUNCTIONS = 80;

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

  const relevant = files.filter(
    (file) =>
      !EXCLUDE_PREFIXES.some((ex) => file.path.startsWith(ex)) &&
      !EXCLUDE_SUBSTRINGS.some((sub) => file.path.includes(sub)),
  );

  if (relevant.length === 0) {
    console.log("No source files in coverage report.");
    process.exit(0);
  }

  let totalLf = 0;
  let totalLh = 0;
  let totalFnf = 0;
  let totalFnh = 0;

  for (const { path, lf, lh, fnf, fnh } of relevant) {
    totalLf += lf;
    totalLh += lh;
    totalFnf += fnf;
    totalFnh += fnh;

    const linePct = lf === 0 ? 100 : (lh / lf) * 100;
    const icon = linePct >= THRESHOLD_LINES ? "✅" : "⚠️";
    console.log(`${icon}  ${linePct.toFixed(1).padStart(5)}%  ${path}`);
  }

  const overallLines = totalLf === 0 ? 100 : (totalLh / totalLf) * 100;
  const overallFunctions = totalFnf === 0 ? 100 : (totalFnh / totalFnf) * 100;

  console.log(`
Lines:     ${overallLines.toFixed(2)}% (${totalLh}/${totalLf}) — threshold: ${THRESHOLD_LINES}%
Functions: ${overallFunctions.toFixed(2)}% (${totalFnh}/${totalFnf}) — threshold: ${THRESHOLD_FUNCTIONS}%`);

  const failures: string[] = [];
  if (overallLines < THRESHOLD_LINES)
    failures.push(`Lines ${overallLines.toFixed(2)}% < ${THRESHOLD_LINES}%`);
  if (overallFunctions < THRESHOLD_FUNCTIONS)
    failures.push(
      `Functions ${overallFunctions.toFixed(2)}% < ${THRESHOLD_FUNCTIONS}%`,
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
