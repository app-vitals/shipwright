#!/usr/bin/env bun
// Parse coverage/lcov.info and fail if aggregate coverage is below threshold.
// Gate applies to the weighted aggregate (sum of LH/LF and FNH/FNF across all
// counted files) — not a per-file check. Bun's native bunfig.toml
// coverageThreshold enforces a PER-FILE minimum instead, which would fail CI
// on individual low-coverage files regardless of overall coverage — hence
// this separate aggregate gate.
export {};

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
];

// Paths containing this substring are excluded regardless of prefix
const EXCLUDE_SUBSTRINGS = ["prisma/client/"];
const LCOV_PATH = "coverage/lcov.info";

const lcov = await Bun.file(LCOV_PATH)
  .text()
  .catch(() => {
    console.error(
      `No coverage file at ${LCOV_PATH}. Run: bun test --coverage --coverage-reporter=lcov`,
    );
    process.exit(1);
  });

type FileStats = {
  lf: number;
  lh: number;
  fnf: number;
  fnh: number;
};
const files: Record<string, FileStats> = {};
let current = "";

for (const line of lcov.split("\n")) {
  if (line.startsWith("SF:")) {
    current = line.slice(3);
    files[current] = { lf: 0, lh: 0, fnf: 0, fnh: 0 };
  } else if (line.startsWith("LF:")) {
    files[current].lf = Number.parseInt(line.slice(3), 10);
  } else if (line.startsWith("LH:")) {
    files[current].lh = Number.parseInt(line.slice(3), 10);
  } else if (line.startsWith("FNF:")) {
    files[current].fnf = Number.parseInt(line.slice(4), 10);
  } else if (line.startsWith("FNH:")) {
    files[current].fnh = Number.parseInt(line.slice(4), 10);
  }
}

const relevant = Object.entries(files).filter(
  ([path]) =>
    !EXCLUDE_PREFIXES.some((ex) => path.startsWith(ex)) &&
    !EXCLUDE_SUBSTRINGS.some((sub) => path.includes(sub)),
);

if (relevant.length === 0) {
  console.log("No source files in coverage report.");
  process.exit(0);
}

let totalLf = 0;
let totalLh = 0;
let totalFnf = 0;
let totalFnh = 0;

for (const [path, { lf, lh, fnf, fnh }] of relevant) {
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
