/**
 * plugins/shipwright/scripts/check-banned-strings.unit.test.ts
 *
 * Unit tests for scanForBannedStrings() — pure filesystem logic, no CLI wrapper.
 *
 * All tests use temp directories created via mkdtempSync so they're isolated
 * and cleaned up after each suite. No mock.module() — real FS only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanForBannedStrings } from "./check-banned-strings.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Banned-string fixtures, assembled via concatenation (mirroring the checker
// itself) so this test file never contains a banned string verbatim on disk.
// Fragments are chosen so no single fragment contains another banned pattern.
const BANNED = {
  marketplace: "app-vitals/" + "marketplace",
  orgRepo: "app-vitals/" + "vitals-" + "os",
  prod: "vitals-" + "os-prod",
  staging: "vitals-" + "os-staging",
  dev: "vitals-" + "os-dev",
  bare: "vitals-" + "os",
  envVar: "VITALS_" + "OS",
} as const;

/** The public booking endpoint — exempt from the scan by design. */
const ALLOWED_BOOKING_URL =
  "https://" + "vitals-" + "os" + ".com/cal/book/discovery";

function writeFile(dir: string, relativePath: string, content: string): void {
  const fullPath = join(dir, relativePath);
  mkdirSync(join(dir, relativePath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("scanForBannedStrings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "check-banned-strings-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array for an empty directory", () => {
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toEqual([]);
  });

  test("returns empty array when files contain no banned strings", () => {
    writeFile(tmpDir, "clean.ts", "export const foo = 'bar';\n");
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toEqual([]);
  });

  test("detects the banned marketplace repo slug in a file", () => {
    writeFile(
      tmpDir,
      "bad.ts",
      `// install from ${BANNED.marketplace}\nexport {};\n`,
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe(BANNED.marketplace);
    expect(hits[0].lineNum).toBe(1);
    expect(hits[0].line).toContain(BANNED.marketplace);
  });

  test("detects the banned org/repo slug in a file", () => {
    writeFile(tmpDir, "bad.ts", `export const repo = '${BANNED.orgRepo}';\n`);
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe(BANNED.orgRepo);
  });

  test("detects the banned -prod identifier in a file", () => {
    writeFile(tmpDir, "config.ts", `const env = '${BANNED.prod}';\n`);
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe(BANNED.prod);
  });

  test("detects the banned -staging identifier in a file", () => {
    writeFile(tmpDir, "config.ts", `const env = '${BANNED.staging}';\n`);
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe(BANNED.staging);
  });

  test("detects the banned -dev identifier in a file", () => {
    writeFile(tmpDir, "config.ts", `const env = '${BANNED.dev}';\n`);
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe(BANNED.dev);
  });

  test("detects multiple banned strings across multiple files", () => {
    writeFile(tmpDir, "a.ts", `const a = '${BANNED.marketplace}';\n`);
    writeFile(tmpDir, "b.ts", `const b = '${BANNED.prod}';\n`);
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(2);
  });

  test("detects multiple hits on different lines of the same file", () => {
    writeFile(
      tmpDir,
      "multi.ts",
      `const a = '${BANNED.marketplace}';\nconst b = '${BANNED.staging}';\n`,
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(2);
    expect(hits[0].lineNum).toBe(1);
    expect(hits[1].lineNum).toBe(2);
  });

  test("skips .git/ directory", () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFile(
      tmpDir,
      ".git/COMMIT_EDITMSG",
      `refactor: move off ${BANNED.marketplace}\n`,
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toEqual([]);
  });

  test("skips node_modules/ directory", () => {
    mkdirSync(join(tmpDir, "node_modules"), { recursive: true });
    writeFile(
      tmpDir,
      "node_modules/bad-pkg/index.ts",
      `const repo = '${BANNED.orgRepo}';\n`,
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toEqual([]);
  });

  test("skips worktrees/ directory", () => {
    mkdirSync(join(tmpDir, "worktrees"), { recursive: true });
    writeFile(
      tmpDir,
      "worktrees/my-branch/src/foo.ts",
      `const repo = '${BANNED.orgRepo}';\n`,
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toEqual([]);
  });

  test("skips dist/ directory", () => {
    mkdirSync(join(tmpDir, "dist"), { recursive: true });
    writeFile(
      tmpDir,
      "dist/index.js",
      `const repo = '${BANNED.marketplace}';\n`,
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toEqual([]);
  });

  test("skips self-referential excluded filenames (check-banned-strings.ts and its test)", () => {
    writeFile(
      tmpDir,
      "check-banned-strings.ts",
      `const p = '${BANNED.orgRepo}';\n`,
    );
    writeFile(
      tmpDir,
      "check-banned-strings.unit.test.ts",
      `const q = '${BANNED.marketplace}';\n`,
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toEqual([]);
  });

  test("scans files in nested subdirectories", () => {
    writeFile(
      tmpDir,
      "nested/deep/file.ts",
      `const x = '${BANNED.orgRepo}';\n`,
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toContain("nested/deep/file.ts");
  });

  test("includes file, lineNum, line, and pattern fields in each hit", () => {
    writeFile(tmpDir, "check.ts", `const x = '${BANNED.marketplace}';\n`);
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(typeof hit.file).toBe("string");
    expect(typeof hit.lineNum).toBe("number");
    expect(typeof hit.line).toBe("string");
    expect(typeof hit.pattern).toBe("string");
  });

  test("does not crash on binary-like files (null bytes)", () => {
    // Write a file that contains a null byte — simulates a binary file
    const binaryPath = join(tmpDir, "binary.bin");
    writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0xff]));
    // Should not throw; binary files may return 0 hits
    expect(() => scanForBannedStrings(tmpDir)).not.toThrow();
  });

  test("returns the relative path of the matched file", () => {
    writeFile(tmpDir, "src/config.ts", `const x = '${BANNED.marketplace}';\n`);
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    // file should be relative to the scanned dir, not absolute
    expect(hits[0].file).not.toContain(tmpDir);
    expect(hits[0].file).toBe("src/config.ts");
  });

  // Repo-root scope tests — verifies the scanner catches banned strings anywhere
  // in the tree (not just under plugins/), matching the expanded default scope.

  test("detects banned string in agent-style deep path (simulating agent/ package)", () => {
    writeFile(
      tmpDir,
      "agent/src/posthog.unit.test.ts",
      `const SAMPLE = JSON.stringify({ repo: "${BANNED.orgRepo}" });\n`,
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe(BANNED.orgRepo);
    expect(hits[0].file).toBe("agent/src/posthog.unit.test.ts");
  });

  test("detects banned string in metrics-style deep path (simulating metrics/ package)", () => {
    writeFile(
      tmpDir,
      "metrics/src/secrets.ts",
      `const env = '${BANNED.prod}';\n`,
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe(BANNED.prod);
    expect(hits[0].file).toBe("metrics/src/secrets.ts");
  });

  test("catches banned strings across multiple packages in a single scan", () => {
    writeFile(
      tmpDir,
      "plugins/shipwright/config.ts",
      `const a = '${BANNED.marketplace}';\n`,
    );
    writeFile(tmpDir, "agent/src/crons.ts", `const b = '${BANNED.orgRepo}';\n`);
    writeFile(
      tmpDir,
      "metrics/src/secrets.ts",
      `const c = '${BANNED.prod}';\n`,
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(3);
    const patterns = hits.map((h) => h.pattern).sort();
    expect(patterns).toEqual(
      [BANNED.marketplace, BANNED.orgRepo, BANNED.prod].sort(),
    );
  });

  test("detects the bare banned identifier in a file", () => {
    writeFile(tmpDir, "config.ts", `const platform = '${BANNED.bare}';\n`);
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe(BANNED.bare);
    expect(hits[0].lineNum).toBe(1);
    expect(hits[0].line).toContain(BANNED.bare);
  });

  test("detects the banned env-var identifier in a file", () => {
    writeFile(tmpDir, "env.ts", `const env = process.env.${BANNED.envVar};\n`);
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe(BANNED.envVar);
    expect(hits[0].lineNum).toBe(1);
    expect(hits[0].line).toContain(BANNED.envVar);
  });

  test("skips planning/ directory", () => {
    mkdirSync(join(tmpDir, "planning"), { recursive: true });
    writeFile(
      tmpDir,
      "planning/notes.md",
      `We need to migrate off ${BANNED.bare} completely.\n`,
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toEqual([]);
  });

  test("dedup invariant: a line matching both the bare identifier and its -prod variant reports exactly 1 hit with the longer pattern", () => {
    writeFile(tmpDir, "config.ts", `const env = '${BANNED.prod}';\n`);
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe(BANNED.prod);
  });

  test("allows the public booking URL", () => {
    writeFile(
      tmpDir,
      "consts.ts",
      `export const BOOKING_URL = "${ALLOWED_BOOKING_URL}";\n`,
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toEqual([]);
  });

  test("the allowed booking URL does not shield a banned token on the same line", () => {
    writeFile(
      tmpDir,
      "config.ts",
      `const url = "${ALLOWED_BOOKING_URL}"; const env = "${BANNED.prod}";\n`,
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe(BANNED.prod);
  });

  test("the allowed prefix does not exempt other hosts on the same identifier", () => {
    writeFile(tmpDir, "config.ts", `const host = "${BANNED.bare}.internal";\n`);
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe(BANNED.bare);
  });
});
