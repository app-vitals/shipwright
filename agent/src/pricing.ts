import type { TokenUsage } from "./claude.ts";

interface ModelRates {
  input: number; // USD per million tokens
  output: number; // USD per million tokens
}

const RATES: Record<string, ModelRates> = {
  "claude-fable-5": { input: 10.0, output: 50.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

const TOKENS_PER_MILLION = 1_000_000;
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

// Cache write: 1.25x input price; cache read: 0.1x input price (Anthropic API contract).
export function calculateCost(usage: TokenUsage, model: string): number {
  const rates = RATES[model];
  if (!rates) return 0;

  const inputCost = (usage.input_tokens / TOKENS_PER_MILLION) * rates.input;
  const outputCost = (usage.output_tokens / TOKENS_PER_MILLION) * rates.output;
  const cacheWriteCost =
    (usage.cache_creation_input_tokens / TOKENS_PER_MILLION) *
    rates.input *
    CACHE_WRITE_MULTIPLIER;
  const cacheReadCost =
    (usage.cache_read_input_tokens / TOKENS_PER_MILLION) *
    rates.input *
    CACHE_READ_MULTIPLIER;

  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}
