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

import { Prisma } from "../prisma/client/index.js";
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
  cost_usd?: number | null;
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
  if (row.cost_usd !== null && row.cost_usd !== undefined) {
    result.costUsd = row.cost_usd;
  }
  return result;
}

/**
 * Build a composable date-range filter fragment for $queryRaw.
 *
 * @param from  Lower bound (inclusive).
 * @param to    Upper bound (exclusive).
 * @param alias Optional table alias to qualify "startedAt" (e.g. "r" → r."startedAt").
 *              Pass this whenever the query uses a JOIN so the column reference is
 *              unambiguous even if the joined table later gains a startedAt column.
 */
function dateFilter(
  from: Date | null,
  to: Date | null,
  alias?: string,
): Prisma.Sql {
  const col = alias
    ? Prisma.sql`${Prisma.raw(`${alias}."startedAt"`)}`
    : Prisma.sql`"startedAt"`;
  if (from !== null && to !== null) {
    return Prisma.sql`AND ${col} >= ${from} AND ${col} < ${to}`;
  }
  if (from !== null) {
    return Prisma.sql`AND ${col} >= ${from}`;
  }
  if (to !== null) {
    return Prisma.sql`AND ${col} < ${to}`;
  }
  return Prisma.empty;
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
    const filter = dateFilter(fromDate, toDate);

    // Queries that use a table alias "r" on AgentCronRun need a qualified filter
    // so "startedAt" is unambiguous if the joined table ever gains that column.
    const filterR = dateFilter(fromDate, toDate, "r");

    const [totalsRows, byAgentRows, byCronRows, byModelRows, dailyRows] =
      await Promise.all([
        this.queryTotals(filter),
        this.queryByAgent(filterR),
        this.queryByCron(filterR),
        this.queryByModel(filterR),
        this.queryDaily(filter),
      ]);

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

  private queryTotals(filter: Prisma.Sql): Promise<TotalsRow[]> {
    return this.prisma.$queryRaw<TotalsRow[]>`
      SELECT
        SUM("AgentCronRun"."inputTokens")         AS input,
        SUM("AgentCronRun"."outputTokens")        AS output,
        SUM("AgentCronRun"."cacheReadTokens")     AS cache_read,
        SUM("AgentCronRun"."cacheCreationTokens") AS cache_creation,
        SUM(b.cost_usd)                           AS cost_usd
      FROM "AgentCronRun"
      LEFT JOIN (
        SELECT "cronRunId", SUM("costUsd") AS cost_usd
        FROM "AgentCronRunModelBreakdown"
        GROUP BY "cronRunId"
      ) b ON b."cronRunId" = "AgentCronRun".id
      WHERE skipped = false
      ${filter}
    `;
  }

  private queryByAgent(filter: Prisma.Sql): Promise<ByAgentRow[]> {
    return this.prisma.$queryRaw<ByAgentRow[]>`
      SELECT
        r."agentId"                  AS agent_id,
        SUM(r."inputTokens")         AS input,
        SUM(r."outputTokens")        AS output,
        SUM(r."cacheReadTokens")     AS cache_read,
        SUM(r."cacheCreationTokens") AS cache_creation,
        SUM(b.cost_usd)              AS cost_usd
      FROM "AgentCronRun" r
      LEFT JOIN (
        SELECT "cronRunId", SUM("costUsd") AS cost_usd
        FROM "AgentCronRunModelBreakdown"
        GROUP BY "cronRunId"
      ) b ON b."cronRunId" = r.id
      WHERE r.skipped = false
      ${filter}
      GROUP BY r."agentId"
      ORDER BY r."agentId"
    `;
  }

  private queryByCron(filter: Prisma.Sql): Promise<ByCronRow[]> {
    return this.prisma.$queryRaw<ByCronRow[]>`
      SELECT
        r."agentId"                  AS agent_id,
        r."cronId"                   AS cron_id,
        j.name                       AS cron_name,
        SUM(r."inputTokens")         AS input,
        SUM(r."outputTokens")        AS output,
        SUM(r."cacheReadTokens")     AS cache_read,
        SUM(r."cacheCreationTokens") AS cache_creation,
        SUM(b.cost_usd)              AS cost_usd
      FROM "AgentCronRun" r
      LEFT JOIN "AgentCronJob" j ON j.id = r."cronId"
      LEFT JOIN (
        SELECT "cronRunId", SUM("costUsd") AS cost_usd
        FROM "AgentCronRunModelBreakdown"
        GROUP BY "cronRunId"
      ) b ON b."cronRunId" = r.id
      WHERE r.skipped = false
      ${filter}
      GROUP BY r."agentId", r."cronId", j.name
      ORDER BY r."agentId", r."cronId"
    `;
  }

  private queryByModel(filter: Prisma.Sql): Promise<ByModelRow[]> {
    // All per-model data comes from AgentCronRunModelBreakdown.
    // Runs without breakdown rows simply have no byModel data.
    return this.prisma.$queryRaw<ByModelRow[]>`
      SELECT
        r."agentId"                AS agent_id,
        b.model                    AS model,
        SUM(b."inputTokens")       AS input,
        SUM(b."outputTokens")      AS output,
        SUM(b."cacheReadTokens")   AS cache_read,
        SUM(b."cacheCreationTokens") AS cache_creation,
        SUM(b."costUsd")           AS cost_usd
      FROM "AgentCronRun" r
      INNER JOIN "AgentCronRunModelBreakdown" b ON b."cronRunId" = r.id
      WHERE r.skipped = false
      ${filter}
      GROUP BY r."agentId", b.model
      ORDER BY r."agentId", b.model
    `;
  }

  private queryDaily(filter: Prisma.Sql): Promise<DailyRow[]> {
    return this.prisma.$queryRaw<DailyRow[]>`
      SELECT
        TO_CHAR(DATE("AgentCronRun"."startedAt"), 'YYYY-MM-DD') AS period,
        SUM("AgentCronRun"."inputTokens")         AS input,
        SUM("AgentCronRun"."outputTokens")        AS output,
        SUM("AgentCronRun"."cacheReadTokens")     AS cache_read,
        SUM("AgentCronRun"."cacheCreationTokens") AS cache_creation,
        SUM(b.cost_usd)                           AS cost_usd
      FROM "AgentCronRun"
      LEFT JOIN (
        SELECT "cronRunId", SUM("costUsd") AS cost_usd
        FROM "AgentCronRunModelBreakdown"
        GROUP BY "cronRunId"
      ) b ON b."cronRunId" = "AgentCronRun".id
      WHERE skipped = false
      ${filter}
      GROUP BY DATE("AgentCronRun"."startedAt")
      ORDER BY DATE("AgentCronRun"."startedAt")
    `;
  }
}
