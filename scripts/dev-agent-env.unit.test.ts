/**
 * scripts/dev-agent-env.unit.test.ts
 * Unit tests for state/dev-agent.env.example — verifies the committed example
 * file exists, is parseable, and documents the required keys a developer needs
 * to fill in before running `task stack`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const EXAMPLE_FILE = resolve(process.cwd(), "state/dev-agent.env.example");

function readExample(): string {
  return readFileSync(EXAMPLE_FILE, "utf8");
}

describe("state/dev-agent.env.example — structure", () => {
  test("the example file exists", () => {
    expect(() => statSync(EXAMPLE_FILE)).not.toThrow();
  });

  test("contains CLAUDE_CODE_OAUTH_TOKEN key", () => {
    expect(readExample()).toMatch(/CLAUDE_CODE_OAUTH_TOKEN\s*=/);
  });

  test("contains GH_TOKEN key", () => {
    expect(readExample()).toMatch(/GH_TOKEN\s*=/);
  });

  test("has a comment explaining CLAUDE_CODE_OAUTH_TOKEN", () => {
    const content = readExample();
    // There should be a comment line above or near CLAUDE_CODE_OAUTH_TOKEN
    expect(content).toMatch(/#.*CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN.*#/i);
  });

  test("CLAUDE_CODE_OAUTH_TOKEN value is a placeholder (not a real token)", () => {
    const content = readExample();
    // Value should be empty or a recognisable placeholder like <your-token> / YOUR_TOKEN_HERE
    const match = content.match(/CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(\S*)/);
    expect(match).not.toBeNull();
    const value = match?.[1] ?? "";
    // A real Claude OAuth token starts with sk-ant- and is long — the example
    // must not accidentally commit a real token.
    expect(value).not.toMatch(/^sk-ant-/);
  });
});
