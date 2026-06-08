/**
 * plugins/shipwright/scripts/check-banned-strings.ts
 *
 * Scans a directory recursively for banned strings that should never appear
 * in the plugin (confidential client names, internal infrastructure identifiers).
 *
 * Usage (CLI):
 *   bun plugins/shipwright/scripts/check-banned-strings.ts [dir]
 *
 * Exports:
 *   scanForBannedStrings(dir) → Hit[]   (testable pure logic)
 *
 * Exit codes:
 *   0 — no banned strings found
 *   1 — one or more banned strings found
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Hit {
  /** Path relative to the scanned root directory. */
  file: string;
  /** 1-based line number of the match. */
  lineNum: number;
  /** Full text of the matching line. */
  line: string;
  /** The banned pattern that matched. */
  pattern: string;
}

// ---------------------------------------------------------------------------
// Banned patterns
// ---------------------------------------------------------------------------

const BANNED_PATTERNS: string[] = [
  "app-vitals/" + "marketplace",
  "app-vitals/" + "vitals-os",
  "vitals-os-" + "prod",
  "vitals-os-" + "staging",
  "vitals-os-" + "dev",
];

/**
 * Filenames (basename only) that are excluded from scanning because they
 * contain the canonical pattern definitions or test fixtures for this script.
 * These files are self-referential by design and must not be flagged.
 */
const EXCLUDED_FILENAMES: Set<string> = new Set([
  "check-banned-strings.ts",
  "check-banned-strings.unit.test.ts",
]);

/**
 * Directory names (basename only) that are skipped entirely during traversal.
 * These are build outputs, dependency trees, or VCS internals that should
 * never contain source files requiring the banned-string check.
 */
const EXCLUDED_DIRS: Set<string> = new Set([
  ".git",
  "node_modules",
  "worktrees",
  "dist",
  ".next",
  "build",
  "coverage",
  ".turbo",
]);

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Recursively scan `dir` for any occurrence of the banned patterns.
 * Skips `.git/` directories and the checker script itself. Does not follow symlinks.
 *
 * @param dir  Absolute path of the directory to scan.
 * @returns    Array of hits (empty if the directory is clean).
 */
export function scanForBannedStrings(dir: string): Hit[] {
  const hits: Hit[] = [];
  walkDir(dir, dir, hits);
  return hits;
}

function walkDir(root: string, current: string, hits: Hit[]): void {
  let entries: string[];
  try {
    entries = readdirSync(current);
  } catch {
    // Unreadable directory — skip silently.
    return;
  }

  for (const entry of entries) {
    // Skip excluded directories (build outputs, dependency trees, VCS internals) at any depth
    if (EXCLUDED_DIRS.has(entry)) continue;
    // Skip the checker script and its test (self-referential by design)
    if (EXCLUDED_FILENAMES.has(entry)) continue;

    const fullPath = join(current, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(fullPath);
    } catch {
      // Broken symlink or permission error — skip.
      continue;
    }

    if (stat.isDirectory()) {
      walkDir(root, fullPath, hits);
    } else if (stat.isFile()) {
      scanFile(root, fullPath, hits);
    }
  }
}

function scanFile(root: string, filePath: string, hits: Hit[]): void {
  let content: string;
  try {
    const raw = readFileSync(filePath);
    // Skip binary files — if the buffer contains a null byte, treat as binary.
    if (raw.includes(0)) return;
    content = raw.toString("utf8");
  } catch {
    // Unreadable file — skip.
    return;
  }

  const relPath = relative(root, filePath);
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of BANNED_PATTERNS) {
      if (line.includes(pattern)) {
        hits.push({
          file: relPath,
          lineNum: i + 1,
          line,
          pattern,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  // Resolve the directory to scan.
  // Defaults to the project root (three levels up from this script's location:
  // scripts/ → shipwright/ → plugins/ → root).
  // Pass an explicit path as process.argv[2] to override.
  const scriptDir = import.meta.dirname ?? process.cwd();
  // scripts/ → shipwright/ → plugins/ → project root
  const projectRoot = join(scriptDir, "..", "..", "..");

  const targetDir = process.argv[2] ?? projectRoot;

  const hits = scanForBannedStrings(targetDir);

  if (hits.length === 0) {
    console.log("✓ No banned strings found.");
    process.exit(0);
  }

  console.error(`✗ Found ${hits.length} banned string hit(s):\n`);
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.lineNum}  [${hit.pattern}]`);
    console.error(`    ${hit.line.trim()}`);
  }
  process.exit(1);
}

// Run CLI only when this file is the entry point (not when imported in tests).
if (import.meta.main) {
  main();
}
