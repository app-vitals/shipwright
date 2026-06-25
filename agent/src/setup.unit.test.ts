/**
 * Unit tests for agent/src/setup.ts — installPlugins local marketplace seam
 *
 * Pure logic tests: no I/O, no real binaries, injected exec doubles only.
 */

import { describe, expect, it } from "bun:test";
import { discoverBakedMarketplaces, installPlugins } from "./setup.ts";

describe("installPlugins — local marketplace", () => {
  it("registers the marketplace before installing plugins", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(
      mockExec,
      "/tmp/cwd",
      [],
      "/repo/root",
      "/tmp/nonexistent-manifest.json",
    );

    // First call must be marketplace add
    expect(calls[0].args).toEqual([
      "plugin",
      "marketplace",
      "add",
      "/repo/root",
    ]);
  });

  it("installs and updates shipwright@shipwright using the shipwright marketplace name", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(
      mockExec,
      "/tmp/cwd",
      [],
      "/repo/root",
      "/tmp/nonexistent-manifest.json",
    );

    // marketplace add + install + update = 3 calls
    expect(calls).toHaveLength(3);
    expect(calls[1].args).toEqual([
      "plugin",
      "install",
      "shipwright@shipwright",
    ]);
    expect(calls[2].args).toEqual([
      "plugin",
      "update",
      "shipwright@shipwright",
    ]);
  });

  it("agent plugins use their own marketplace, not the local one", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(
      mockExec,
      "/tmp/cwd",
      [{ plugin: "my-plugin", marketplace: "org/my-marketplace" }],
      "/repo/root",
      "/tmp/nonexistent-manifest.json",
    );

    // marketplace add + 2 installs + 2 updates = 5 calls
    expect(calls).toHaveLength(5);
    const specs = calls.slice(1).map((c) => c.args[2]);
    expect(specs).toEqual([
      "shipwright@shipwright",
      "my-plugin@org/my-marketplace",
      "shipwright@shipwright",
      "my-plugin@org/my-marketplace",
    ]);
  });

  it("passes the repoRoot to marketplace add", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(
      mockExec,
      "/tmp/cwd",
      [],
      "/custom/repo/root",
      "/tmp/nonexistent-manifest.json",
    );

    expect(calls[0].args).toEqual([
      "plugin",
      "marketplace",
      "add",
      "/custom/repo/root",
    ]);
  });

  it("registers extra marketplaces before the /app marketplace", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    // Pass a non-existent root so discoverBakedMarketplaces can't find dirs —
    // we inject via extraMarketplaceDirs directly instead.
    await installPlugins(
      mockExec,
      "/tmp/cwd",
      [],
      "/repo/root",
      "/tmp/nonexistent-manifest.json",
      ["/opt/shipwright/marketplaces/my-marketplace"],
    );

    // Extra marketplace add must come BEFORE the /repo/root marketplace add
    const addCalls = calls.filter((c) => c.args[1] === "marketplace");
    expect(addCalls[0].args[3]).toBe(
      "/opt/shipwright/marketplaces/my-marketplace",
    );
    expect(addCalls[1].args[3]).toBe("/repo/root");
  });

  it("is a no-op when no extra marketplace dirs exist", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(
      mockExec,
      "/tmp/cwd",
      [],
      "/repo/root",
      "/tmp/nonexistent-manifest.json",
      [], // empty extra dirs
    );

    // Only the /repo/root marketplace add — no extra adds
    const addCalls = calls.filter((c) => c.args[1] === "marketplace");
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].args[3]).toBe("/repo/root");
  });
});

describe("discoverBakedMarketplaces", () => {
  it("returns dirs that have .claude-plugin/marketplace.json", () => {
    // Since discoverBakedMarketplaces uses real fs, we test with a known-absent path
    // The actual fs-based tests live in setup.integration.test.ts.
    // This unit test verifies the function is exported and handles absent roots.
    const result = discoverBakedMarketplaces(
      "/tmp/nonexistent-convention-root-abc123",
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when conventionRoot is absent (empty string)", () => {
    const result = discoverBakedMarketplaces("");
    expect(result).toEqual([]);
  });

  it("returns empty array when conventionRoot does not exist", () => {
    const result = discoverBakedMarketplaces("/opt/does-not-exist-xyz987");
    expect(result).toEqual([]);
  });
});
