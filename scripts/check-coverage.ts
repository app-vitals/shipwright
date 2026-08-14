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
