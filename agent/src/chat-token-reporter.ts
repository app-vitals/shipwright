/**
 * ChatTokenReporter — reports per-session Slack chat token usage to the admin
 * daily-upsert endpoint (MME-1.2): POST /agents/:agentId/chat-tokens/daily.
 *
 * Each completed Slack session (DM, mention, or reaction) POSTs its accumulated
 * token counts; the admin endpoint accumulates rows atomically per (agent, date).
 *
 * HttpChatTokenReporter: production implementation, fire-and-forget (never throws).
 * NoopChatTokenReporter: testing / default when the admin API is not configured.
 */

import { liveClaudeConfig } from "./claude.ts";
import type { TokenUsage } from "./claude.ts";
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
  recordSession(usage: TokenUsage | undefined): Promise<void>;
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

  async recordSession(usage: TokenUsage | undefined): Promise<void> {
    if (usage === undefined) return;

    const { apiUrl, agentId, apiKey } = this.opts;
    const url = `${apiUrl}/agents/${agentId}/chat-tokens/daily`;
    const model = liveClaudeConfig.model;

    const body = {
      date: formatDailyDate(this.clock.now(), this.timeZone),
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens,
      costUsd: calculateCost(usage, model),
    };

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

export class NoopChatTokenReporter implements ChatTokenReporter {
  async recordSession(_usage: TokenUsage | undefined): Promise<void> {
    // intentional no-op
  }
}
