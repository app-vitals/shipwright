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

    // queryByModel uses table alias "r" on AgentCronRun — build a qualified
    // filter so "startedAt" is unambiguous if the joined table ever gains that column.
    const filterByModel = dateFilter(fromDate, toDate, "r");

    const [totalsRows, byAgentRows, byCronRows, byModelRows, dailyRows] =
      await Promise.all([
        this.queryTotals(filter),
        this.queryByAgent(filter),
        this.queryByCron(filter),
        this.queryByModel(filterByModel),
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
        SUM("inputTokens")         AS input,
        SUM("outputTokens")        AS output,
        SUM("cacheReadTokens")     AS cache_read,
        SUM("cacheCreationTokens") AS cache_creation,
        SUM("costUsd")             AS cost_usd
      FROM "AgentCronRun"
      WHERE skipped = false
      ${filter}
    `;
  }

  private queryByAgent(filter: Prisma.Sql): Promise<ByAgentRow[]> {
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
      ${filter}
      GROUP BY "agentId"
      ORDER BY "agentId"
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
        SUM(r."costUsd")             AS cost_usd
      FROM "AgentCronRun" r
      LEFT JOIN "AgentCronJob" j ON j.id = r."cronId"
      WHERE r.skipped = false
      ${filter}
      GROUP BY r."agentId", r."cronId", j.name
      ORDER BY r."agentId", r."cronId"
    `;
  }

  private queryByModel(filter: Prisma.Sql): Promise<ByModelRow[]> {
    // Runs with breakdown rows: use the breakdown table (accurate per-model split).
    // Runs without breakdown rows: fall back to the run's dominant model field.
    // The UNION combines both sources; final GROUP BY merges across the two.
    return this.prisma.$queryRaw<ByModelRow[]>`
      SELECT
        agent_id,
        model,
        SUM(input)         AS input,
        SUM(output)        AS output,
        SUM(cache_read)    AS cache_read,
        SUM(cache_creation) AS cache_creation,
        SUM(cost_usd)      AS cost_usd
      FROM (
        -- Source 1: runs that have breakdown rows — use breakdown data
        SELECT
          r."agentId"                AS agent_id,
          b.model                    AS model,
          b."inputTokens"            AS input,
          b."outputTokens"           AS output,
          b."cacheReadTokens"        AS cache_read,
          b."cacheCreationTokens"    AS cache_creation,
          b."costUsd"                AS cost_usd
        FROM "AgentCronRun" r
        INNER JOIN "AgentCronRunModelBreakdown" b ON b."cronRunId" = r.id
        WHERE r.skipped = false
        ${filter}

        UNION ALL

        -- Source 2: runs without breakdown rows — fall back to dominant model
        SELECT
          r."agentId"                AS agent_id,
          r.model                    AS model,
          r."inputTokens"            AS input,
          r."outputTokens"           AS output,
          r."cacheReadTokens"        AS cache_read,
          r."cacheCreationTokens"    AS cache_creation,
          r."costUsd"                AS cost_usd
        FROM "AgentCronRun" r
        WHERE r.skipped = false
          AND r.model IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "AgentCronRunModelBreakdown" b2 WHERE b2."cronRunId" = r.id
          )
        ${filter}
      ) combined
      GROUP BY agent_id, model
      ORDER BY agent_id, model
    `;
  }

  private queryDaily(filter: Prisma.Sql): Promise<DailyRow[]> {
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
      ${filter}
      GROUP BY DATE("startedAt")
      ORDER BY DATE("startedAt")
    `;
  }
}
