/**
 * Unit tests for agent/src/setup.ts — SHIPWRIGHT_LOCAL_MARKETPLACE seam
 *
 * Pure logic tests: no I/O, no real binaries, injected exec doubles only.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { installPlugins } from "./setup.ts";

describe("installPlugins — SHIPWRIGHT_LOCAL_MARKETPLACE seam", () => {
  const originalLocalMarketplace = process.env.SHIPWRIGHT_LOCAL_MARKETPLACE;

  afterEach(() => {
    // Restore env var so tests don't bleed into each other.
    // Use delete when the var was originally unset — assigning undefined coerces
    // to the string "undefined" in Node.js-compatible runtimes, breaking the ?? fallback.
    if (originalLocalMarketplace === undefined) {
      // biome-ignore lint/performance/noDelete: intentional env-var removal (not object property)
      delete process.env.SHIPWRIGHT_LOCAL_MARKETPLACE;
    } else {
      process.env.SHIPWRIGHT_LOCAL_MARKETPLACE = originalLocalMarketplace;
    }
  });

  it("uses local path when SHIPWRIGHT_LOCAL_MARKETPLACE is set", async () => {
    process.env.SHIPWRIGHT_LOCAL_MARKETPLACE = "/local/path";

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(mockExec, "/tmp/test-cwd", []);

    // Both install and update should use the local path
    const specs = calls.map((c) => c.args[2]);
    expect(specs).toEqual([
      "shipwright@/local/path",
      "shipwright@/local/path",
    ]);
  });

  it("uses GitHub marketplace slug when SHIPWRIGHT_LOCAL_MARKETPLACE is unset", async () => {
    // biome-ignore lint/performance/noDelete: intentional env-var removal (not object property)
    delete process.env.SHIPWRIGHT_LOCAL_MARKETPLACE;

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(mockExec, "/tmp/test-cwd", []);

    // Should use the original GitHub marketplace slug
    const specs = calls.map((c) => c.args[2]);
    expect(specs).toEqual([
      "shipwright@app-vitals/shipwright",
      "shipwright@app-vitals/shipwright",
    ]);
  });

  it("covers both install and update commands with local path", async () => {
    process.env.SHIPWRIGHT_LOCAL_MARKETPLACE = "/local/path";

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(mockExec, "/tmp/test-cwd", []);

    expect(calls).toHaveLength(2);

    // install call uses local path
    expect(calls[0].args[1]).toBe("install");
    expect(calls[0].args[2]).toBe("shipwright@/local/path");

    // update call uses local path
    expect(calls[1].args[1]).toBe("update");
    expect(calls[1].args[2]).toBe("shipwright@/local/path");
  });
});
