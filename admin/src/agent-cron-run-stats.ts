/**
 * admin/src/agent-cron-run-stats.ts
 * AgentCronRunStatsService — aggregates AgentCronRun token columns into
 * several dimensions: totals, byAgent, byCron (with AgentCronJob name JOIN),
 * byModel, daily (DATE(startedAt)), byCronModel, and byPhase.
 *
 * Skipped runs (skipped=true) are always excluded from all aggregations.
 * byPhase additionally excludes runs with a null phaseId (legacy five-job
 * crons, or runs that predate phase tracking, or runs whose agent hasn't
 * reconciled its phase child rows yet).
 *
 * bySkill (PAU-1.6) aggregates AgentCronRunSkillUsage per (kind, name) over
 * non-skipped runs only. baselines groups the first-turn context baseline per
 * (contextFingerprint, baselineModel, phase) — skipped runs ARE included
 * (their baseline is still a valid measurement), runs with no baseline
 * (baselineContextTokens NULL) are excluded; rows are ordered by first
 * appearance. Both are empty arrays when nothing has been reported.
 * Uses $queryRaw for all dimensions — Prisma groupBy doesn't support the
 * LEFT JOIN needed for byCron.
 *
 * byCron/byCronModel additionally group by phase (WL-3.5, LPC-3.1): each row
 * carries a `phase` field derived by LEFT JOINing "AgentCronJob" a second
 * time (alias `p`) on `r."phaseId" = p.id` and stripping the
 * "shipwright-" prefix from p.name (e.g. "shipwright-dev-task" → "dev-task")
 * so the output label matches exactly what the old `r.phase` string column
 * used to contain. A run with no phaseId (legacy five-job crons, or an
 * unreconciled agent) has phase NULL, and since SQL GROUP BY treats NULL as
 * a single group, all of a cron's legacy runs still collapse into one row —
 * identical to today's cronId-only display. Runs that do carry a phaseId
 * (unified loop) produce one row per (cronId, phase), surfacing the
 * dev-task/review/patch/deploy breakdown that used to be implicit in having
 * five separate crons.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import { Prisma } from "../prisma/client/client.ts";

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
  /**
   * Pipeline phase this row's runs served (dev-task/review/patch/deploy).
   * Only populated on byCron/byCronModel rows; null for legacy runs that
   * predate phase tracking, and always undefined on other dimensions
   * (byAgent, byModel) which don't group by phase.
   */
  phase?: string | null;
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
  byCronModel: DoubleKeyedTokenAggregate[]; // key1=agentId:cronName, key2=model
  byPhase: KeyedTokenAggregate[]; // key=phase; runs with a null phase are excluded
  bySkill?: SkillUsageAggregate[]; // per (kind,name); skipped runs excluded
  baselines?: ContextBaselineAggregate[]; // per (fingerprint,model,phase); runs w/o baseline excluded
}

/** Per-skill / per-subagent usage rollup across runs. */
export interface SkillUsageAggregate {
  kind: string;
  name: string;
  runs: number;
  invocations: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Mean invokeContextDelta over rows that reported one; null when none did. */
  avgInvokeContextDelta: number | null;
}

/** First-turn context baseline rollup for runs sharing a fingerprint/model/phase. */
export interface ContextBaselineAggregate {
  contextFingerprint: string | null;
  baselineModel: string | null;
  phase: string | null;
  runs: number;
  avgContextTokens: number;
  minContextTokens: number;
  maxContextTokens: number;
  /** Mean over runs that reported a value; null when none did. */
  avgTurns: number | null;
  avgToolCalls: number | null;
  firstSeen: string;
  lastSeen: string;
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
  phase: string | null;
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

interface ByCronModelRow {
  agent_id: string;
  cron_id: string;
  cron_name: string | null;
  model: string;
  phase: string | null;
  input: bigint | null;
  output: bigint | null;
  cache_read: bigint | null;
  cache_creation: bigint | null;
  cost_usd: number | null;
}

interface ByPhaseRow {
  phase: string;
  input: bigint | null;
  output: bigint | null;
  cache_read: bigint | null;
  cache_creation: bigint | null;
  cost_usd: number | null;
}

interface BySkillRow {
  kind: string;
  name: string;
  runs: bigint;
  invocations: bigint | null;
  turns: bigint | null;
  input: bigint | null;
  output: bigint | null;
  cache_read: bigint | null;
  cache_creation: bigint | null;
  avg_invoke_context_delta: number | null;
}

interface BaselineRow {
  context_fingerprint: string | null;
  baseline_model: string | null;
  phase: string | null;
  runs: bigint;
  avg_context_tokens: number;
  min_context_tokens: number;
  max_context_tokens: number;
  avg_turns: number | null;
  avg_tool_calls: number | null;
  first_seen: Date;
  last_seen: Date;
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

