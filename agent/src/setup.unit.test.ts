/**
 * Unit tests for agent/src/setup.ts — installPlugins local marketplace seam
 *
 * Pure logic tests: no I/O, no real binaries, injected exec doubles only.
 */

import { describe, expect, it } from "bun:test";
import { installPlugins } from "./setup.ts";

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

    await installPlugins(mockExec, "/tmp/cwd", [], "/repo/root");

    // First call must be marketplace add
    expect(calls[0].args).toEqual([
      "plugin",
      "marketplace",
      "add",
      "/repo/root",
    ]);
  });

  it("installs and updates shipwright@app-vitals using the local marketplace name", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(mockExec, "/tmp/cwd", [], "/repo/root");

    // marketplace add + install + update = 3 calls
    expect(calls).toHaveLength(3);
    expect(calls[1].args).toEqual([
      "plugin",
      "install",
      "shipwright@app-vitals",
    ]);
    expect(calls[2].args).toEqual([
      "plugin",
      "update",
      "shipwright@app-vitals",
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
    );

    // marketplace add + 2 installs + 2 updates = 5 calls
    expect(calls).toHaveLength(5);
    const specs = calls.slice(1).map((c) => c.args[2]);
    expect(specs).toEqual([
      "shipwright@app-vitals",
      "my-plugin@org/my-marketplace",
      "shipwright@app-vitals",
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

    await installPlugins(mockExec, "/tmp/cwd", [], "/custom/repo/root");

    expect(calls[0].args).toEqual([
      "plugin",
      "marketplace",
      "add",
      "/custom/repo/root",
    ]);
  });
});
