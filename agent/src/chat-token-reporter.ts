/**
 * ChatTokenReporter — reports per-session Slack chat token usage to the admin
 * daily-upsert endpoint: POST /agents/:agentId/chat-tokens/daily.
 *
 * Each completed Slack session (DM, mention, or reaction) POSTs its accumulated
 * token counts broken down by model; the admin endpoint accumulates rows
 * atomically per (agent, date, model).
 *
 * HttpChatTokenReporter: production implementation, fire-and-forget (never throws).
 * NoopChatTokenReporter: testing / default when the admin API is not configured.
 */

import type { ModelUsage, TokenUsage } from "./claude.ts";
import { liveClaudeConfig } from "./claude.ts";
import { type Clock, SystemClock } from "./clock.ts";
import { calculateCost } from "./pricing.ts";

/**
 * Format a Date as YYYY-MM-DD in an IANA timezone.
 *
 * Uses the `en-CA` locale, which renders dates as YYYY-MM-DD. When `timeZone`
 * is undefined, the process-local zone (the "agent timezone") is used.
 */
export function formatDailyDate(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export interface ChatTokenReporter {
  /** Called at Slack session completion. No-op when usage is undefined. */
  recordSession(
    usage: TokenUsage | undefined,
    totalCostUsd?: number,
    modelUsage?: ModelUsage,
  ): Promise<void>;
}

export interface HttpChatTokenReporterOptions {
  apiUrl: string;
  agentId: string;
  apiKey: string;
  clock?: Clock;
  timeZone?: string;
}

export class HttpChatTokenReporter implements ChatTokenReporter {
  private readonly clock: Clock;
  private readonly timeZone?: string;

  constructor(private opts: HttpChatTokenReporterOptions) {
    this.clock = opts.clock ?? SystemClock();
    this.timeZone = opts.timeZone;
  }

  async recordSession(
    usage: TokenUsage | undefined,
    totalCostUsd?: number,
    modelUsage?: ModelUsage,
  ): Promise<void> {
    if (usage === undefined) return;

    const { apiUrl, agentId, apiKey } = this.opts;
    const url = `${apiUrl}/agents/${agentId}/chat-tokens/daily`;

    const date = formatDailyDate(this.clock.now(), this.timeZone);

    // Build modelBreakdown from modelUsage when provided.
    // When modelUsage is absent, fall back to a single entry using the live model.
    let modelBreakdown: Array<{
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      costUsd: number;
    }>;

    if (modelUsage && Object.keys(modelUsage).length > 0) {
      modelBreakdown = Object.entries(modelUsage).map(([model, mu]) => ({
        model,
        inputTokens: mu.input_tokens,
        outputTokens: mu.output_tokens,
        cacheReadTokens: mu.cache_read_input_tokens,
        cacheCreationTokens: mu.cache_creation_input_tokens,
        // Allocate cost proportionally by output tokens when individual model
        // costs are unavailable; fall back to full session cost for the single model.
        costUsd: totalCostUsd !== undefined
          ? allocateCost(totalCostUsd, model, modelUsage)
          : calculateCost(mu, model),
      }));
    } else {
      modelBreakdown = [
        {
          model: liveClaudeConfig.model,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          cacheCreationTokens: usage.cache_creation_input_tokens,
          costUsd: totalCostUsd ?? calculateCost(usage, liveClaudeConfig.model),
        },
      ];
    }

    const body = { date, modelBreakdown };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.warn(
          `[chat-token-reporter] POST ${url} returned ${res.status} — swallowing`,
        );
      }
    } catch (err) {
      console.warn(
        `[chat-token-reporter] POST ${url} failed: ${String(err)} — swallowing`,
      );
    }
  }
}

/**
 * Allocate total session cost proportionally to a model by its share of output tokens.
 * Falls back to calculateCost when total output is zero.
 */
function allocateCost(
  totalCostUsd: number,
  model: string,
  modelUsage: ModelUsage,
): number {
  const totalOutput = Object.values(modelUsage).reduce(
    (sum, u) => sum + u.output_tokens,
    0,
  );
  if (totalOutput === 0) {
    const mu = modelUsage[model];
    return mu ? calculateCost(mu, model) : 0;
  }
  const modelOutput = modelUsage[model]?.output_tokens ?? 0;
  return totalCostUsd * (modelOutput / totalOutput);
}

export class NoopChatTokenReporter implements ChatTokenReporter {
  async recordSession(
    _usage: TokenUsage | undefined,
    _totalCostUsd?: number,
    _modelUsage?: ModelUsage,
  ): Promise<void> {
    // intentional no-op
  }
}
