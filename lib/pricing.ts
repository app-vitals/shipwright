export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

interface ModelRates {
  input: number;
  output: number;
}

export const OPUS_MODEL = "claude-opus-4-8";

export const RATES: Record<string, ModelRates> = {
  "claude-fable-5": { input: 10.0, output: 50.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-haiku-4-6": { input: 1.0, output: 5.0 },
};

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

export function normalizeModelToRateKey(model: string): string | null {
  const bareModel = model.replace(/-\d{8}$/, "");
  if (
    bareModel === "haiku" ||
    bareModel === "claude-haiku-4-5" ||
    bareModel === "claude-haiku-4-6"
  ) {
    return "claude-haiku-4-5";
  }
  if (bareModel === "sonnet" || bareModel === "claude-sonnet-4-6") {
    return "claude-sonnet-4-6";
  }
  if (
    bareModel === "opus" ||
    bareModel === "claude-opus-4-8" ||
    bareModel === "claude-opus-4-7" ||
    bareModel === "claude-opus-4-6"
  ) {
    return "claude-opus-4-8";
  }
  if (bareModel === "fable" || bareModel === "claude-fable-5") {
    return "claude-fable-5";
  }
  return null;
}
