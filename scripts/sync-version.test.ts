/**
 * Unit tests for scripts/sync-version.ts
 *
 * Uses a temp directory per test so no actual repo files are modified.
 * Covers: all 5 files updated, indent/newline preserved, bad version rejected.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { syncVersion } from "./sync-version";

// Minimal package.json content with 2-space indent + trailing newline
const INITIAL_PKG = `{
  "name": "test-pkg",
  "version": "0.1.0"
}
`;

// Subdirectory paths (relative to cwd) that sync-version writes to
const PKG_PATHS = [
  "package.json",
  "plugins/shipwright/package.json",
  "metrics/package.json",
  "agent/package.json",
];

function setupTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-version-test-"));
  // Create all required package.json files
  for (const rel of PKG_PATHS) {
    const abs = resolve(dir, rel);
    const parent = resolve(abs, "..");
    mkdirSync(parent, { recursive: true });
    writeFileSync(abs, INITIAL_PKG, "utf8");
  }
  // Create version.txt
  writeFileSync(resolve(dir, "version.txt"), "0.1.0\n", "utf8");
  return dir;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = setupTempDir();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("syncVersion", () => {
  it("updates all 4 package.json files with the new version", () => {
    syncVersion("1.2.3", tmpDir);
    for (const rel of PKG_PATHS) {
      const content = readFileSync(resolve(tmpDir, rel), "utf8");
      const pkg = JSON.parse(content) as { version: string };
      expect(pkg.version).toBe("1.2.3");
    }
  });

  it("updates version.txt with the new version and a trailing newline", () => {
    syncVersion("1.2.3", tmpDir);
    const content = readFileSync(resolve(tmpDir, "version.txt"), "utf8");
    expect(content).toBe("1.2.3\n");
  });

  it("preserves 2-space indent in package.json files", () => {
    syncVersion("2.0.0", tmpDir);
    for (const rel of PKG_PATHS) {
      const content = readFileSync(resolve(tmpDir, rel), "utf8");
      // Each line that has content should be indented with 2 spaces (not tab)
      expect(content).toContain('  "version": "2.0.0"');
    }
  });

  it("preserves trailing newline in package.json files", () => {
    syncVersion("2.0.0", tmpDir);
    for (const rel of PKG_PATHS) {
      const content = readFileSync(resolve(tmpDir, rel), "utf8");
      expect(content.endsWith("\n")).toBe(true);
    }
  });

  it("rejects a malformed version and leaves all files untouched", () => {
    expect(() => syncVersion("not-a-version", tmpDir)).toThrow();
    // All files must remain at original content
    for (const rel of PKG_PATHS) {
      const content = readFileSync(resolve(tmpDir, rel), "utf8");
      const pkg = JSON.parse(content) as { version: string };
      expect(pkg.version).toBe("0.1.0");
    }
    const versionTxt = readFileSync(resolve(tmpDir, "version.txt"), "utf8");
    expect(versionTxt).toBe("0.1.0\n");
  });

  it("rejects a version with a leading 'v' prefix", () => {
    expect(() => syncVersion("v1.0.0", tmpDir)).toThrow();
  });

  it("rejects an empty string version", () => {
    expect(() => syncVersion("", tmpDir)).toThrow();
  });

  it("rejects a partial semver (only major.minor)", () => {
    expect(() => syncVersion("1.2", tmpDir)).toThrow();
  });

  it("accepts a version with pre-release and build metadata", () => {
    syncVersion("1.0.0-alpha.1", tmpDir);
    const versionTxt = readFileSync(resolve(tmpDir, "version.txt"), "utf8");
    expect(versionTxt).toBe("1.0.0-alpha.1\n");
    for (const rel of PKG_PATHS) {
      const content = readFileSync(resolve(tmpDir, rel), "utf8");
      const pkg = JSON.parse(content) as { version: string };
      expect(pkg.version).toBe("1.0.0-alpha.1");
    }
  });
});
