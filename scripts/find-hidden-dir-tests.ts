#!/usr/bin/env bun
// Discovers *.test.ts / *.spec.ts files that Bun's own recursive `bun test`
// walker silently skips because they live under a dot-prefixed directory —
// e.g. .claude/commands/docs-sync.content.test.ts (SDR-3). Confirmed via
// `bun test <pattern-under-a-dot-dir>` reporting 0 matches out of the full
// searched-file count, while the file's exact relative path runs it
// directly — bun always resolves an explicit path argument regardless of
// the walker's dot-dir skip, and there is no `bun test` flag to make the
// walker itself traverse dot-directories (see `bun test --help`).
//
// This script globs for them with `Bun.Glob`'s `dot: true` option (which
// does traverse dot-directories) and, if any are found, passes each one to
// `bun test` as an explicit path argument. Wired into `task test` / `task
// ci` so a future test added under any hidden directory keeps running in
// CI without a bespoke fix per file.

import { Glob } from "bun";

const IGNORE_PREFIXES = ["site/", "metrics/e2e/", "admin/e2e/"];
const IGNORE_SUFFIX = ".canary.test.ts";

function isUnderHiddenDir(relPath: string): boolean {
  const dirSegments = relPath.split("/").slice(0, -1);
  return dirSegments.some((segment) => segment.startsWith("."));
}

function isIgnored(relPath: string): boolean {
  if (relPath.endsWith(IGNORE_SUFFIX)) return true;
  return IGNORE_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/**
 * Pure filter over an already-discovered file list — exported so the
 * selection logic (hidden-dir check, node_modules/.git exclusion, the same
 * ignore patterns bunfig.toml applies to the main `bun test` walk) is unit
 * testable without touching the real filesystem.
 */
export function filterHiddenDirTestFiles(allFiles: string[]): string[] {
  return allFiles
    .filter((f) => !f.includes("node_modules/"))
    .filter((f) => !f.startsWith(".git/"))
    .filter(isUnderHiddenDir)
    .filter((f) => !isIgnored(f))
    .sort();
}

async function scanRepo(cwd: string): Promise<string[]> {
  const glob = new Glob("**/*.{test,spec}.ts");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd, dot: true })) {
    files.push(file);
  }
  return files;
}

if (import.meta.main) {
  const cwd = process.cwd();
  const hiddenDirTests = filterHiddenDirTestFiles(await scanRepo(cwd));

  if (hiddenDirTests.length === 0) {
    console.log(
      "find-hidden-dir-tests: no test files found under hidden directories — nothing to do.",
    );
    process.exit(0);
  }

  console.log(
    `find-hidden-dir-tests: running ${hiddenDirTests.length} test file(s) under hidden directories (skipped by bun test's default walker):`,
  );
  for (const f of hiddenDirTests) console.log(`  ${f}`);

  // bun test treats a bare relative path as a substring *filter* over its
  // walked file list (which never includes dot-directories) unless it's
  // prefixed with "./" — without that prefix it reports "did not match any
  // test files" even for a file that exists exactly at that path (bun's own
  // hint: `To treat "..." as a path, run "bun test ./..."`).
  const explicitPaths = hiddenDirTests.map((f) => `./${f}`);
  const proc = Bun.spawn(["bun", "test", ...explicitPaths], {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await proc.exited);
}
