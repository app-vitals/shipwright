/**
 * Tests for agent/src/pricing.ts — calculateCost
 *
 * Pure function tests — no I/O, no mocks needed.
 */

import { describe, expect, test } from "bun:test";
import type { TokenUsage } from "./claude.ts";
import { calculateCost } from "./pricing.ts";

// Sample usage with all four token types
const BASE_USAGE: TokenUsage = {
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

const ZERO_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

describe("calculateCost", () => {
  // ─── Known models — basic input + output ─────────────────────────────────────

  test("claude-fable-5: $10/1M input + $50/1M output", () => {
    // 1M input @ $10 + 1M output @ $50 = $60
    expect(calculateCost(BASE_USAGE, "claude-fable-5")).toBe(60);
  });

  test("claude-opus-4-8: $5/1M input + $25/1M output", () => {
    // 1M input @ $5 + 1M output @ $25 = $30
    expect(calculateCost(BASE_USAGE, "claude-opus-4-8")).toBe(30);
  });

  test("claude-opus-4-7: $5/1M input + $25/1M output", () => {
    expect(calculateCost(BASE_USAGE, "claude-opus-4-7")).toBe(30);
  });

  test("claude-opus-4-6: $5/1M input + $25/1M output", () => {
    expect(calculateCost(BASE_USAGE, "claude-opus-4-6")).toBe(30);
  });

  test("claude-sonnet-4-6: $3/1M input + $15/1M output", () => {
    // 1M input @ $3 + 1M output @ $15 = $18
    expect(calculateCost(BASE_USAGE, "claude-sonnet-4-6")).toBe(18);
  });

  test("claude-haiku-4-5: $1/1M input + $5/1M output", () => {
    // 1M input @ $1 + 1M output @ $5 = $6
    expect(calculateCost(BASE_USAGE, "claude-haiku-4-5")).toBe(6);
  });

  // ─── Unknown model ────────────────────────────────────────────────────────────

  test("unknown model returns exactly 0", () => {
    expect(calculateCost(BASE_USAGE, "claude-unknown-99")).toBe(0);
    expect(calculateCost(BASE_USAGE, "")).toBe(0);
    expect(calculateCost(BASE_USAGE, "gpt-4o")).toBe(0);
  });

  // ─── Cache token types ───────────────────────────────────────────────────────

  test("cache_creation_input_tokens billed at 1.25x input price (sonnet-4-6)", () => {
    // sonnet-4-6 input: $3/1M → cache write: $3 * 1.25 / 1M = $3.75/1M
    // 1M cache_creation tokens @ $3.75 = $3.75
    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    };
    expect(calculateCost(usage, "claude-sonnet-4-6")).toBeCloseTo(3.75, 10);
  });

  test("cache_read_input_tokens billed at 0.1x input price (sonnet-4-6)", () => {
    // sonnet-4-6 input: $3/1M → cache read: $3 * 0.1 / 1M = $0.30/1M
    // 1M cache_read tokens @ $0.30 = $0.30
    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    };
    expect(calculateCost(usage, "claude-sonnet-4-6")).toBeCloseTo(0.3, 10);
  });

  test("all four token types combined (haiku-4-5)", () => {
    // haiku input: $1/1M, output: $5/1M
    // 100k input:        100_000 / 1_000_000 * 1   = 0.10
    // 200k output:       200_000 / 1_000_000 * 5   = 1.00
    // 50k cache_write:    50_000 / 1_000_000 * 1.25 = 0.0625
    // 10k cache_read:     10_000 / 1_000_000 * 0.1  = 0.001
    // total = 1.1635
    const usage: TokenUsage = {
      input_tokens: 100_000,
      output_tokens: 200_000,
      cache_creation_input_tokens: 50_000,
      cache_read_input_tokens: 10_000,
    };
    expect(calculateCost(usage, "claude-haiku-4-5")).toBeCloseTo(1.1635, 10);
  });

  test("zero usage returns 0 for any known model", () => {
    expect(calculateCost(ZERO_USAGE, "claude-sonnet-4-6")).toBe(0);
    expect(calculateCost(ZERO_USAGE, "claude-fable-5")).toBe(0);
  });
});