    // Every query now aliases AgentCronRun as "r" (all six LEFT/INNER JOIN the
    // breakdown table), so all filters are qualified against that alias to keep
    // "startedAt" unambiguous.
    const filterR = dateFilter(fromDate, toDate, "r");

    const [
      totalsRows,
      byAgentRows,
      byCronRows,
      byModelRows,
      dailyRows,
      byCronModelRows,
      byPhaseRows,
      bySkillRows,
      baselineRows,
    ] = await Promise.all([
      this.queryTotals(filterR),
      this.queryByAgent(filterR),
      this.queryByCron(filterR),
      this.queryByModel(filterR),
      this.queryDaily(filterR),
      this.queryByCronModel(filterR),
      this.queryByPhase(filterR),
      this.queryBySkill(filterR),
      this.queryBaselines(filterR),
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
      phase: row.phase,
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

    const byCronModel: DoubleKeyedTokenAggregate[] = byCronModelRows.map(
      (row) => ({
        ...toAggregate(row),
        key1: `${row.agent_id}:${row.cron_name ?? row.cron_id}`,
        key2: row.model,
        phase: row.phase,
      }),
    );

    const byPhase: KeyedTokenAggregate[] = byPhaseRows.map((row) => ({
      ...toAggregate(row),
      key: row.phase,
    }));

    const bySkill: SkillUsageAggregate[] = bySkillRows.map((row) => ({
      kind: row.kind,
      name: row.name,
      runs: num(row.runs),
      invocations: num(row.invocations),
      turns: num(row.turns),
      input: num(row.input),
      output: num(row.output),
      cacheRead: num(row.cache_read),
      cacheCreation: num(row.cache_creation),
      avgInvokeContextDelta: row.avg_invoke_context_delta,
    }));

    const baselines: ContextBaselineAggregate[] = baselineRows.map((row) => ({
      contextFingerprint: row.context_fingerprint,
      baselineModel: row.baseline_model,
      phase: row.phase,
      runs: num(row.runs),
      avgContextTokens: row.avg_context_tokens,
      minContextTokens: row.min_context_tokens,
      maxContextTokens: row.max_context_tokens,
      avgTurns: row.avg_turns,
      avgToolCalls: row.avg_tool_calls,
      firstSeen: row.first_seen.toISOString(),
      lastSeen: row.last_seen.toISOString(),
    }));

    return {
      totals,
      byAgent,
      byCron,
      byModel,
      daily,
      byCronModel,
      byPhase,
      bySkill,
      baselines,
    };
  }

  // ─── Private query methods ──────────────────────────────────────────────────

  private queryTotals(filter: Prisma.Sql): Promise<TotalsRow[]> {
    // All token/cost data lives in AgentCronRunModelBreakdown. A LEFT JOIN keeps
    // runs without breakdown rows in scope for the skipped/date filters (they
    // simply contribute NULL, i.e. zero, to every SUM).
    return this.prisma.$queryRaw<TotalsRow[]>`
      SELECT
        SUM(b."inputTokens")         AS input,
        SUM(b."outputTokens")        AS output,
        SUM(b."cacheReadTokens")     AS cache_read,
        SUM(b."cacheCreationTokens") AS cache_creation,
        SUM(b."costUsd")             AS cost_usd
      FROM "AgentCronRun" r
      LEFT JOIN "AgentCronRunModelBreakdown" b ON b."cronRunId" = r.id
      WHERE r.skipped = false
      ${filter}
    `;
  }

  private queryByAgent(filter: Prisma.Sql): Promise<ByAgentRow[]> {
    return this.prisma.$queryRaw<ByAgentRow[]>`
      SELECT
        r."agentId"                  AS agent_id,
        SUM(b."inputTokens")         AS input,
        SUM(b."outputTokens")        AS output,
        SUM(b."cacheReadTokens")     AS cache_read,
        SUM(b."cacheCreationTokens") AS cache_creation,
        SUM(b."costUsd")             AS cost_usd
      FROM "AgentCronRun" r
      LEFT JOIN "AgentCronRunModelBreakdown" b ON b."cronRunId" = r.id
      WHERE r.skipped = false
      ${filter}
      GROUP BY r."agentId"
      ORDER BY r."agentId"
    `;
  }

  private queryByCron(filter: Prisma.Sql): Promise<ByCronRow[]> {
    // GROUP BY includes p.name (LPC-3.1, via phaseId): Postgres treats NULL
    // as a single group, so legacy/unreconciled runs (phaseId IS NULL) for a
    // cron still collapse into one row — identical to the pre-WL-3.5
    // cronId-only grouping. Runs that do carry a phaseId produce one row per
    // (cronId, phase). The "shipwright-" prefix is stripped from p.name so
    // the label matches exactly what the old r.phase string column used to
    // contain (e.g. "dev-task", not "shipwright-dev-task").
    return this.prisma.$queryRaw<ByCronRow[]>`
      SELECT
        r."agentId"                              AS agent_id,
        r."cronId"                               AS cron_id,
        j.name                                   AS cron_name,
        REGEXP_REPLACE(p.name, '^shipwright-', '') AS phase,
        SUM(b."inputTokens")         AS input,
        SUM(b."outputTokens")        AS output,
        SUM(b."cacheReadTokens")     AS cache_read,
        SUM(b."cacheCreationTokens") AS cache_creation,
        SUM(b."costUsd")             AS cost_usd
      FROM "AgentCronRun" r
      LEFT JOIN "AgentCronJob" j ON j.id = r."cronId"
      LEFT JOIN "AgentCronJob" p ON p.id = r."phaseId"
      LEFT JOIN "AgentCronRunModelBreakdown" b ON b."cronRunId" = r.id
      WHERE r.skipped = false
      ${filter}
      GROUP BY r."agentId", r."cronId", j.name, p.name
      ORDER BY r."agentId", r."cronId", p.name
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
        TO_CHAR(DATE(r."startedAt"), 'YYYY-MM-DD') AS period,
        SUM(b."inputTokens")         AS input,
        SUM(b."outputTokens")        AS output,
        SUM(b."cacheReadTokens")     AS cache_read,
        SUM(b."cacheCreationTokens") AS cache_creation,
        SUM(b."costUsd")             AS cost_usd
      FROM "AgentCronRun" r
      LEFT JOIN "AgentCronRunModelBreakdown" b ON b."cronRunId" = r.id
      WHERE r.skipped = false
      ${filter}
      GROUP BY DATE(r."startedAt")
      ORDER BY DATE(r."startedAt")
    `;
  }

  private queryByCronModel(filter: Prisma.Sql): Promise<ByCronModelRow[]> {
    // GROUP BY includes p.name (LPC-3.1, via phaseId) — same
    // NULL-collapses-to-one-group reasoning as queryByCron above.
    return this.prisma.$queryRaw<ByCronModelRow[]>`
      SELECT
        r."agentId"                              AS agent_id,
        r."cronId"                               AS cron_id,
        j.name                                   AS cron_name,
        b.model                                  AS model,
        REGEXP_REPLACE(p.name, '^shipwright-', '') AS phase,
        SUM(b."inputTokens")           AS input,
        SUM(b."outputTokens")          AS output,
        SUM(b."cacheReadTokens")       AS cache_read,
        SUM(b."cacheCreationTokens")   AS cache_creation,
        SUM(b."costUsd")               AS cost_usd
      FROM "AgentCronRun" r
      LEFT JOIN "AgentCronJob" j ON j.id = r."cronId"
      LEFT JOIN "AgentCronJob" p ON p.id = r."phaseId"
      INNER JOIN "AgentCronRunModelBreakdown" b ON b."cronRunId" = r.id
      WHERE r.skipped = false
      ${filter}
      GROUP BY r."agentId", r."cronId", j.name, b.model, p.name
      ORDER BY r."agentId", r."cronId", b.model, p.name
    `;
  }

  private queryByPhase(filter: Prisma.Sql): Promise<ByPhaseRow[]> {
    // Runs with no phaseId (legacy five-job crons, or an unreconciled agent)
    // are excluded — phase is additive grouping, not a replacement for
    // totals/byAgent/etc. Label derived by LEFT JOINing "AgentCronJob" (alias
    // p) on r."phaseId" = p.id and stripping the "shipwright-" prefix from
    // p.name, matching what r.phase used to contain directly.
    return this.prisma.$queryRaw<ByPhaseRow[]>`
      SELECT
        REGEXP_REPLACE(p.name, '^shipwright-', '') AS phase,
        SUM(b."inputTokens")         AS input,
        SUM(b."outputTokens")        AS output,
        SUM(b."cacheReadTokens")     AS cache_read,
        SUM(b."cacheCreationTokens") AS cache_creation,
        SUM(b."costUsd")             AS cost_usd
      FROM "AgentCronRun" r
      LEFT JOIN "AgentCronJob" p ON p.id = r."phaseId"
      LEFT JOIN "AgentCronRunModelBreakdown" b ON b."cronRunId" = r.id
      WHERE r.skipped = false AND r."phaseId" IS NOT NULL
      ${filter}
      GROUP BY p.name
      ORDER BY p.name
    `;
  }

  private queryBySkill(filter: Prisma.Sql): Promise<BySkillRow[]> {
    // Skipped runs excluded (same rule as every token dimension). AVG ignores
    // NULL invokeContextDelta rows, so a skill never measured yields NULL.
    return this.prisma.$queryRaw<BySkillRow[]>`
      SELECT
        u.kind                              AS kind,
        u.name                              AS name,
        COUNT(DISTINCT r.id)                AS runs,
        SUM(u.invocations)                  AS invocations,
        SUM(u.turns)                        AS turns,
        SUM(u."inputTokens")                AS input,
        SUM(u."outputTokens")               AS output,
        SUM(u."cacheReadTokens")            AS cache_read,
        SUM(u."cacheCreationTokens")        AS cache_creation,
        AVG(u."invokeContextDelta")::float8 AS avg_invoke_context_delta
      FROM "AgentCronRun" r
      INNER JOIN "AgentCronRunSkillUsage" u ON u."cronRunId" = r.id
      WHERE r.skipped = false
      ${filter}
      GROUP BY u.kind, u.name
      ORDER BY u.kind, u.name
    `;
  }

  private queryBaselines(filter: Prisma.Sql): Promise<BaselineRow[]> {
    // Skipped runs are deliberately included; runs with no baseline are not.
    // NULL fingerprint/model/phase each collapse into a single group.
    return this.prisma.$queryRaw<BaselineRow[]>`
      SELECT
        r."contextFingerprint"                       AS context_fingerprint,
        r."baselineModel"                            AS baseline_model,
        REGEXP_REPLACE(p.name, '^shipwright-', '')   AS phase,
        COUNT(*)                                     AS runs,
        AVG(r."baselineContextTokens")::float8       AS avg_context_tokens,
        MIN(r."baselineContextTokens")               AS min_context_tokens,
        MAX(r."baselineContextTokens")               AS max_context_tokens,
        AVG(r.turns)::float8                         AS avg_turns,
        AVG(r."toolCalls")::float8                   AS avg_tool_calls,
        MIN(r."startedAt")                           AS first_seen,
        MAX(r."startedAt")                           AS last_seen
      FROM "AgentCronRun" r
      LEFT JOIN "AgentCronJob" p ON p.id = r."phaseId"
      WHERE r."baselineContextTokens" IS NOT NULL
      ${filter}
      GROUP BY r."contextFingerprint", r."baselineModel", p.name
      ORDER BY MIN(r."startedAt"), r."contextFingerprint", r."baselineModel", p.name
    `;
  }
}
