/**
 * scripts/check-config-docs.ts
 *
 * CI validation script — checks that every process.env.* reference in
 * agent/src/ and plugins/shipwright/scripts/ is documented in docs/configuration.md.
 *
 * Usage (CLI):
 *   bun scripts/check-config-docs.ts
 *
 * Exports (pure string-parsing, no I/O):
 *   extractEnvVarNames(sourceCode: string): string[]
 *   extractDocumentedVars(markdownContent: string): string[]
 *
 * Exit codes:
 *   0 — all env vars are documented (or in the allowlist)
 *   1 — one or more undocumented vars found
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Allowlist — vars that don't need docs entries.
// These are universal OS/runtime vars that are universally understood,
// or test-only overrides that don't represent production configuration.
// ---------------------------------------------------------------------------

const ALLOWLIST: Set<string> = new Set([
  // Universal OS / runtime
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "TMPDIR",
  "TERM",
  "PWD",
  "HOSTNAME",
  "XDG_DATA_HOME",
  // Standard Node / Bun runtime
  "NODE_ENV",
  // Test-only vars set in test-env.ts / integration test setups
  "HOST",
]);

// ---------------------------------------------------------------------------
// Pure string-parsing functions (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Extracts all env var names referenced via process.env in TypeScript source code.
 *
 * Handles:
 *   process.env.VAR_NAME          — dot notation
 *   process.env?.VAR_NAME         — optional chaining
 *   process.env['VAR_NAME']       — bracket single-quote
 *   process.env["VAR_NAME"]       — bracket double-quote
 *
 * Only extracts literal string identifiers matching [A-Z][A-Z0-9_]* —
 * dynamic access like process.env[key] is intentionally skipped.
 *
 * Returns a deduplicated, sorted array of var names.
 */
export function extractEnvVarNames(sourceCode: string): string[] {
  const found = new Set<string>();

  // Dot notation and optional-chaining: process.env.VAR or process.env?.VAR
  for (const m of sourceCode.matchAll(/process\.env\??\.([A-Z][A-Z0-9_]*)/g)) {
    found.add(m[1]);
  }

  // Bracket notation with string literal: process.env['VAR'] or process.env["VAR"]
  for (const m of sourceCode.matchAll(
    /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
  )) {
    found.add(m[1]);
  }

  return Array.from(found).sort();
}

/**
 * Extracts all documented env var names from a Markdown configuration document.
 *
 * Scans every table row and looks at the first column for:
 *   | `VAR_NAME` | ...   — backtick-wrapped (common)
 *   | VAR_NAME   | ...   — plain (less common)
 *
 * Only identifiers matching [A-Z][A-Z0-9_]* are returned.
 * Header rows (Name, Type, Default, Description) and separator rows (---) are ignored.
 *
 * Returns a deduplicated, sorted array of var names.
 */
export function extractDocumentedVars(markdownContent: string): string[] {
  const found = new Set<string>();

  // Match table rows: | cell1 | cell2 | ...
  // We only look at the first cell (Name column).
  for (const m of markdownContent.matchAll(/^\|([^|]+)\|/gm)) {
    const cell = m[1].trim();

    // Strip backticks if present
    const stripped = cell.replace(/^`|`$/g, "").trim();

    // Only accept ALL_CAPS identifiers with optional underscores
    if (/^[A-Z][A-Z0-9_]*$/.test(stripped)) {
      found.add(stripped);
    }
  }

  return Array.from(found).sort();
}

// ---------------------------------------------------------------------------
// File collection helper
// ---------------------------------------------------------------------------

/**
 * Recursively collects all *.ts files from `dir` (excluding test files).
 * Skips node_modules, .git, dist, and worktrees directories.
 */
function collectTsFiles(dir: string, out: string[]): void {
  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "worktrees",
    "build",
  ]);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectTsFiles(full, out);
    } else if (
      st.isFile() &&
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".spec.ts")
    ) {
      out.push(full);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const scriptDir = import.meta.dirname ?? process.cwd();
  // scripts/ → project root
  const projectRoot = join(scriptDir, "..");

  const docsPath = join(projectRoot, "docs", "configuration.md");

  // 1. Read and parse documented vars
  let docsContent: string;
  try {
    docsContent = readFileSync(docsPath, "utf8");
  } catch (err) {
    console.error(`ERROR: Could not read ${docsPath}: ${err}`);
    process.exit(1);
  }

  const documentedVars = new Set(extractDocumentedVars(docsContent));

  // 2. Collect source files from the two directories
  // Intentionally excludes metrics/, admin/src/, and agent/scripts/ — those surfaces have
  // separate config documentation or use dynamic env access (process.env[name]) that the
  // regex cannot catch; expand sourceDirs if that changes.
  const sourceDirs = [
    join(projectRoot, "agent", "src"),
    join(projectRoot, "plugins", "shipwright", "scripts"),
  ];

  const sourceFiles: string[] = [];
  for (const dir of sourceDirs) {
    collectTsFiles(dir, sourceFiles);
  }

  // 3. Extract all env var references from source
  const allVars = new Set<string>();
  for (const filePath of sourceFiles) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      // Skip unreadable files
      continue;
    }
    for (const v of extractEnvVarNames(content)) {
      allVars.add(v);
    }
  }

  // 4. Find undocumented vars (not in docs and not in allowlist)
  const undocumented = Array.from(allVars)
    .filter((v) => !documentedVars.has(v) && !ALLOWLIST.has(v))
    .sort();

  // 5. Report
  if (undocumented.length === 0) {
    console.log(
      `check-config-docs: all ${allVars.size} env var(s) are documented.`,
    );
    process.exit(0);
  }

  console.error(
    `check-config-docs: ${undocumented.length} undocumented env var(s) found:\n`,
  );
  for (const v of undocumented) {
    console.error(`  ${v}`);
  }
  console.error(
    "\nAdd these vars to docs/configuration.md or the ALLOWLIST in scripts/check-config-docs.ts.",
  );
  process.exit(1);
}

if (import.meta.main) {
  main();
}
