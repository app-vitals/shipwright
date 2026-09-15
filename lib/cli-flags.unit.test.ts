/**
 * lib/cli-flags.unit.test.ts
 *
 * Unit tests for the generalized CLI flag parser.
 * Pure logic — no I/O, no env side effects.
 */

import { describe, expect, test } from "bun:test";
import { parseFlags } from "./cli-flags.ts";

describe("parseFlags — `--flag value` syntax", () => {
  test("parses a single flag", () => {
    const result = parseFlags(["--agent-id", "agent-123"], ["--agent-id"]);
    expect(result["--agent-id"]).toBe("agent-123");
  });

  test("parses multiple flags together", () => {
    const result = parseFlags(
      ["--agent-id", "agent-abc", "--api-url", "https://api.test.com"],
      ["--agent-id", "--api-url", "--api-key"],
    );
    expect(result["--agent-id"]).toBe("agent-abc");
    expect(result["--api-url"]).toBe("https://api.test.com");
  });
});

describe("parseFlags — `--flag=value` syntax", () => {
  test("parses a single flag", () => {
    const result = parseFlags(["--db-url=postgres://localhost"], ["--db-url"]);
    expect(result["--db-url"]).toBe("postgres://localhost");
  });

  test("parses multiple flags together", () => {
    const result = parseFlags(
      ["--agent-id=agent-abc", "--api-url=https://api.test.com"],
      ["--agent-id", "--api-url"],
    );
    expect(result["--agent-id"]).toBe("agent-abc");
    expect(result["--api-url"]).toBe("https://api.test.com");
  });

  test("handles an empty value after the equals sign", () => {
    const result = parseFlags(["--db-url="], ["--db-url"]);
    expect(result["--db-url"]).toBe("");
  });
});

describe("parseFlags — mixed syntax", () => {
  test("parses one flag in `--flag value` form and another in `--flag=value` form", () => {
    const result = parseFlags(
      ["--agent-id", "agent-abc", "--api-url=https://api.test.com"],
      ["--agent-id", "--api-url"],
    );
    expect(result["--agent-id"]).toBe("agent-abc");
    expect(result["--api-url"]).toBe("https://api.test.com");
  });
});

describe("parseFlags — missing flag", () => {
  test("returns undefined for a declared flag that is not present in argv", () => {
    const result = parseFlags(["--agent-id", "agent-abc"], ["--agent-id", "--api-url"]);
    expect(result["--api-url"]).toBeUndefined();
  });

  test("returns undefined for every declared flag when argv is empty", () => {
    const result = parseFlags([], ["--agent-id", "--api-url"]);
    expect(result["--agent-id"]).toBeUndefined();
    expect(result["--api-url"]).toBeUndefined();
  });

  test("returns undefined when a `--flag value` form flag has no following value (end of argv)", () => {
    const result = parseFlags(["--agent-id"], ["--agent-id"]);
    expect(result["--agent-id"]).toBeUndefined();
  });
});

describe("parseFlags — unknown flags are ignored (tolerant behavior)", () => {
  test("skips a flag not declared in flagSpecs", () => {
    const result = parseFlags(["--unknown", "value", "--agent-id", "x"], ["--agent-id"]);
    expect(result["--agent-id"]).toBe("x");
    expect(result).not.toHaveProperty("--unknown");
  });

  test("skips an unknown flag in `--flag=value` form", () => {
    const result = parseFlags(["--unknown=value", "--agent-id=x"], ["--agent-id"]);
    expect(result["--agent-id"]).toBe("x");
    expect(result).not.toHaveProperty("--unknown");
  });
});
