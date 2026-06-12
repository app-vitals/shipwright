/**
 * Integration tests for .claude-plugin/marketplace.json
 *
 * Reads the REAL manifest at repo root (process.cwd() when bun test runs).
 * Verifies well-formedness and that each plugin entry's source resolves to a
 * directory containing a .claude-plugin/plugin.json whose name matches the entry.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MANIFEST_PATH = resolve(process.cwd(), ".claude-plugin/marketplace.json");

interface PluginEntry {
  name: string;
  description: string;
  source: string;
}

interface MarketplaceManifest {
  name: string;
  description: string;
  owner: { name: string; url: string };
  version: string;
  plugins: PluginEntry[];
}

describe("marketplace.json", () => {
  it("exists at .claude-plugin/marketplace.json", () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
  });

  it("parses as valid JSON", () => {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("has required top-level fields: name (string), owner (object), version (string), plugins (array)", () => {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    const manifest = JSON.parse(raw) as MarketplaceManifest;
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(typeof manifest.owner).toBe("object");
    expect(typeof manifest.owner.name).toBe("string");
    expect(manifest.owner.name.length).toBeGreaterThan(0);
    expect(typeof manifest.owner.url).toBe("string");
    expect(manifest.owner.url.length).toBeGreaterThan(0);
    expect(typeof manifest.version).toBe("string");
    expect(manifest.version.length).toBeGreaterThan(0);
    expect(Array.isArray(manifest.plugins)).toBe(true);
    expect(manifest.plugins.length).toBeGreaterThan(0);
  });

  it("each plugin entry has name, description, and source fields", () => {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    const manifest = JSON.parse(raw) as MarketplaceManifest;
    for (const entry of manifest.plugins) {
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
      expect(typeof entry.source).toBe("string");
      expect(entry.source.length).toBeGreaterThan(0);
    }
  });

  it("each plugin entry source resolves to a directory containing .claude-plugin/plugin.json", () => {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    const manifest = JSON.parse(raw) as MarketplaceManifest;
    for (const entry of manifest.plugins) {
      // source is relative to repo root (process.cwd())
      const pluginDir = resolve(process.cwd(), entry.source);
      const pluginJsonPath = join(pluginDir, ".claude-plugin", "plugin.json");
      expect(existsSync(pluginJsonPath)).toBe(true);
    }
  });

  it("each plugin entry name matches the plugin.json name in its source directory", () => {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    const manifest = JSON.parse(raw) as MarketplaceManifest;
    for (const entry of manifest.plugins) {
      const pluginDir = resolve(process.cwd(), entry.source);
      const pluginJsonPath = join(pluginDir, ".claude-plugin", "plugin.json");
      const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8")) as {
        name: string;
      };
      expect(pluginJson.name).toBe(entry.name);
    }
  });

  it("version is a valid semver string", () => {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    const manifest = JSON.parse(raw) as MarketplaceManifest;
    const semverRe =
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
    expect(semverRe.test(manifest.version)).toBe(true);
  });

  it("preserves 2-space indent and trailing newline", () => {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    // 2-space indent means lines inside objects start with "  "
    const lines = raw.split("\n");
    const indentedLine = lines.find((l) => l.startsWith("  "));
    expect(indentedLine).toBeDefined();
  });
});
