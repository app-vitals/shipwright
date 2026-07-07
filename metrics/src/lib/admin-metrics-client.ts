/**
 * metrics/src/lib/admin-metrics-client.ts
 * Slim read-only HTTP client for the admin token-aggregation endpoints.
 *
 * The metrics TaskStoreProvider sources its `tokens*` metric kinds from two
 * disjoint admin data sources:
 *   - cron-run tokens  (AgentCronRun)                      → the "cron"  session source
 *   - chat daily tokens (AgentChatTokenUsageDailyByModel)   → the "chat" session source
 * These two buckets never overlap, so summing them is the correct, no-double-
 * counting total. The admin server returns already-grouped aggregates; this
 * client just shuttles them. Mirrors accounts-client.ts (Bearer auth, trailing-
 * slash strip, typed error).
 */

// ─── Token aggregate shapes ───────────────────────────────────────────────────

/** A single rolled-up token aggregate. `costUsd` present where the source has it. */
export interface TokenAggregate {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
  costUsd?: number;
}

/** A token aggregate keyed by a grouping value (agent id, cron name, model, …). */
export interface KeyedTokenAggregate extends TokenAggregate {
  key: string;
}

/** A token aggregate keyed by two grouping values. */
export interface DoubleKeyedTokenAggregate extends TokenAggregate {
  key1: string;
  key2: string;
}

/** A token aggregate bucketed by day (YYYY-MM-DD). */
export interface DailyTokenAggregate extends TokenAggregate {
  period: string;
}

/** Cron-run-sourced stats: carries per-cron + per-model groupings. */
export interface CronRunTokenStats {
  totals: TokenAggregate;
  byAgent: KeyedTokenAggregate[];
  byCron: DoubleKeyedTokenAggregate[]; // key1=agentId, key2=cronName
  byModel: DoubleKeyedTokenAggregate[]; // key1=agentId, key2=model
  daily: DailyTokenAggregate[];
  byCronModel: DoubleKeyedTokenAggregate[]; // key1=agentId:cronName, key2=model
}

/** Chat-daily-sourced stats: per-agent + per-model + daily. */
export interface ChatTokenStats {
  totals: TokenAggregate;
  byAgent: KeyedTokenAggregate[];
  byModel: DoubleKeyedTokenAggregate[]; // key1=agentId, key2=model
  daily: DailyTokenAggregate[];
}

// ─── Error type ───────────────────────────────────────────────────────────────

export class AdminMetricsClientError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(`[${statusCode}] ${message}`);
    this.name = "AdminMetricsClientError";
  }
}

// ─── Slim interface ───────────────────────────────────────────────────────────

export interface AdminMetricsClient {
  cronRunTokenStats(params: {
    from?: string;
    to?: string;
  }): Promise<CronRunTokenStats>;
  chatTokenStats(params: {
    from?: string;
    to?: string;
  }): Promise<ChatTokenStats>;
}

// ─── HTTP implementation ──────────────────────────────────────────────────────

/** Minimal `fetch` shape — injectable so the client is testable without
 * overriding any global (Bun shares the test process). Defaults to the
 * platform `fetch`. Mirrors task-store-client.ts's `FetchLike`. */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export class HttpAdminMetricsClient implements AdminMetricsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, apiKey: string, fetchImpl?: FetchLike) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private async fetch<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new AdminMetricsClientError(
        res.status,
        await res.text().catch(() => "unknown error"),
      );
    }
    return res.json() as Promise<T>;
  }

  private static query(params: Record<string, string | undefined>): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, v);
    }
    const s = qs.toString();
    return s ? `?${s}` : "";
  }

  async cronRunTokenStats(params: {
    from?: string;
    to?: string;
  }): Promise<CronRunTokenStats> {
    // Aggregated across all agents server-side; `:id` reserved for future scope.
    return this.fetch<CronRunTokenStats>(
      `/agents/all/cron-runs/stats${HttpAdminMetricsClient.query(params)}`,
    );
  }

  async chatTokenStats(params: {
    from?: string;
    to?: string;
  }): Promise<ChatTokenStats> {
    // The chat-tokens endpoint uses z.string().date() (YYYY-MM-DD) — the
    // underlying table is date-only. Slice any ISO datetime strings to the
    // date portion before forwarding so the schema accepts them.
    const dateParams = {
      from: params.from ? params.from.slice(0, 10) : undefined,
      to: params.to ? params.to.slice(0, 10) : undefined,
    };
    return this.fetch<ChatTokenStats>(
      `/agents/chat-tokens/daily/stats${HttpAdminMetricsClient.query(dateParams)}`,
    );
  }
}
