import { describe, expect, test } from "bun:test";
import { DEFAULT_CLAIM_TTL_MS } from "./claim-ttl.ts";
import { DEFAULT_CLAUDE_TIMEOUT_MS } from "./claude-timeout.ts";

describe("claude-timeout", () => {
  test("DEFAULT_CLAUDE_TIMEOUT_MS is 3_600_000 (1hr hard ceiling)", () => {
    expect(DEFAULT_CLAUDE_TIMEOUT_MS).toBe(3_600_000);
  });

  test("DEFAULT_CLAIM_TTL_MS exceeds DEFAULT_CLAUDE_TIMEOUT_MS", () => {
    expect(DEFAULT_CLAIM_TTL_MS).toBeGreaterThan(DEFAULT_CLAUDE_TIMEOUT_MS);
  });
});
