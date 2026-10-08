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
  "claude-fable-5-1": { input: 10.0, output: 50.0 },
  "claude-fable-5": { input: 10.0, output: 50.0 },
  "claude-opus-5-5": { input: 4.0, output: 20.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-haiku-4-6": { input: 1.0, output: 5.0 },
};

/**
 * Context window (input tokens) per rate key. Used by the prompt-audit
 * tooling to express always-loaded context as a share of the window and to
 * size the skill-listing budget (Claude Code reserves 1% of the window for
 * the skill listing). Keys mirror RATES.
 */
export const CONTEXT_WINDOW: Record<string, number> = {
  "claude-fable-5-1": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-opus-5-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-5-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-5-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4-6": 200_000,
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
  // Current-generation ids price as themselves. The bare "sonnet"/"opus"/
  // "haiku" aliases below deliberately still resolve to the 4.x keys: the
  // fleet default is claude-sonnet-4-6 and the alias mapping moves with the
  // measured model bump, not here.
  if (
    bareModel === "claude-fable-5-1" ||
    bareModel === "claude-opus-5-5" ||
    bareModel === "claude-sonnet-5-5" ||
    bareModel === "claude-haiku-5-5"
  ) {
    return bareModel;
  }
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
