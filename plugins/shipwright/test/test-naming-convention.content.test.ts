/**
 * Test naming-convention + runner-exclusion doc — T-001 (M1 infra baseline)
 *
 * Verifies docs/test-readiness/naming.md exists and documents all five
 * established test-suffix layers plus the new reserved `.canary.` suffix,
 * and that bunfig.toml's [test] pathIgnorePatterns excludes the e2e globs
 * plus the new reserved canary test glob — keeping the doc and the actual
 * runner-exclusion config in sync.
 *
 * Content-assertion only: readFileSync, no I/O beyond local file reads.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// plugins/shipwright/test/ → repo root
const repoRoot = resolve(import.meta.dir, "..", "..", "..");

function repoPath(...parts: string[]): string {
  return join(repoRoot, ...parts);
}

const NAMING_DOC_PATH = "docs/test-readiness/naming.md";

const ESTABLISHED_SUFFIXES = [
  ".unit.test.ts",
  ".integration.test.ts",
  ".smoke.test.ts",
  ".content.test.ts",
  ".spec.ts",
  ".e2e.ts",
] as const;

const RESERVED_SUFFIX = ".canary.";

const REQUIRED_IGNORE_PATTERNS = [
  "**/site/**",
  "**/metrics/e2e/**",
  "**/admin/e2e/**",
  "**/*.canary.test.ts",
] as const;

/**
 * Extract the pathIgnorePatterns array from bunfig.toml.
 *
 * bunfig.toml has no TOML parser dependency in this repo (checked
 * package.json / bun.lock), and the [test] section's array is a simple
 * single-line array — a line-scan against the known format is acceptable
 * per the current file structure.
 */
function readPathIgnorePatterns(): string[] {
  const raw = readFileSync(repoPath("bunfig.toml"), "utf8");
  const match = raw.match(/pathIgnorePatterns\s*=\s*\[([^\]]*)\]/);
  if (!match) {
    throw new Error("bunfig.toml: could not find pathIgnorePatterns array");
  }
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter((entry) => entry.length > 0);
}

// Minimal glob matcher for bunfig.toml's pathIgnorePatterns entries, all of
// which are shaped like a leading globstar segment, a literal segment, then
// a trailing globstar segment (e.g. site, metrics/e2e, or a *.suffix glob).
// A leading globstar segment matches zero or more leading path segments
// (including none); a trailing one matches zero or more trailing segments;
// a bare asterisk within a segment matches any run of non-separator
// characters. Scoped narrowly to verifying bunfig.toml's actual exclusion
// behavior — not a general-purpose glob engine.
function matchesGlob(path: string, pattern: string): boolean {
  let core = pattern;
  const hasLeadingGlobstar = core.startsWith("**/");
  if (hasLeadingGlobstar) core = core.slice(3);
  const hasTrailingGlobstar = core.endsWith("/**");
  if (hasTrailingGlobstar) core = core.slice(0, -3);

  const escaped = core
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  const prefixRe = hasLeadingGlobstar ? "(?:.*/)?" : "";
  const suffixRe = hasTrailingGlobstar ? "(?:/.*)?" : "";
  return new RegExp(`^${prefixRe}${escaped}${suffixRe}$`).test(path);
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
]);

/** Recursively collect every *.test.ts / *.spec.ts / *.e2e.ts path, relative to repoRoot. */
function collectTestFiles(dir: string, relDir = ""): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(join(dir, relDir))) {
    if (SKIP_DIRS.has(entry)) continue;
    const relPath = relDir ? `${relDir}/${entry}` : entry;
    const absPath = join(dir, relPath);
    if (statSync(absPath).isDirectory()) {
      results.push(...collectTestFiles(dir, relPath));
    } else if (/\.(test\.ts|spec\.ts|e2e\.ts)$/.test(entry)) {
      results.push(relPath);
    }
  }
  return results;
}

/** Whether a relative test-file path is a reserved/runner-owned suffix that must never run under default `bun test`. */
function isReservedOrRunnerOwned(relPath: string): boolean {
  return (
    relPath.endsWith(".spec.ts") ||
    relPath.endsWith(".e2e.ts") ||
    relPath.endsWith(".canary.test.ts")
  );
}

describe("test naming-convention + runner-exclusion doc (T-001)", () => {
  it("docs/test-readiness/naming.md exists", () => {
    expect(existsSync(repoPath(NAMING_DOC_PATH))).toBe(true);
  });

  const body = existsSync(repoPath(NAMING_DOC_PATH))
    ? readFileSync(repoPath(NAMING_DOC_PATH), "utf8")
    : "";

  for (const suffix of ESTABLISHED_SUFFIXES) {
    it(`naming.md mentions the established suffix '${suffix}'`, () => {
      expect(body).toContain(suffix);
    });
  }

  it(`naming.md mentions the reserved suffix '${RESERVED_SUFFIX}'`, () => {
    expect(body).toContain(RESERVED_SUFFIX);
  });

  it("naming.md documents the reserved canary suffix as not yet in use", () => {
    expect(body.toLowerCase()).toContain("reserved");
  });

  it("bunfig.toml pathIgnorePatterns contains all required exclusion globs", () => {
    const patterns = readPathIgnorePatterns();
    for (const required of REQUIRED_IGNORE_PATTERNS) {
      expect(patterns).toContain(required);
    }
  });

  it("bunfig.toml's pathIgnorePatterns exclude exactly the reserved/runner-owned files across the real repo tree — no unexpected file paths either way", () => {
    const patterns = readPathIgnorePatterns();
    const allTestFiles = collectTestFiles(repoRoot);

    const mismatches = allTestFiles
      .map((relPath) => {
        const isExcluded = patterns.some((p) => matchesGlob(relPath, p));
        const shouldBeExcluded = isReservedOrRunnerOwned(relPath);
        return { relPath, isExcluded, shouldBeExcluded };
      })
      .filter((r) => r.isExcluded !== r.shouldBeExcluded);

    expect(mismatches).toEqual([]);
  });
});
