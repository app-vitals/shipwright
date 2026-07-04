/**
 * metrics/src/providers/task-store-provider.ts
 *
 * MetricsProvider backed by the Shipwright task store (tasks + PRs) and the
 * admin token-aggregation endpoints. Answers all 17 MetricQuery kinds by
 * aggregating client-side in TypeScript, emitting MetricTables. api.ts parses
 * the result positionally, so column shapes must remain stable across providers.
 *
 * Two token sources are combined with no double-counting (AC#2): cron-run
 * tokens (the "cron" session source) and chat-daily tokens (the "chat" session
 * source) are disjoint, so summing them field-wise is the correct total.
 *
 * Where a metric genuinely has no task-store equivalent (e.g. simplify
 * sub-scores, files-changed, retries, fix-cascade depth — those lived only in
 * the now-removed PostHog event stream), the column is kept and filled with a
 * neutral empty value (null/0) rather than dropped: every kind must return a
 * valid table (AC#1).
 */

import {
  OPUS_MODEL,
  calculateCost,
  normalizeModelToRateKey,
} from "@shipwright/lib/pricing";
import { resolveQueryRange } from "../formatters.ts";
import {
  AdminMetricsClientError,
  type AdminMetricsClient,
  type ChatTokenStats,
  type CronRunTokenStats,
  type TokenAggregate,
} from "../lib/admin-metrics-client.ts";
import { type Clock, SystemClock } from "../lib/clock.ts";
import type {
  PrRecord,
  TaskRecord,
  TaskStoreClient,
} from "../lib/task-store-client.ts";
import type {
  MetricQuery,
  MetricTable,
  MetricsProvider,
} from "../metrics-provider.ts";

const DASHBOARD_TZ = "America/Los_Angeles";

// Completed / terminal statuses (treated as "completed").
const COMPLETED_STATUSES = new Set(["merged", "done", "deployed", "deploying"]);
const BLOCKED_STATUS = "blocked";

// Task-store PR review-state that denotes an approved ("ship it") review. The
// live task store records `reviewState` as one of `approved | posted | pending`.
const SHIP_IT_REVIEW_STATE = "approved";

// Zero aggregates for graceful degradation when admin stats endpoints fail.
const ZERO_AGG: TokenAggregate = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
};

const ZERO_CRON_STATS: CronRunTokenStats = {
  totals: ZERO_AGG,
  byAgent: [],
  byCron: [],
  byModel: [],
  daily: [],
  byCronModel: [],
};

const ZERO_CHAT_STATS: ChatTokenStats = {
  totals: ZERO_AGG,
  byAgent: [],
  byModel: [],
  daily: [],
};

// ─── Value helpers ────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function avg(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function sum(values: Array<number | null>): number {
  return values.reduce<number>((a, b) => a + (b ?? 0), 0);
}

function dayBucket(ts: string): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: DASHBOARD_TZ });
}

function table(columns: string[], results: unknown[][]): MetricTable {
  return {
    columns,
    results,
    types: columns.map(() => "String"),
    hasMore: false,
    limit: 100,
    offset: 0,
  };
}

// ─── Task helpers ─────────────────────────────────────────────────────────────

const FEATURE_PREFIX_RE = /^[A-Z]+-[0-9]+\.[0-9]+$/;
function featurePrefix(id: string): string | null {
  if (!FEATURE_PREFIX_RE.test(id)) return null;
  const m = id.match(/^([A-Z]+)-/);
  return m ? m[1] : null;
}

function isCompleted(t: TaskRecord): boolean {
  return COMPLETED_STATUSES.has(t.status);
}

/** Cycle hours = (completedAt|mergedAt) - startedAt, in hours. */
function cycleHours(t: TaskRecord): number | null {
  const start = t.startedAt;
  const end = t.completedAt ?? t.mergedAt;
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (Number.isNaN(ms)) return null;
  return ms / (1000 * 60 * 60);
}

/** When a completed task lands, for day-bucketing. */
function completionTs(t: TaskRecord): string | null {
  return t.completedAt ?? t.mergedAt ?? null;
}

// ─── Token column helpers ─────────────────────────────────────────────────────

