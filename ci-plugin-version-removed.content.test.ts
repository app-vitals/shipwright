/**
 * RCN-9.16: the committed plugin version and the version-sync bot PR are gone.
 * Guards that sync-plugin-version.yml stays deleted, the manifests stay
 * versionless, and ci.yml's bot-only skip allowlist covers neither plugin-version
 * files nor (since RCN-9.10 retired the chart bump PR) chart-bump files.
 *
 * Lives at the repo root because `bun test` never walks dot-directories.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir);
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("plugin version sync removal", () => {
  it("deletes sync-plugin-version.yml and its shell test", () => {
    expect(existsSync(join(ROOT, ".github/workflows/sync-plugin-version.yml"))).toBe(false);
    expect(existsSync(join(ROOT, ".github/workflows/test-sync-plugin-version.sh"))).toBe(false);
  });

  it("keeps plugin.json and marketplace.json versionless", () => {
    for (const rel of [
      ".claude-plugin/marketplace.json",
      "plugins/shipwright/.claude-plugin/plugin.json",
    ]) {
      expect(JSON.parse(read(rel)).version).toBeUndefined();
    }
  });

  it("ci.yml bot-only allowlist matches no plugin-version or chart-bump files", () => {
    const m = read(".github/workflows/ci.yml").match(/PATTERN='([^']+)'/);
    expect(m).not.toBeNull();
    const re = new RegExp(m![1]);
    for (const f of [
      "charts/shipwright/Chart.yaml",
      "charts/shipwright/CHANGELOG.md",
      "package.json",
      "version.txt",
      ".claude-plugin/marketplace.json",
      "plugins/shipwright/.claude-plugin/plugin.json",
    ]) {
      expect(re.test(f)).toBe(false);
    }
  });

  it("no workflow references the removed workflow", () => {
    for (const rel of [
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      ".github/zizmor.yml",
    ]) {
      expect(read(rel)).not.toContain("sync-plugin-version");
    }
  });

  it("release.yml still stamps AGENT_VERSION into the agent image at build time", () => {
    expect(read(".github/workflows/release.yml")).toContain('--build-arg AGENT_VERSION="$AGENT_VERSION"');
    expect(read("agent/Dockerfile")).toContain("sync-version.ts");
  });
});
