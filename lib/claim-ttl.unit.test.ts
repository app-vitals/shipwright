import { describe, expect, test } from "bun:test";
import { CLAIM_TTL_BUFFER_MS, DEFAULT_CLAIM_TTL_MS, DEFAULT_CLAUDE_TIMEOUT_MS } from "./claim-ttl.ts";

describe("claim-ttl constants", () => {
  test("DEFAULT_CLAUDE_TIMEOUT_MS is 1_800_000 (30min)", () => {
    expect(DEFAULT_CLAUDE_TIMEOUT_MS).toBe(1_800_000);
  });

  test("CLAIM_TTL_BUFFER_MS is 300_000 (5min)", () => {
    expect(CLAIM_TTL_BUFFER_MS).toBe(300_000);
  });

  test("DEFAULT_CLAIM_TTL_MS is 2_100_000 (35min)", () => {
    expect(DEFAULT_CLAIM_TTL_MS).toBe(2_100_000);
  });

  test("DEFAULT_CLAIM_TTL_MS is computed as the sum of the other two constants", () => {
    expect(DEFAULT_CLAIM_TTL_MS).toBe(DEFAULT_CLAUDE_TIMEOUT_MS + CLAIM_TTL_BUFFER_MS);
  });
});
