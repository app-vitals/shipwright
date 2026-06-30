/**
 * admin/src/agent-cron-run-stats.ts
 * AgentCronRunStatsService — aggregates AgentCronRun token columns into five
 * dimensions: totals, byAgent, byCron (with AgentCronJob name JOIN), byModel,
 * and daily (DATE(startedAt)).
 *
 * Skipped runs (skipped=true) are always excluded from all aggregations.
 * Uses $queryRaw for all five dimensions — Prisma groupBy doesn't support the
 * LEFT JOIN needed for byCron.
 */

import type { PrismaClient } from "../prisma/client/index.js";

// ─── Types (mirrored from metrics/src/lib/admin-metrics-client.ts) ───────────
// These types are defined here to keep admin self-contained (rootDir constraint).
// The shapes must stay in sync with the interfaces in admin-metrics-client.ts.

export interface TokenAggregate {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
  costUsd?: number;
}

export interface KeyedTokenAggregate extends TokenAggregate {
  key: string;
}

export interface DoubleKeyedTokenAggregate extends TokenAggregate {
  key1: string;
  key2: string;
}

export interface DailyTokenAggregate extends TokenAggregate {
  period: string;
}

export interface CronRunTokenStats {
  totals: TokenAggregate;
  byAgent: KeyedTokenAggregate[];
  byCron: DoubleKeyedTokenAggregate[];
  byModel: DoubleKeyedTokenAggregate[];
  daily: DailyTokenAggregate[];
}

// ─── Raw row types from $queryRaw ────────────────────────────────────────────

interface TotalsRow {
  input: bigint | null;
  output: bigint | null;
  cache_read: bigint | null;
  cache_creation: bigint | null;
  cost_usd: number | null;
}

interface ByAgentRow {
  agent_id: string;
  input: bigint | null;
  output: bigint | null;
  cache_read: bigint | null;
  cache_creation: bigint | null;
  cost_usd: number | null;
}

interface ByCronRow {
  agent_id: string;
  cron_id: string;
  cron_name: string | null;
  input: bigint | null;
  output: bigint | null;
  cache_read: bigint | null;
  cache_creation: bigint | null;
  cost_usd: number | null;
}

interface ByModelRow {
  agent_id: string;
  model: string;
  input: bigint | null;
  output: bigint | null;
  cache_read: bigint | null;
  cache_creation: bigint | null;
  cost_usd: number | null;
}

