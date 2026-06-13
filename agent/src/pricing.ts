/**
 * Per-model USD pricing table and cost calculation utility.
 *
 * Rates are USD per million tokens.
 * Cache write = 1.25× input rate; cache read = 0.1× input rate.
 */

import type { TokenUsage } from "./claude.ts";

interface ModelRates {
  input: number;
  output: number;
}

export const RATES: Record<string, ModelRates> = {
  "claude-fable-5": { input: 10.0, output: 50.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

/**
 * Calculate the USD cost of a Claude API call.
 *
 * Returns 0 for unknown models.
 */
export function calculateCost(usage: TokenUsage, model: string): number {
  const rates = RATES[model];
  if (!rates) return 0;

  const { input, output } = rates;
  const cost =
    usage.input_tokens * input +
    usage.output_tokens * output +
    usage.cache_creation_input_tokens * input * 1.25 +
    usage.cache_read_input_tokens * input * 0.1;

  return cost / 1_000_000;
}
