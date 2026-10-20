import { describe, expect, test } from "bun:test";
import { CLAIM_TTL_BUFFER_MS, DEFAULT_CLAIM_TTL_MS } from "./claim-ttl.ts";
import { DEFAULT_CLAUDE_TIMEOUT_MS } from "./claude-timeout.ts";

describe("claim-ttl constants", () => {
  test("CLAIM_TTL_BUFFER_MS is 300_000 (5min)", () => {
    expect(CLAIM_TTL_BUFFER_MS).toBe(300_000);
  });

  test("DEFAULT_CLAIM_TTL_MS is 3_900_000 (65min)", () => {
    expect(DEFAULT_CLAIM_TTL_MS).toBe(3_900_000);
  });

  test("DEFAULT_CLAIM_TTL_MS is computed as the sum of the other two constants", () => {
    expect(DEFAULT_CLAIM_TTL_MS).toBe(
      DEFAULT_CLAUDE_TIMEOUT_MS + CLAIM_TTL_BUFFER_MS,
    );
  });
});
