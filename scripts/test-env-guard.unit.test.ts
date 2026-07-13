/**
 * scripts/test-env-guard.unit.test.ts
 *
 * Config-drift regression guard for SEN-3.1: `buildSentryInitOptions()` in
 * `lib/sentry.ts` only skips Sentry init when `process.env.NODE_ENV === "test"`.
 * Bun auto-sets NODE_ENV=test for `bun test` runs, but only when NODE_ENV is
 * unset in the invoking shell — if a parent process already exports
 * NODE_ENV (e.g. NODE_ENV=production), Bun leaves it unchanged and the guard
 * silently never fires.
 *
 * This test asserts that every full-workspace `bun test` invocation in
 * Taskfile.yml and package.json is explicitly prefixed with `NODE_ENV=test`,
 * so the guard holds regardless of what's already exported by the invoking
 * environment. It reads the two config files directly off disk (not
 * network/DB I/O) rather than exercising `buildSentryInitOptions()` itself —
 * that behavior is already covered by lib/sentry.unit.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Resolve relative to the repo root (cwd when tests run)
const TASKFILE_PATH = resolve(process.cwd(), "Taskfile.yml");
const PACKAGE_JSON_PATH = resolve(process.cwd(), "package.json");

function readTaskfile(): string {
  return readFileSync(TASKFILE_PATH, "utf8");
}

function readPackageJson(): string {
  return readFileSync(PACKAGE_JSON_PATH, "utf8");
}

/**
 * Naive YAML task-block extractor — pulls out the block under `tasks:\n  <key>:`
 * Returns the indented block text for the given top-level task key.
 * Mirrors the extractor in scripts/dev.taskfile.integration.test.ts.
 */
function getTaskBlock(content: string, taskKey: string): string | null {
  const escapedKey = taskKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^  ${escapedKey}:\\s*$`, "m");
  const match = re.exec(content);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const end = rest.search(/^ {2}\S/m);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("Taskfile.yml — full-workspace `bun test` invocations are NODE_ENV=test guarded", () => {
  test("task test runs `NODE_ENV=test bun test`", () => {
    const content = readTaskfile();
    const block = getTaskBlock(content, "test");
    expect(block).not.toBeNull();
    expect(block).toMatch(/^\s*-\s*NODE_ENV=test bun test\s*$/m);
  });

  test("task test:coverage runs `NODE_ENV=test bun test --coverage --coverage-reporter=lcov`", () => {
    const content = readTaskfile();
    const block = getTaskBlock(content, "test:coverage");
    expect(block).not.toBeNull();
    expect(block).toMatch(
      /^\s*-\s*NODE_ENV=test bun test --coverage --coverage-reporter=lcov\s*$/m,
    );
  });

  test("no full-workspace `bun test` cmd line in Taskfile.yml is missing the NODE_ENV=test prefix", () => {
    const content = readTaskfile();
    for (const key of ["test", "test:coverage"]) {
      const block = getTaskBlock(content, key);
      expect(block).not.toBeNull();
      const cmdLines = (block ?? "")
        .split("\n")
        .filter((line) => /^\s*-\s*bun test\b|^\s*-\s*NODE_ENV=test bun test\b/.test(line));
      expect(cmdLines.length).toBeGreaterThan(0);
      for (const line of cmdLines) {
        expect(line).toMatch(/NODE_ENV=test bun test\b/);
      }
    }
  });
});

describe("package.json — root `test` script is NODE_ENV=test guarded", () => {
  test('root "test" script is exactly "NODE_ENV=test bun test"', () => {
    const pkg = JSON.parse(readPackageJson()) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.test).toBe("NODE_ENV=test bun test");
  });
});
