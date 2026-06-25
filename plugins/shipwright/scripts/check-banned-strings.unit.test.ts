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

  test("detects app-vitals/marketplace in a file", () => {
    writeFile(
      tmpDir,
      "bad.ts",
      "// install from app-vitals/marketplace\nexport {};\n",
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe("app-vitals/marketplace");
    expect(hits[0].lineNum).toBe(1);
    expect(hits[0].line).toContain("app-vitals/marketplace");
  });

  test("detects app-vitals/vitals-os in a file", () => {
    writeFile(
      tmpDir,
      "bad.ts",
      "export const repo = 'app-vitals/vitals-os';\n",
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe("app-vitals/vitals-os");
  });

  test("detects vitals-os-prod in a file", () => {
    writeFile(tmpDir, "config.ts", "const env = 'vitals-os-prod';\n");
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe("vitals-os-prod");
  });

  test("detects vitals-os-staging in a file", () => {
    writeFile(tmpDir, "config.ts", "const env = 'vitals-os-staging';\n");
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe("vitals-os-staging");
  });

  test("detects vitals-os-dev in a file", () => {
    writeFile(tmpDir, "config.ts", "const env = 'vitals-os-dev';\n");
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe("vitals-os-dev");
  });

  test("detects multiple banned strings across multiple files", () => {
    writeFile(tmpDir, "a.ts", "const a = 'app-vitals/marketplace';\n");
    writeFile(tmpDir, "b.ts", "const b = 'vitals-os-prod';\n");
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(2);
  });

  test("detects multiple hits on different lines of the same file", () => {
    writeFile(
      tmpDir,
      "multi.ts",
      "const a = 'app-vitals/marketplace';\nconst b = 'vitals-os-staging';\n",
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
      "refactor: move off app-vitals/marketplace\n",
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toEqual([]);
  });

  test("skips node_modules/ directory", () => {
    mkdirSync(join(tmpDir, "node_modules"), { recursive: true });
    writeFile(
      tmpDir,
      "node_modules/bad-pkg/index.ts",
      "const repo = 'app-vitals/vitals-os';\n",
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toEqual([]);
  });

  test("skips worktrees/ directory", () => {
    mkdirSync(join(tmpDir, "worktrees"), { recursive: true });
    writeFile(
      tmpDir,
      "worktrees/my-branch/src/foo.ts",
      "const repo = 'app-vitals/vitals-os';\n",
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toEqual([]);
  });

  test("skips dist/ directory", () => {
    mkdirSync(join(tmpDir, "dist"), { recursive: true });
    writeFile(
      tmpDir,
      "dist/index.js",
      "const repo = 'app-vitals/marketplace';\n",
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toEqual([]);
  });

  test("skips self-referential excluded filenames (check-banned-strings.ts and its test)", () => {
    writeFile(
      tmpDir,
      "check-banned-strings.ts",
      "const p = 'app-vitals/vitals-os';\n",
    );
    writeFile(
      tmpDir,
      "check-banned-strings.unit.test.ts",
      "const q = 'app-vitals/marketplace';\n",
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toEqual([]);
  });

  test("scans files in nested subdirectories", () => {
    writeFile(
      tmpDir,
      "nested/deep/file.ts",
      "const x = 'app-vitals/vitals-os';\n",
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toContain("nested/deep/file.ts");
  });

  test("includes file, lineNum, line, and pattern fields in each hit", () => {
    writeFile(tmpDir, "check.ts", "const x = 'app-vitals/marketplace';\n");
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
    writeFile(tmpDir, "src/config.ts", "const x = 'app-vitals/marketplace';\n");
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
      'const SAMPLE = JSON.stringify({ repo: "app-vitals/vitals-os" });\n',
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe("app-vitals/vitals-os");
    expect(hits[0].file).toBe("agent/src/posthog.unit.test.ts");
  });

  test("detects banned string in metrics-style deep path (simulating metrics/ package)", () => {
    writeFile(
      tmpDir,
      "metrics/src/secrets.ts",
      "const env = 'vitals-os-prod';\n",
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe("vitals-os-prod");
    expect(hits[0].file).toBe("metrics/src/secrets.ts");
  });

  test("catches banned strings across multiple packages in a single scan", () => {
    writeFile(
      tmpDir,
      "plugins/shipwright/config.ts",
      "const a = 'app-vitals/marketplace';\n",
    );
    writeFile(
      tmpDir,
      "agent/src/crons.ts",
      "const b = 'app-vitals/vitals-os';\n",
    );
    writeFile(
      tmpDir,
      "metrics/src/secrets.ts",
      "const c = 'vitals-os-prod';\n",
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(3);
    const patterns = hits.map((h) => h.pattern).sort();
    expect(patterns).toEqual([
      "app-vitals/marketplace",
      "app-vitals/vitals-os",
      "vitals-os-prod",
    ]);
  });

  test("detects bare 'vitals-os' in a file", () => {
    writeFile(tmpDir, "config.ts", "const platform = 'vitals-os';\n");
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe("vitals-os");
    expect(hits[0].lineNum).toBe(1);
    expect(hits[0].line).toContain("vitals-os");
  });

  test("detects 'VITALS_OS' in a file", () => {
    writeFile(tmpDir, "env.ts", "const env = process.env.VITALS_OS;\n");
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe("VITALS_OS");
    expect(hits[0].lineNum).toBe(1);
    expect(hits[0].line).toContain("VITALS_OS");
  });

  test("skips planning/ directory", () => {
    mkdirSync(join(tmpDir, "planning"), { recursive: true });
    writeFile(
      tmpDir,
      "planning/notes.md",
      "We need to migrate off vitals-os completely.\n",
    );
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toEqual([]);
  });

  test("dedup invariant: a line matching both 'vitals-os' and 'vitals-os-prod' reports exactly 1 hit with the longer pattern", () => {
    // Use string concat so this test file is not itself flagged by the scanner.
    writeFile(tmpDir, "config.ts", "const env = 'vitals-os-" + "prod';\n");
    const hits = scanForBannedStrings(tmpDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe("vitals-os-" + "prod");
  });
});
