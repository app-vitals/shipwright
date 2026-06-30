import { describe, expect, test } from "bun:test";
import { OPUS_MODEL, RATES, calculateCost, normalizeModelToRateKey } from "./pricing.ts";

const SAMPLE_USAGE = {
  input_tokens: 100,
  output_tokens: 200,
  cache_read_input_tokens: 50,
  cache_creation_input_tokens: 10,
};

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

describe("OPUS_MODEL", () => {
  test("is the canonical opus key present in RATES", () => {
    expect(OPUS_MODEL).toBe("claude-opus-4-8");
    expect(RATES[OPUS_MODEL]).toBeDefined();
  });
});

describe("calculateCost — non-zero for known keys", () => {
  test("returns non-zero for claude-sonnet-4-6 with sample usage", () => {
    expect(calculateCost(SAMPLE_USAGE, "claude-sonnet-4-6")).toBeGreaterThan(0);
  });

  test("returns non-zero for claude-haiku-4-5 with sample usage", () => {
    expect(calculateCost(SAMPLE_USAGE, "claude-haiku-4-5")).toBeGreaterThan(0);
  });

  test("returns non-zero for claude-opus-4-8 with sample usage", () => {
    expect(calculateCost(SAMPLE_USAGE, "claude-opus-4-8")).toBeGreaterThan(0);
  });

  test("returns 0 for unknown model", () => {
    expect(calculateCost(SAMPLE_USAGE, "gpt-4")).toBe(0);
  });

  test("returns 0 for zero usage", () => {
    expect(calculateCost(ZERO_USAGE, "claude-sonnet-4-6")).toBe(0);
  });
});

describe("normalizeModelToRateKey — haiku family", () => {
  test('"haiku" maps to haiku canonical key', () => {
    expect(normalizeModelToRateKey("haiku")).toBe("claude-haiku-4-5");
  });

  test('"claude-haiku-4-5" maps to haiku canonical key', () => {
    expect(normalizeModelToRateKey("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  test('"claude-haiku-4-6" maps to haiku canonical key', () => {
    expect(normalizeModelToRateKey("claude-haiku-4-6")).toBe("claude-haiku-4-5");
  });
});

describe("normalizeModelToRateKey — sonnet family", () => {
  test('"sonnet" maps to sonnet canonical key', () => {
    expect(normalizeModelToRateKey("sonnet")).toBe("claude-sonnet-4-6");
  });

  test('"claude-sonnet-4-6" maps to sonnet canonical key', () => {
    expect(normalizeModelToRateKey("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });
});

describe("normalizeModelToRateKey — opus family", () => {
  test('"opus" maps to opus canonical key', () => {
    expect(normalizeModelToRateKey("opus")).toBe("claude-opus-4-8");
  });

  test('"claude-opus-4-8" maps to opus canonical key', () => {
    expect(normalizeModelToRateKey("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  test('"claude-opus-4-7" maps to opus canonical key', () => {
    expect(normalizeModelToRateKey("claude-opus-4-7")).toBe("claude-opus-4-8");
  });

  test('"claude-opus-4-6" maps to opus canonical key', () => {
    expect(normalizeModelToRateKey("claude-opus-4-6")).toBe("claude-opus-4-8");
  });
});

describe("normalizeModelToRateKey — fable family", () => {
  test('"fable" maps to fable canonical key', () => {
    expect(normalizeModelToRateKey("fable")).toBe("claude-fable-5");
  });

  test('"claude-fable-5" maps to fable canonical key', () => {
    expect(normalizeModelToRateKey("claude-fable-5")).toBe("claude-fable-5");
  });
});

describe("normalizeModelToRateKey — unknown inputs", () => {
  test('"unknown-model" returns null', () => {
    expect(normalizeModelToRateKey("unknown-model")).toBeNull();
  });

  test('empty string returns null', () => {
    expect(normalizeModelToRateKey("")).toBeNull();
  });

  test('"gpt-4" returns null', () => {
    expect(normalizeModelToRateKey("gpt-4")).toBeNull();
  });
});
