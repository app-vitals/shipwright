/**
 * Unit tests for agent/src/claude-version.ts — injected exec, no module mocks.
 */

import { describe, expect, it } from "bun:test";
import {
  detectClaudeCodeVersion,
  parseClaudeVersion,
  UNKNOWN_CLAUDE_CODE_VERSION,
} from "./claude-version.ts";

describe("parseClaudeVersion", () => {
  it("parses the CLI's '<semver> (Claude Code)' output", () => {
    expect(parseClaudeVersion("2.1.236 (Claude Code)\n")).toBe("2.1.236");
  });

  it("parses a bare semver", () => {
    expect(parseClaudeVersion("2.1.236")).toBe("2.1.236");
  });

  it("keeps a prerelease suffix", () => {
    expect(parseClaudeVersion("2.2.0-beta.1 (Claude Code)")).toBe(
      "2.2.0-beta.1",
    );
  });

  it("returns null when no semver is present", () => {
    expect(parseClaudeVersion("")).toBeNull();
    expect(parseClaudeVersion("command not found")).toBeNull();
    expect(parseClaudeVersion("v2.1")).toBeNull();
  });
});

describe("detectClaudeCodeVersion", () => {
  it("runs `claude --version` and returns the parsed version", async () => {
    const calls: string[][] = [];
    const version = await detectClaudeCodeVersion(async (cmd) => {
      calls.push(cmd);
      return "2.1.236 (Claude Code)\n";
    });
    expect(version).toBe("2.1.236");
    expect(calls).toEqual([["claude", "--version"]]);
  });

  it("returns 'unknown' when exec rejects", async () => {
    const version = await detectClaudeCodeVersion(async () => {
      throw new Error("ENOENT");
    });
    expect(version).toBe(UNKNOWN_CLAUDE_CODE_VERSION);
  });

  it("returns 'unknown' when exec throws synchronously", async () => {
    const version = await detectClaudeCodeVersion(() => {
      throw new Error("spawn failed");
    });
    expect(version).toBe(UNKNOWN_CLAUDE_CODE_VERSION);
  });

  it("returns 'unknown' when output has no semver", async () => {
    const version = await detectClaudeCodeVersion(async () => "garbage");
    expect(version).toBe(UNKNOWN_CLAUDE_CODE_VERSION);
  });

  it("returns 'unknown' within the timeout when exec hangs", async () => {
    const start = Date.now();
    const version = await detectClaudeCodeVersion(
      () => new Promise<string>(() => {}),
      50,
    );
    expect(version).toBe(UNKNOWN_CLAUDE_CODE_VERSION);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