interface DailyRow {
  period: string;
  input: bigint | null;
  output: bigint | null;
  cache_read: bigint | null;
  cache_creation: bigint | null;
  cost_usd: number | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function num(v: bigint | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return Number(v);
}

function toAggregate(row: {
  input: bigint | null;
  output: bigint | null;
  cache_read: bigint | null;
  cache_creation: bigint | null;
  cost_usd: number | null;
}): TokenAggregate {
  const input = num(row.input);
  const output = num(row.output);
  const cacheRead = num(row.cache_read);
  const cacheCreation = num(row.cache_creation);
  const result: TokenAggregate = {
    input,
    output,
    cacheRead,
    cacheCreation,
    total: input + output + cacheRead + cacheCreation,
  };
  if (row.cost_usd !== null) {
    result.costUsd = row.cost_usd;
  }
  return result;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class AgentCronRunStatsService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Aggregate cron-run token stats into five dimensions.
   *
   * @param from  ISO string — if provided, only runs with startedAt >= from
   * @param to    ISO string — if provided, only runs with startedAt <  to
   */
  async query(from?: string, to?: string): Promise<CronRunTokenStats> {
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;

    const [totalsRows, byAgentRows, byCronRows, byModelRows, dailyRows] =
      await Promise.all([
        this.queryTotals(fromDate, toDate),
        this.queryByAgent(fromDate, toDate),
        this.queryByCron(fromDate, toDate),
        this.queryByModel(fromDate, toDate),
        this.queryDaily(fromDate, toDate),
      ]);

    // totals: single row (or null if no runs)
    const totalsRow = totalsRows[0];
    const totals: TokenAggregate = totalsRow
      ? toAggregate(totalsRow)
      : { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };

    const byAgent: KeyedTokenAggregate[] = byAgentRows.map((row) => ({
      ...toAggregate(row),
      key: row.agent_id,
    }));

    const byCron: DoubleKeyedTokenAggregate[] = byCronRows.map((row) => ({
      ...toAggregate(row),
      key1: row.agent_id,
      key2: row.cron_name ?? row.cron_id,
    }));

    const byModel: DoubleKeyedTokenAggregate[] = byModelRows.map((row) => ({
      ...toAggregate(row),
      key1: row.agent_id,
      key2: row.model,
    }));

    const daily: DailyTokenAggregate[] = dailyRows.map((row) => ({
      ...toAggregate(row),
      period: row.period,
    }));

    return { totals, byAgent, byCron, byModel, daily };
  }

  // ─── Private query methods ──────────────────────────────────────────────────

  private async queryTotals(
    from: Date | null,
    to: Date | null,
  ): Promise<TotalsRow[]> {
    if (from !== null && to !== null) {
      return this.prisma.$queryRaw<TotalsRow[]>`
        SELECT
          SUM("inputTokens")         AS input,
          SUM("outputTokens")        AS output,
          SUM("cacheReadTokens")     AS cache_read,
          SUM("cacheCreationTokens") AS cache_creation,
          SUM("costUsd")             AS cost_usd
        FROM "AgentCronRun"
        WHERE skipped = false
          AND "startedAt" >= ${from}
          AND "startedAt" < ${to}
      `;
    }
    if (from !== null) {
      return this.prisma.$queryRaw<TotalsRow[]>`
        SELECT
          SUM("inputTokens")         AS input,
          SUM("outputTokens")        AS output,
          SUM("cacheReadTokens")     AS cache_read,
          SUM("cacheCreationTokens") AS cache_creation,
          SUM("costUsd")             AS cost_usd
        FROM "AgentCronRun"
        WHERE skipped = false
          AND "startedAt" >= ${from}
      `;
    }
    if (to !== null) {
      return this.prisma.$queryRaw<TotalsRow[]>`
        SELECT
          SUM("inputTokens")         AS input,
          SUM("outputTokens")        AS output,
          SUM("cacheReadTokens")     AS cache_read,
          SUM("cacheCreationTokens") AS cache_creation,
          SUM("costUsd")             AS cost_usd
        FROM "AgentCronRun"
        WHERE skipped = false
          AND "startedAt" < ${to}
      `;
    }
    return this.prisma.$queryRaw<TotalsRow[]>`
      SELECT
        SUM("inputTokens")         AS input,
        SUM("outputTokens")        AS output,
        SUM("cacheReadTokens")     AS cache_read,
        SUM("cacheCreationTokens") AS cache_creation,
        SUM("costUsd")             AS cost_usd
      FROM "AgentCronRun"
      WHERE skipped = false
    `;
  }

  private async queryByAgent(
    from: Date | null,
    to: Date | null,
  ): Promise<ByAgentRow[]> {
    if (from !== null && to !== null) {
      return this.prisma.$queryRaw<ByAgentRow[]>`
        SELECT
          "agentId"                  AS agent_id,
          SUM("inputTokens")         AS input,
          SUM("outputTokens")        AS output,
          SUM("cacheReadTokens")     AS cache_read,
          SUM("cacheCreationTokens") AS cache_creation,
          SUM("costUsd")             AS cost_usd
        FROM "AgentCronRun"
        WHERE skipped = false
          AND "startedAt" >= ${from}
          AND "startedAt" < ${to}
        GROUP BY "agentId"
        ORDER BY "agentId"
      `;
    }
    if (from !== null) {
      return this.prisma.$queryRaw<ByAgentRow[]>`
        SELECT
          "agentId"                  AS agent_id,
          SUM("inputTokens")         AS input,
          SUM("outputTokens")        AS output,
          SUM("cacheReadTokens")     AS cache_read,
          SUM("cacheCreationTokens") AS cache_creation,
          SUM("costUsd")             AS cost_usd
        FROM "AgentCronRun"
        WHERE skipped = false
          AND "startedAt" >= ${from}
        GROUP BY "agentId"
        ORDER BY "agentId"
      `;
    }
    if (to !== null) {
      return this.prisma.$queryRaw<ByAgentRow[]>`
        SELECT
          "agentId"                  AS agent_id,
          SUM("inputTokens")         AS input,
          SUM("outputTokens")        AS output,
          SUM("cacheReadTokens")     AS cache_read,
          SUM("cacheCreationTokens") AS cache_creation,
          SUM("costUsd")             AS cost_usd
        FROM "AgentCronRun"
        WHERE skipped = false
          AND "startedAt" < ${to}
        GROUP BY "agentId"
        ORDER BY "agentId"
      `;
    }
    return this.prisma.$queryRaw<ByAgentRow[]>`
      SELECT
        "agentId"                  AS agent_id,
        SUM("inputTokens")         AS input,
        SUM("outputTokens")        AS output,
        SUM("cacheReadTokens")     AS cache_read,
        SUM("cacheCreationTokens") AS cache_creation,
        SUM("costUsd")             AS cost_usd
      FROM "AgentCronRun"
      WHERE skipped = false
      GROUP BY "agentId"
      ORDER BY "agentId"
    `;
  }

  private async queryByCron(
    from: Date | null,
    to: Date | null,
  ): Promise<ByCronRow[]> {
    if (from !== null && to !== null) {
      return this.prisma.$queryRaw<ByCronRow[]>`
        SELECT
          r."agentId"                  AS agent_id,
          r."cronId"                   AS cron_id,
          j.name                       AS cron_name,
          SUM(r."inputTokens")         AS input,
          SUM(r."outputTokens")        AS output,
          SUM(r."cacheReadTokens")     AS cache_read,
          SUM(r."cacheCreationTokens") AS cache_creation,
          SUM(r."costUsd")             AS cost_usd
        FROM "AgentCronRun" r
        LEFT JOIN "AgentCronJob" j ON j.id = r."cronId"
        WHERE r.skipped = false
          AND r."startedAt" >= ${from}
          AND r."startedAt" < ${to}
        GROUP BY r."agentId", r."cronId", j.name
        ORDER BY r."agentId", r."cronId"
      `;
    }
    if (from !== null) {
      return this.prisma.$queryRaw<ByCronRow[]>`
        SELECT
          r."agentId"                  AS agent_id,
          r."cronId"                   AS cron_id,
          j.name                       AS cron_name,
          SUM(r."inputTokens")         AS input,
          SUM(r."outputTokens")        AS output,
          SUM(r."cacheReadTokens")     AS cache_read,
          SUM(r."cacheCreationTokens") AS cache_creation,
          SUM(r."costUsd")             AS cost_usd
        FROM "AgentCronRun" r
        LEFT JOIN "AgentCronJob" j ON j.id = r."cronId"
        WHERE r.skipped = false
          AND r."startedAt" >= ${from}
        GROUP BY r."agentId", r."cronId", j.name
        ORDER BY r."agentId", r."cronId"
      `;
    }
    if (to !== null) {
      return this.prisma.$queryRaw<ByCronRow[]>`
        SELECT
          r."agentId"                  AS agent_id,
          r."cronId"                   AS cron_id,
          j.name                       AS cron_name,
          SUM(r."inputTokens")         AS input,
          SUM(r."outputTokens")        AS output,
          SUM(r."cacheReadTokens")     AS cache_read,
          SUM(r."cacheCreationTokens") AS cache_creation,
          SUM(r."costUsd")             AS cost_usd
        FROM "AgentCronRun" r
        LEFT JOIN "AgentCronJob" j ON j.id = r."cronId"
        WHERE r.skipped = false
          AND r."startedAt" < ${to}
        GROUP BY r."agentId", r."cronId", j.name
        ORDER BY r."agentId", r."cronId"
      `;
    }
    return this.prisma.$queryRaw<ByCronRow[]>`
      SELECT
        r."agentId"                  AS agent_id,
        r."cronId"                   AS cron_id,
        j.name                       AS cron_name,
        SUM(r."inputTokens")         AS input,
        SUM(r."outputTokens")        AS output,
        SUM(r."cacheReadTokens")     AS cache_read,
        SUM(r."cacheCreationTokens") AS cache_creation,
        SUM(r."costUsd")             AS cost_usd
      FROM "AgentCronRun" r
      LEFT JOIN "AgentCronJob" j ON j.id = r."cronId"
      WHERE r.skipped = false
      GROUP BY r."agentId", r."cronId", j.name
      ORDER BY r."agentId", r."cronId"
    `;
  }

  private async queryByModel(
    from: Date | null,
    to: Date | null,
  ): Promise<ByModelRow[]> {
    if (from !== null && to !== null) {
      return this.prisma.$queryRaw<ByModelRow[]>`
        SELECT
          "agentId"                  AS agent_id,
          model,
          SUM("inputTokens")         AS input,
          SUM("outputTokens")        AS output,
          SUM("cacheReadTokens")     AS cache_read,
          SUM("cacheCreationTokens") AS cache_creation,
          SUM("costUsd")             AS cost_usd
        FROM "AgentCronRun"
        WHERE skipped = false
          AND model IS NOT NULL
          AND "startedAt" >= ${from}
          AND "startedAt" < ${to}
        GROUP BY "agentId", model
        ORDER BY "agentId", model
      `;
    }
    if (from !== null) {
      return this.prisma.$queryRaw<ByModelRow[]>`
        SELECT
          "agentId"                  AS agent_id,
          model,
          SUM("inputTokens")         AS input,
          SUM("outputTokens")        AS output,
          SUM("cacheReadTokens")     AS cache_read,
          SUM("cacheCreationTokens") AS cache_creation,
          SUM("costUsd")             AS cost_usd
        FROM "AgentCronRun"
        WHERE skipped = false
          AND model IS NOT NULL
          AND "startedAt" >= ${from}
        GROUP BY "agentId", model
        ORDER BY "agentId", model
      `;
    }
    if (to !== null) {
      return this.prisma.$queryRaw<ByModelRow[]>`
        SELECT
          "agentId"                  AS agent_id,
          model,
          SUM("inputTokens")         AS input,
          SUM("outputTokens")        AS output,
          SUM("cacheReadTokens")     AS cache_read,
          SUM("cacheCreationTokens") AS cache_creation,
          SUM("costUsd")             AS cost_usd
        FROM "AgentCronRun"
        WHERE skipped = false
          AND model IS NOT NULL
          AND "startedAt" < ${to}
        GROUP BY "agentId", model
        ORDER BY "agentId", model
      `;
    }
    return this.prisma.$queryRaw<ByModelRow[]>`
      SELECT
        "agentId"                  AS agent_id,
        model,
        SUM("inputTokens")         AS input,
        SUM("outputTokens")        AS output,
        SUM("cacheReadTokens")     AS cache_read,
        SUM("cacheCreationTokens") AS cache_creation,
        SUM("costUsd")             AS cost_usd
      FROM "AgentCronRun"
      WHERE skipped = false
        AND model IS NOT NULL
      GROUP BY "agentId", model
      ORDER BY "agentId", model
    `;
  }

  private async queryDaily(
    from: Date | null,
    to: Date | null,
  ): Promise<DailyRow[]> {
    if (from !== null && to !== null) {
      return this.prisma.$queryRaw<DailyRow[]>`
        SELECT
          TO_CHAR(DATE("startedAt"), 'YYYY-MM-DD') AS period,
          SUM("inputTokens")         AS input,
          SUM("outputTokens")        AS output,
          SUM("cacheReadTokens")     AS cache_read,
          SUM("cacheCreationTokens") AS cache_creation,
          SUM("costUsd")             AS cost_usd
        FROM "AgentCronRun"
        WHERE skipped = false
          AND "startedAt" >= ${from}
          AND "startedAt" < ${to}
        GROUP BY DATE("startedAt")
        ORDER BY DATE("startedAt")
      `;
    }
    if (from !== null) {
      return this.prisma.$queryRaw<DailyRow[]>`
        SELECT
          TO_CHAR(DATE("startedAt"), 'YYYY-MM-DD') AS period,
          SUM("inputTokens")         AS input,
          SUM("outputTokens")        AS output,
          SUM("cacheReadTokens")     AS cache_read,
          SUM("cacheCreationTokens") AS cache_creation,
          SUM("costUsd")             AS cost_usd
        FROM "AgentCronRun"
        WHERE skipped = false
          AND "startedAt" >= ${from}
        GROUP BY DATE("startedAt")
        ORDER BY DATE("startedAt")
      `;
    }
    if (to !== null) {
      return this.prisma.$queryRaw<DailyRow[]>`
        SELECT
          TO_CHAR(DATE("startedAt"), 'YYYY-MM-DD') AS period,
          SUM("inputTokens")         AS input,
          SUM("outputTokens")        AS output,
          SUM("cacheReadTokens")     AS cache_read,
          SUM("cacheCreationTokens") AS cache_creation,
          SUM("costUsd")             AS cost_usd
        FROM "AgentCronRun"
        WHERE skipped = false
          AND "startedAt" < ${to}
        GROUP BY DATE("startedAt")
        ORDER BY DATE("startedAt")
      `;
    }
    return this.prisma.$queryRaw<DailyRow[]>`
      SELECT
        TO_CHAR(DATE("startedAt"), 'YYYY-MM-DD') AS period,
        SUM("inputTokens")         AS input,
        SUM("outputTokens")        AS output,
        SUM("cacheReadTokens")     AS cache_read,
        SUM("cacheCreationTokens") AS cache_creation,
        SUM("costUsd")             AS cost_usd
      FROM "AgentCronRun"
      WHERE skipped = false
      GROUP BY DATE("startedAt")
      ORDER BY DATE("startedAt")
    `;
  }
}
