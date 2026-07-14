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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkVersionSync, syncVersion } from "./sync-version";

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
  "plugins/shipwright/.claude-plugin/plugin.json",
  "metrics/package.json",
  "agent/package.json",
];

const MARKETPLACE_JSON_PATH = ".claude-plugin/marketplace.json";

// Minimal marketplace.json content
const INITIAL_MARKETPLACE = `{
  "owner": "app-vitals",
  "version": "0.1.0",
  "plugins": [
    {
      "name": "shipwright",
      "description": "Test description",
      "source": "./plugins/shipwright"
    }
  ]
}
`;

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
  // Create .claude-plugin/marketplace.json
  const marketplaceAbs = resolve(dir, MARKETPLACE_JSON_PATH);
  mkdirSync(resolve(marketplaceAbs, ".."), { recursive: true });
  writeFileSync(marketplaceAbs, INITIAL_MARKETPLACE, "utf8");
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
  it("updates all 5 package.json/plugin.json files with the new version", () => {
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

  it("updates $.version in .claude-plugin/marketplace.json", () => {
    syncVersion("2.3.4", tmpDir);
    const content = readFileSync(
      resolve(tmpDir, MARKETPLACE_JSON_PATH),
      "utf8",
    );
    const manifest = JSON.parse(content) as { version: string };
    expect(manifest.version).toBe("2.3.4");
  });

  it("preserves plugins array and owner when updating marketplace.json version", () => {
    syncVersion("3.0.0", tmpDir);
    const content = readFileSync(
      resolve(tmpDir, MARKETPLACE_JSON_PATH),
      "utf8",
    );
    const manifest = JSON.parse(content) as {
      owner: string;
      version: string;
      plugins: Array<{ name: string }>;
    };
    expect(manifest.owner).toBe("app-vitals");
    expect(Array.isArray(manifest.plugins)).toBe(true);
    expect(manifest.plugins[0].name).toBe("shipwright");
  });

  it("preserves 2-space indent and trailing newline in marketplace.json", () => {
    syncVersion("1.5.0", tmpDir);
    const content = readFileSync(
      resolve(tmpDir, MARKETPLACE_JSON_PATH),
      "utf8",
    );
    expect(content.endsWith("\n")).toBe(true);
    expect(content).toContain('  "version": "1.5.0"');
  });
});

describe("checkVersionSync", () => {
  it("passes without throwing when all files agree on version.txt's version", () => {
    // setupTempDir initialises all files at 0.1.0 and version.txt at 0.1.0
    expect(() => checkVersionSync(tmpDir)).not.toThrow();
  });

  it("throws when plugin.json version mismatches version.txt", () => {
    // Write a different version into plugin.json
    const pluginJsonPath = resolve(tmpDir, "plugins/shipwright/.claude-plugin/plugin.json");
    const raw = readFileSync(pluginJsonPath, "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    pkg.version = "4.29.5";
    writeFileSync(pluginJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

    expect(() => checkVersionSync(tmpDir)).toThrow(/plugins\/shipwright\/.claude-plugin\/plugin\.json/);
  });

  it("throws with message containing expected and actual versions on plugin.json drift", () => {
    const pluginJsonPath = resolve(tmpDir, "plugins/shipwright/.claude-plugin/plugin.json");
    const raw = readFileSync(pluginJsonPath, "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    pkg.version = "9.9.9";
    writeFileSync(pluginJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

    let error: Error | undefined;
    try {
      checkVersionSync(tmpDir);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain("0.1.0");
    expect(error?.message).toContain("9.9.9");
  });

  it("throws when a package.json version mismatches version.txt", () => {
    // Drift one of the package.json files
    const pkgPath = resolve(tmpDir, "metrics/package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    pkg.version = "0.1.1";
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

    expect(() => checkVersionSync(tmpDir)).toThrow(/metrics\/package\.json/);
  });

  it("throws when marketplace.json version mismatches version.txt", () => {
    const marketplacePath = resolve(tmpDir, MARKETPLACE_JSON_PATH);
    const raw = readFileSync(marketplacePath, "utf8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    manifest.version = "5.0.0";
    writeFileSync(marketplacePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    expect(() => checkVersionSync(tmpDir)).toThrow(/.claude-plugin\/marketplace\.json/);
  });

  it("lists all drifted files in the error message when multiple files mismatch", () => {
    // Drift two files
    const pluginJsonPath = resolve(tmpDir, "plugins/shipwright/.claude-plugin/plugin.json");
    const pkgRaw = readFileSync(pluginJsonPath, "utf8");
    const pkgObj = JSON.parse(pkgRaw) as Record<string, unknown>;
    pkgObj.version = "3.0.0";
    writeFileSync(pluginJsonPath, `${JSON.stringify(pkgObj, null, 2)}\n`, "utf8");

    const agentPkgPath = resolve(tmpDir, "agent/package.json");
    const agentRaw = readFileSync(agentPkgPath, "utf8");
    const agentObj = JSON.parse(agentRaw) as Record<string, unknown>;
    agentObj.version = "2.0.0";
    writeFileSync(agentPkgPath, `${JSON.stringify(agentObj, null, 2)}\n`, "utf8");

    let error: Error | undefined;
    try {
      checkVersionSync(tmpDir);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain("plugins/shipwright/.claude-plugin/plugin.json");
    expect(error?.message).toContain("agent/package.json");
  });
});
