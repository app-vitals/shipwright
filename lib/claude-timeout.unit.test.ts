import { describe, expect, test } from "bun:test";
import { DEFAULT_CLAUDE_TIMEOUT_MS } from "./claude-timeout.ts";

describe("claude-timeout", () => {
  test("DEFAULT_CLAUDE_TIMEOUT_MS is 3_600_000 (1hr hard ceiling)", () => {
    expect(DEFAULT_CLAUDE_TIMEOUT_MS).toBe(3_600_000);
  });
});