const TOKEN_BASE_COLUMNS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_tokens",
];

function tokenColumns(groupCol?: string): string[] {
  return groupCol ? [groupCol, ...TOKEN_BASE_COLUMNS] : TOKEN_BASE_COLUMNS;
}

function tokenCells(a: TokenAggregate): number[] {
  return [a.input, a.output, a.cacheRead, a.cacheCreation, a.total];
}

function addAggregates(a: TokenAggregate, b: TokenAggregate): TokenAggregate {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    total: a.total + b.total,
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class TaskStoreProvider implements MetricsProvider {
  /**
   * @param repo - optional `org/repo` scope. When set (public mode), every
   *   task/PR read is filtered to this repo. When omitted, all repos are
   *   included (the authenticated default).
   */
  constructor(
    private readonly taskStore: TaskStoreClient,
    private readonly admin: AdminMetricsClient,
    private readonly clock: Clock = SystemClock(),
    private readonly repo?: string,
  ) {}

  async query(q: MetricQuery): Promise<MetricTable> {
    const win = resolveQueryRange(q.range, this.clock);
    switch (q.kind) {
      case "summary":
        return this.summary(win);
      case "summaryCycleTime":
        return this.summaryCycleTime(win);
      case "trends":
        return this.trends(win);
      case "featuresTasks":
        return this.featuresTasks(win);
      case "featuresCi":
        return this.featuresCi(win);
      case "featuresReviews":
        return this.featuresReviews(win);
      case "queueFunnel":
        return this.queueFunnel(win);
      case "queueCycleStarted":
        return this.cycleRows(win, "started");
      case "queueCycleMerged":
        return this.cycleRows(win, "merged");
      case "tokensTotals":
        return this.tokensTotals(win);
      case "tokensBySessionType":
        return this.tokensBySessionType(win);
      case "tokensByAgent":
        return this.tokensByAgent(win);
      case "tokensTrends":
        return this.tokensTrends(win);
      case "tokensByAgentBySessionType":
        return this.tokensByAgentBySessionType(win);
      case "tokensByAgentByCron":
        return this.tokensByAgentByCron(win);
      case "tokensByAgentByModel":
        return this.tokensByAgentByModel(win);
      case "tokensByAgentByCronModel":
        return this.tokensByAgentByCronModel(win);
      case "costEfficiency":
        return this.costEfficiency(win);
    }
  }

  // ─ Task reads ─

  private tasks(win: { from: string; to: string }): Promise<TaskRecord[]> {
    return Promise.resolve(
      this.taskStore.listTasks({ ...win, repo: this.repo }),
    );
  }

  private prs(win: { from: string; to: string }): Promise<PrRecord[]> {
    return Promise.resolve(this.taskStore.listPrs({ ...win, repo: this.repo }));
  }

  // ─ Summary ─

  private async summary(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const [tasks, prs] = await Promise.all([this.tasks(win), this.prs(win)]);
    const completed = tasks.filter(isCompleted);
    const blocked = tasks.filter((t) => t.status === BLOCKED_STATUS);

    // CI gates: completed tasks that recorded a ciFixAttempts value.
    const ciTasks = completed.filter((t) => num(t.ciFixAttempts) !== null);
    const ciFirst = ciTasks.filter((t) => num(t.ciFixAttempts) === 0).length;

    const complexityCount = (n: number) =>
      completed.filter((t) => num(t.complexity) === n).length;

    const shipIt = prs.filter(
      (p) => p.reviewState === SHIP_IT_REVIEW_STATE,
    ).length;

    // Interim proxy for true review-findings tracking (deferred — needs a
    // schema decision): reviewCycles + patchCycles per PR, averaged. This is
    // an iteration count, not a findings count.
    const avgReviewIterations = avg(
      prs.map((p) => (num(p.reviewCycles) ?? 0) + (num(p.patchCycles) ?? 0)),
    );

    const columns = [
      "tasks_completed",
      "tasks_blocked",
      "avg_actual_hours",
      "avg_estimated_hours",
      "avg_retries",
      "avg_files_changed",
      "ci_gates_total",
      "ci_first_pass",
      "avg_fix_attempts",
      "simplify_total",
      "simplify_total_fixes",
      "simplify_avg_dry",
      "simplify_avg_dead_code",
      "simplify_avg_naming",
      "simplify_avg_complexity",
      "simplify_avg_consistency",
      "reviews_total",
      "reviews_ship_it",
      "avg_review_iterations",
      "complexity_1",
      "complexity_2",
      "complexity_3",
      "complexity_4",
      "complexity_5",
      "avg_fix_cascade_depth",
      "coverage_reports",
      "avg_coverage_delta",
    ];

    const row = [
      completed.length,
      blocked.length,
      avg(completed.map(cycleHours)), // actual hours ≈ cycle time
      avg(completed.map((t) => num(t.hours))), // estimated hours
      null, // avg_retries — no task-store source
      null, // avg_files_changed — no task-store source
      ciTasks.length,
      ciFirst,
      avg(ciTasks.map((t) => num(t.ciFixAttempts))),
      completed.filter((t) => num(t.simplifyTotal) !== null).length, // simplify_total = tasks with a simplify pass
      sum(completed.map((t) => num(t.simplifyTotal))), // simplify_total_fixes
      null, // simplify_avg_dry — no task-store source
      null, // simplify_avg_dead_code — no task-store source
      null, // simplify_avg_naming — no task-store source
      null, // simplify_avg_complexity — no task-store source
      null, // simplify_avg_consistency — no task-store source
      prs.length,
      shipIt,
      avgReviewIterations,
      complexityCount(1),
      complexityCount(2),
      complexityCount(3),
      complexityCount(4),
      complexityCount(5),
      null, // avg_fix_cascade_depth — no task-store source
      completed.filter((t) => num(t.coverageDelta) !== null).length, // coverage_reports
      avg(completed.map((t) => num(t.coverageDelta))), // avg_coverage_delta
    ];

    return table(columns, [row]);
  }

  // ─ Summary cycle time ─

  private async summaryCycleTime(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const tasks = await this.tasks(win);
    const positive = tasks
      .filter(isCompleted)
      .map(cycleHours)
      .filter((h): h is number => h !== null && h > 0);
    const avgHours = positive.length
      ? positive.reduce((a, b) => a + b, 0) / positive.length
      : null;
    return table(["avg_cycle_time_hours"], [[avgHours]]);
  }

  // ─ Trends ─

  private async trends(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const [tasks, prs] = await Promise.all([this.tasks(win), this.prs(win)]);
    const completed = tasks.filter(isCompleted);

    const periods = new Set<string>();
    for (const t of completed) {
      const ts = completionTs(t);
      if (ts) periods.add(dayBucket(ts));
    }
    for (const t of tasks) {
      if (t.startedAt) periods.add(dayBucket(t.startedAt));
    }
    for (const p of prs) {
      const ts = p.mergedAt ?? p.createdAt;
      if (ts) periods.add(dayBucket(ts));
    }

    const columns = [
      "period",
      "tasks_completed",
      "ci_gates",
      "ci_first_pass",
      "ci_first_pass_count",
      "simplify_passes",
      "simplify_fixes",
      "tasks_blocked",
      "reviews",
      "tasks_started",
      "reviews_ship_it",
      "avg_actual_hours",
      "avg_estimated_hours",
      "avg_retries",
      "avg_files_changed",
      "avg_fix_attempts",
      "avg_cycle_time_hours",
      "estimation_accuracy",
      "simplify_avg_dry",
      "simplify_avg_dead_code",
      "simplify_avg_naming",
      "simplify_avg_complexity",
      "simplify_avg_consistency",
      "avg_review_findings",
    ];

    const completedOn = (p: string) =>
      completed.filter((t) => {
        const ts = completionTs(t);
        return ts ? dayBucket(ts) === p : false;
      });
    const startedOn = (p: string) =>
      tasks.filter((t) => t.startedAt && dayBucket(t.startedAt) === p);
    const blockedOn = (p: string) =>
      tasks.filter(
        (t) =>
          t.status === BLOCKED_STATUS &&
          t.startedAt &&
          dayBucket(t.startedAt) === p,
      );
    const prsOn = (p: string) =>
      prs.filter((pr) => {
        const ts = pr.mergedAt ?? pr.createdAt;
        return ts ? dayBucket(ts) === p : false;
      });

    const rows = [...periods].sort().map((p) => {
      const c = completedOn(p);
      const ciTasks = c.filter((t) => num(t.ciFixAttempts) !== null);
      const ciFirst = ciTasks.filter((t) => num(t.ciFixAttempts) === 0).length;
      const dayPrs = prsOn(p);

      const positiveCycle = c
        .map(cycleHours)
        .filter((h): h is number => h !== null && h > 0);
      const avgCycle = positiveCycle.length
        ? positiveCycle.reduce((a, b) => a + b, 0) / positiveCycle.length
        : null;

      const estAcc = c
        .map((t) => {
          const est = num(t.hours);
          const act = cycleHours(t);
          if (est === null || act === null || est <= 0) return null;
          return act / est;
        })
        .filter((v): v is number => v !== null);

      return [
        p,
        c.length,
        ciTasks.length,
        ciFirst, // ci_first_pass (count of first-pass)
        ciFirst, // ci_first_pass_count
        c.filter((t) => num(t.simplifyTotal) !== null).length,
        sum(c.map((t) => num(t.simplifyTotal))),
        blockedOn(p).length,
        dayPrs.length,
        startedOn(p).length,
        dayPrs.filter((pr) => pr.reviewState === SHIP_IT_REVIEW_STATE).length,
        avg(c.map(cycleHours)), // avg_actual_hours ≈ cycle time
        avg(c.map((t) => num(t.hours))),
        null, // avg_retries — no source
        null, // avg_files_changed — no source
        avg(ciTasks.map((t) => num(t.ciFixAttempts))),
        avgCycle,
        estAcc.length
          ? estAcc.reduce((a, b) => a + b, 0) / estAcc.length
          : null,
        null, // simplify_avg_dry — no source
        null, // simplify_avg_dead_code — no source
        null, // simplify_avg_naming — no source
        null, // simplify_avg_complexity — no source
        null, // simplify_avg_consistency — no source
        null, // avg_review_findings — task-store PR records carry no findings count
      ];
    });

    return table(columns, rows);
  }

  // ─ Features ─

  private groupTasksByPrefix(tasks: TaskRecord[]): Map<string, TaskRecord[]> {
    const map = new Map<string, TaskRecord[]>();
    for (const t of tasks) {
      const p = featurePrefix(t.id);
      if (!p) continue;
      const arr = map.get(p) ?? [];
      arr.push(t);
      map.set(p, arr);
    }
    return map;
  }

  private groupPrsByPrefix(prs: PrRecord[]): Map<string, PrRecord[]> {
    const map = new Map<string, PrRecord[]>();
    for (const pr of prs) {
      const id = pr.taskId ?? "";
      const p = featurePrefix(id);
      if (!p) continue;
      const arr = map.get(p) ?? [];
      arr.push(pr);
      map.set(p, arr);
    }
    return map;
  }

  private async featuresTasks(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const tasks = await this.tasks(win);
    const groups = this.groupTasksByPrefix(tasks.filter(isCompleted));
    const columns = [
      "feature_prefix",
      "tasks_completed",
      "avg_actual_h",
      "avg_estimated_h",
    ];
    const rows = [...groups.entries()]
      .map(([prefix, group]) => [
        prefix,
        group.length,
        avg(group.map(cycleHours)),
        avg(group.map((t) => num(t.hours))),
      ])
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    return table(columns, rows);
  }

  private async featuresCi(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const tasks = await this.tasks(win);
    const ciTasks = tasks
      .filter(isCompleted)
      .filter((t) => num(t.ciFixAttempts) !== null);
    const groups = this.groupTasksByPrefix(ciTasks);
    const columns = ["feature_prefix", "ci_total", "ci_first_pass"];
    const rows = [...groups.entries()].map(([prefix, group]) => [
      prefix,
      group.length,
      group.filter((t) => num(t.ciFixAttempts) === 0).length,
    ]);
    return table(columns, rows);
  }

  private async featuresReviews(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const prs = await this.prs(win);
    const groups = this.groupPrsByPrefix(prs);
    const columns = ["feature_prefix", "reviews_total", "reviews_ship_it"];
    const rows = [...groups.entries()].map(([prefix, group]) => [
      prefix,
      group.length,
      group.filter((p) => p.reviewState === SHIP_IT_REVIEW_STATE).length,
    ]);
    return table(columns, rows);
  }

  // ─ Queue ─

  private async queueFunnel(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const [tasks, prs] = await Promise.all([this.tasks(win), this.prs(win)]);
    const started = tasks.filter((t) => t.startedAt != null);
    const merged = tasks.filter(isCompleted);
    const blocked = tasks.filter((t) => t.status === BLOCKED_STATUS);
    const approved = prs.filter((p) => p.reviewState === SHIP_IT_REVIEW_STATE);

    const columns = [
      "tasks_started",
      "tasks_approved",
      "tasks_merged",
      "tasks_blocked",
      "avg_review_findings",
    ];
    const row = [
      started.length,
      approved.length,
      merged.length,
      blocked.length,
      null, // avg_review_findings — task-store PR records carry no findings count
    ];
    return table(columns, [row]);
  }

  private async cycleRows(
    win: { from: string; to: string },
    which: "started" | "merged",
  ): Promise<MetricTable> {
    const tasks = await this.tasks(win);
    const columns = ["task_id", "timestamp"];
    const rows: unknown[][] = [];
    for (const t of tasks) {
      if (which === "started") {
        if (t.startedAt) rows.push([t.id, t.startedAt]);
      } else {
        const ts = completionTs(t);
        if (isCompleted(t) && ts) rows.push([t.id, ts]);
      }
    }
    return table(columns, rows);
  }

  // ─ Tokens ─

  private async tokensTotals(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const [cron, chat] = await Promise.all([
      this.safeCronStats(win),
      this.safeChatStats(win),
    ]);
    // Disjoint sources — summing field-wise is correct, no double count.
    const total = addAggregates(cron.totals, chat.totals);
    return table(
      [...tokenColumns(), "cost_usd"],
      [[...tokenCells(total), total.costUsd ?? 0]],
    );
  }

  private async tokensBySessionType(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const [cron, chat] = await Promise.all([
      this.safeCronStats(win),
      this.safeChatStats(win),
    ]);
    const rows = [
      ["cron", ...tokenCells(cron.totals), cron.totals.costUsd ?? 0],
      ["chat", ...tokenCells(chat.totals), chat.totals.costUsd ?? 0],
    ].sort((a, b) => Number(b[5]) - Number(a[5]));
    return table([...tokenColumns("session_type"), "cost_usd"], rows);
  }

  private async tokensByAgent(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const [cron, chat] = await Promise.all([
      this.safeCronStats(win),
      this.safeChatStats(win),
    ]);
    const byAgent = new Map<string, TokenAggregate>();
    for (const a of [...cron.byAgent, ...chat.byAgent]) {
      const prev = byAgent.get(a.key);
      byAgent.set(a.key, prev ? addAggregates(prev, a) : a);
    }
    const rows = [...byAgent.entries()]
      .map(([key, a]) => [key, ...tokenCells(a), a.costUsd ?? 0])
      .sort((x, y) => Number(y[5]) - Number(x[5]));
    return table([...tokenColumns("agent_id"), "cost_usd"], rows);
  }

  private async tokensTrends(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const [cron, chat] = await Promise.all([
      this.safeCronStats(win),
      this.safeChatStats(win),
    ]);
    const byDay = new Map<string, TokenAggregate>();
    for (const d of [...cron.daily, ...chat.daily]) {
      const prev = byDay.get(d.period);
      byDay.set(d.period, prev ? addAggregates(prev, d) : d);
    }
    const rows = [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([period, a]) => [period, ...tokenCells(a)]);
    return table(tokenColumns("period"), rows);
  }

  private async tokensByAgentBySessionType(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const [cron, chat] = await Promise.all([
      this.safeCronStats(win),
      this.safeChatStats(win),
    ]);
    const rows: unknown[][] = [];
    for (const a of cron.byAgent) {
      rows.push([a.key, "cron", ...tokenCells(a), a.costUsd ?? 0]);
    }
    for (const a of chat.byAgent) {
      rows.push([a.key, "chat", ...tokenCells(a), a.costUsd ?? 0]);
    }
    rows.sort((a, b) => Number(b[6]) - Number(a[6]));
    return table(
      ["agent_id", "session_type", ...tokenColumns(), "cost_usd"],
      rows,
    );
  }

  private async tokensByAgentByCron(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    // Cron-only: chat has no cron name.
    const cron = await this.safeCronStats(win);
    const rows = cron.byCron
      .map((a) => [a.key1, a.key2, ...tokenCells(a), a.costUsd ?? 0])
      .sort((a, b) => Number(b[6]) - Number(a[6]));
    return table(
      ["agent_id", "cron_name", ...tokenColumns(), "cost_usd"],
      rows,
    );
  }

  private async tokensByAgentByModel(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const [cron, chat] = await Promise.all([
      this.safeCronStats(win),
      this.safeChatStats(win),
    ]);

    // Merge cron byModel + chat byModel into a single (agentId, model) map,
    // summing token counts across the two disjoint session sources.
    type Cells = {
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
      costUsd: number;
    };
    const merged = new Map<string, Cells>();
    const add = (key1: string, key2: string, a: { input: number; output: number; cacheRead: number; cacheCreation: number; costUsd?: number }) => {
      const k = `${key1}\0${key2}`;
      const existing = merged.get(k) ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
        costUsd: 0,
      };
      merged.set(k, {
        input: existing.input + a.input,
        output: existing.output + a.output,
        cacheRead: existing.cacheRead + a.cacheRead,
        cacheCreation: existing.cacheCreation + a.cacheCreation,
        costUsd: existing.costUsd + (a.costUsd ?? 0),
      });
    };

    for (const a of cron.byModel) add(a.key1, a.key2, a);
    for (const a of chat.byModel) add(a.key1, a.key2, a);

    const rows = [...merged.entries()]
      .map(([k, v]) => {
        const [key1, key2] = k.split("\0") as [string, string];
        return [
          key1,
          key2,
          v.input,
          v.output,
          v.cacheRead,
          v.cacheCreation,
          v.input + v.output + v.cacheRead + v.cacheCreation,
          v.costUsd,
        ];
      })
      .sort((a, b) => Number(b[7]) - Number(a[7]));

    return table(["agent_id", "model", ...tokenColumns(), "cost_usd"], rows);
  }

  private async tokensByAgentByCronModel(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    // Cron-only: chat has no cron dimension (same reasoning as tokensByAgentByCron).
    const cron = await this.safeCronStats(win);
    const rows = cron.byCronModel
      .map((a) => {
        const sepIdx = a.key1.indexOf(":");
        const agentId = sepIdx === -1 ? a.key1 : a.key1.slice(0, sepIdx);
        const cronName = sepIdx === -1 ? "" : a.key1.slice(sepIdx + 1);
        return [agentId, cronName, a.key2, ...tokenCells(a), a.costUsd ?? 0];
      })
      .sort((a, b) => Number(b[7]) - Number(a[7]));
    return table(
      ["agent_id", "cron_name", "model", ...tokenColumns(), "cost_usd"],
      rows,
    );
  }

  // ─── Graceful degradation helpers ─────────────────────────────────────────

  private async safeCronStats(win: {
    from: string;
    to: string;
  }): Promise<CronRunTokenStats> {
    return this.admin.cronRunTokenStats(win).catch((e) => {
      if (e instanceof AdminMetricsClientError) {
        console.error(
          `[metrics] cronRunTokenStats failed: ${e.message}; falling back to zero aggregates`,
        );
        return ZERO_CRON_STATS;
      }
      throw e;
    });
  }

  private async safeChatStats(win: {
    from: string;
    to: string;
  }): Promise<ChatTokenStats> {
    return this.admin.chatTokenStats(win).catch((e) => {
      if (e instanceof AdminMetricsClientError) {
        console.error(
          `[metrics] chatTokenStats failed: ${e.message}; falling back to zero aggregates`,
        );
        return ZERO_CHAT_STATS;
      }
      throw e;
    });
  }

  // ─ Cost efficiency ─

  /**
   * costEfficiency() — reads run-level cost data from admin cronRunTokenStats.
   *
   * Computes routedUsd (actual cost from admin aggregate) and opusUsd (all-Opus
   * counterfactual via calculateCost) for each model family at three scopes.
   * No Task or TaskRecord dependency.
   *
   * Columns: scope, model_family, routed_usd, opus_usd, savings_usd
   *   - scope="fleet"          → fleet-wide totals from byModel (summed across agents)
   *   - scope="agent:<agentId>"→ per-agent/per-model from byModel (individual agent rows)
   *   - scope="cron:<key1>"   → per-cron×model from byCronModel
   */
  private async costEfficiency(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const columns = [
      "scope",
      "model_family",
      "routed_usd",
      "opus_usd",
      "savings_usd",
    ];

    const cronStats = await this.safeCronStats(win);

    const rows: unknown[][] = [];

    // ── Fleet-wide rows (byModel aggregated across all agents) ────────────────
    // Collapse multiple agents' byModel rows into a single per-model-family total.
    const fleetByModel = new Map<
      string,
      { input: number; output: number; cacheRead: number; cacheCreation: number; costUsd: number }
    >();

    for (const entry of cronStats.byModel) {
      const modelFamily = normalizeModelToRateKey(entry.key2) ?? entry.key2;
      const existing = fleetByModel.get(modelFamily);
      if (existing) {
        existing.input += entry.input;
        existing.output += entry.output;
        existing.cacheRead += entry.cacheRead;
        existing.cacheCreation += entry.cacheCreation;
        existing.costUsd += entry.costUsd ?? 0;
      } else {
        fleetByModel.set(modelFamily, {
          input: entry.input,
          output: entry.output,
          cacheRead: entry.cacheRead,
          cacheCreation: entry.cacheCreation,
          costUsd: entry.costUsd ?? 0,
        });
      }
    }

    for (const [modelFamily, agg] of fleetByModel) {
      const routedUsd = agg.costUsd;
      const opusUsd = calculateCost(
        {
          input_tokens: agg.input,
          output_tokens: agg.output,
          cache_read_input_tokens: agg.cacheRead,
          cache_creation_input_tokens: agg.cacheCreation,
        },
        OPUS_MODEL,
      );
      const savingsUsd = opusUsd - routedUsd;
      rows.push(["fleet", modelFamily, routedUsd, opusUsd, savingsUsd]);
    }

    // ── Per-agent/per-model rows (byModel, individual agent entries) ─────────
    for (const entry of cronStats.byModel) {
      const modelFamily = normalizeModelToRateKey(entry.key2) ?? entry.key2;
      const routedUsd = entry.costUsd ?? 0;
      const opusUsd = calculateCost(
        {
          input_tokens: entry.input,
          output_tokens: entry.output,
          cache_read_input_tokens: entry.cacheRead,
          cache_creation_input_tokens: entry.cacheCreation,
        },
        OPUS_MODEL,
      );
      const savingsUsd = opusUsd - routedUsd;
      rows.push([`agent:${entry.key1}`, modelFamily, routedUsd, opusUsd, savingsUsd]);
    }

    // ── Per-cron×model rows (byCronModel) ────────────────────────────────────
    for (const entry of cronStats.byCronModel) {
      const modelFamily = normalizeModelToRateKey(entry.key2) ?? entry.key2;
      const routedUsd = entry.costUsd ?? 0;
      const opusUsd = calculateCost(
        {
          input_tokens: entry.input,
          output_tokens: entry.output,
          cache_read_input_tokens: entry.cacheRead,
          cache_creation_input_tokens: entry.cacheCreation,
        },
        OPUS_MODEL,
      );
      const savingsUsd = opusUsd - routedUsd;
      rows.push([`cron:${entry.key1}`, modelFamily, routedUsd, opusUsd, savingsUsd]);
    }

    return table(columns, rows);
  }
}
