/**
 * Unit tests for agent/src/pricing.ts — calculateCost()
 *
 * Pure function — no side effects, no mocks needed.
 */

import { describe, expect, test } from "bun:test";
import type { TokenUsage } from "./claude.ts";
import { calculateCost } from "./pricing.ts";

const SAMPLE_USAGE: TokenUsage = {
  input_tokens: 100,
  output_tokens: 200,
  cache_read_input_tokens: 50,
  cache_creation_input_tokens: 10,
};

const ZERO_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

// ─── unknown model ─────────────────────────────────────────────────────────────

describe("unknown model", () => {
  test("returns 0 for an unrecognised model ID", () => {
    expect(calculateCost(SAMPLE_USAGE, "claude-sonnet-4-5")).toBe(0);
  });

  test("returns 0 for empty string model ID", () => {
    expect(calculateCost(SAMPLE_USAGE, "")).toBe(0);
  });

  test("returns 0 for zero usage with unknown model", () => {
    expect(calculateCost(ZERO_USAGE, "gpt-4")).toBe(0);
  });
});

// ─── claude-sonnet-4-6 ($3.00 input, $15.00 output) ──────────────────────────

describe("claude-sonnet-4-6", () => {
  test("returns correct USD for SAMPLE_USAGE", () => {
    // (100 * 3.00 + 200 * 15.00 + 10 * 3.00 * 1.25 + 50 * 3.00 * 0.1) / 1_000_000
    // = (300 + 3000 + 37.5 + 15) / 1_000_000 = 0.0033525
    expect(calculateCost(SAMPLE_USAGE, "claude-sonnet-4-6")).toBe(0.0033525);
  });

  test("returns 0 for zero usage", () => {
    expect(calculateCost(ZERO_USAGE, "claude-sonnet-4-6")).toBe(0);
  });
});

// ─── claude-haiku-4-5 ($1.00 input, $5.00 output) ────────────────────────────

describe("claude-haiku-4-5", () => {
  test("returns correct USD for SAMPLE_USAGE", () => {
    // (100 * 1.00 + 200 * 5.00 + 10 * 1.00 * 1.25 + 50 * 1.00 * 0.1) / 1_000_000
    // = (100 + 1000 + 12.5 + 5) / 1_000_000 = 0.0011175
    expect(calculateCost(SAMPLE_USAGE, "claude-haiku-4-5")).toBe(0.0011175);
  });
});

// ─── claude-opus-4-8 ($5.00 input, $25.00 output) ────────────────────────────

describe("claude-opus-4-8", () => {
  test("returns correct USD for SAMPLE_USAGE", () => {
    // (100 * 5.00 + 200 * 25.00 + 10 * 5.00 * 1.25 + 50 * 5.00 * 0.1) / 1_000_000
    // = (500 + 5000 + 62.5 + 25) / 1_000_000 = 0.0055875
    expect(calculateCost(SAMPLE_USAGE, "claude-opus-4-8")).toBe(0.0055875);
  });
});

// ─── claude-opus-4-7 ($5.00 input, $25.00 output) ────────────────────────────

describe("claude-opus-4-7", () => {
  test("returns correct USD for SAMPLE_USAGE (same rates as opus-4-8)", () => {
    expect(calculateCost(SAMPLE_USAGE, "claude-opus-4-7")).toBe(0.0055875);
  });
});

// ─── claude-opus-4-6 ($5.00 input, $25.00 output) ────────────────────────────

describe("claude-opus-4-6", () => {
  test("returns correct USD for SAMPLE_USAGE (same rates as opus-4-8)", () => {
    expect(calculateCost(SAMPLE_USAGE, "claude-opus-4-6")).toBe(0.0055875);
  });
});

// ─── claude-fable-5 ($10.00 input, $50.00 output) ────────────────────────────

describe("claude-fable-5", () => {
  test("returns correct USD for SAMPLE_USAGE", () => {
    // (100 * 10.00 + 200 * 50.00 + 10 * 10.00 * 1.25 + 50 * 10.00 * 0.1) / 1_000_000
    // = (1000 + 10000 + 125 + 50) / 1_000_000 = 0.011175
    expect(calculateCost(SAMPLE_USAGE, "claude-fable-5")).toBe(0.011175);
  });
});

// ─── cache multipliers ────────────────────────────────────────────────────────

describe("cache multipliers", () => {
  test("cache_creation_input_tokens uses 1.25x input rate", () => {
    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    };
    // claude-sonnet-4-6 input = $3.00/M, cache write = 3.00 * 1.25 = $3.75/M
    // 1_000_000 * 3.75 / 1_000_000 = 3.75
    expect(calculateCost(usage, "claude-sonnet-4-6")).toBe(3.75);
  });

  test("cache_read_input_tokens uses 0.1x input rate", () => {
    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    };
    // claude-sonnet-4-6 input = $3.00/M, cache read = 3.00 * 0.1 = $0.30/M
    // 1_000_000 * 0.30 / 1_000_000 = 0.30
    expect(calculateCost(usage, "claude-sonnet-4-6")).toBe(0.3);
  });

  test("input_tokens only (no cache) charges at base input rate", () => {
    const usage: TokenUsage = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    // claude-haiku-4-5: $1.00/M input
    expect(calculateCost(usage, "claude-haiku-4-5")).toBe(1.0);
  });

  test("output_tokens only charges at output rate", () => {
    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    // claude-haiku-4-5: $5.00/M output
    expect(calculateCost(usage, "claude-haiku-4-5")).toBe(5.0);
  });
});
