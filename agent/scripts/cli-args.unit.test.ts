/**
 * agent/scripts/cli-args.unit.test.ts
 *
 * Unit tests for getArg() and hasFlag() CLI parsing helpers.
 */

import { describe, expect, it } from "bun:test";
import { getArg, hasFlag } from "./cli-args.ts";

describe("getArg", () => {
  it("returns the value for --name=value", () => {
    expect(getArg("--agent-id", ["--agent-id=abc123"])).toBe("abc123");
  });

  it("returns the next element for --name value", () => {
    expect(getArg("--agent-id", ["--agent-id", "abc123"])).toBe("abc123");
  });

  it("returns undefined when the flag is absent", () => {
    expect(getArg("--agent-id", ["--dry-run"])).toBeUndefined();
  });

  it("returns undefined when the flag is present but has no value (end of args)", () => {
    expect(getArg("--agent-id", ["--agent-id"])).toBeUndefined();
  });

  it("returns undefined for an empty argv", () => {
    expect(getArg("--agent-id", [])).toBeUndefined();
  });

  it("handles --name=value with equals sign in the value", () => {
    expect(getArg("--env-file", ["--env-file=path/to/file=1"])).toBe(
      "path/to/file=1",
    );
  });

  it("does not confuse a similar prefix", () => {
    expect(getArg("--id", ["--agent-id=abc"])).toBeUndefined();
  });

  it("returns the first match when the flag appears multiple times", () => {
    expect(
      getArg("--env-file", ["--env-file=first", "--env-file=second"]),
    ).toBe("first");
  });
});

describe("hasFlag", () => {
  it("returns true when the flag is present", () => {
    expect(hasFlag("--dry-run", ["--agent-id=abc", "--dry-run"])).toBe(true);
  });

  it("returns false when the flag is absent", () => {
    expect(hasFlag("--dry-run", ["--agent-id=abc"])).toBe(false);
  });

  it("returns false for an empty argv", () => {
    expect(hasFlag("--dry-run", [])).toBe(false);
  });

  it("does not match a prefix", () => {
    expect(hasFlag("--run", ["--dry-run"])).toBe(false);
  });
});
