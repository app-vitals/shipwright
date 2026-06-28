/**
 * metrics/src/providers/task-store-provider.ts
 *
 * MetricsProvider backed by the Shipwright task store (tasks + PRs) and the
 * admin token-aggregation endpoints. Answers all 16 MetricQuery kinds by
 * aggregating client-side in TypeScript, emitting MetricTables whose `columns`
 * and `table()` envelope are byte-identical to sql-provider.ts — api.ts parses
 * the result positionally, so the shapes must match exactly.
 *
 * Two token sources are combined with no double-counting (AC#2): cron-run
 * tokens (the "cron" session source) and chat-daily tokens (the "chat" session
 * source) are disjoint, so summing them field-wise is the correct total.
 *
 * Where a sql-provider metric genuinely has no task-store equivalent (e.g.
 * simplify sub-scores, files-changed, retries, fix-cascade depth — those live
 * only in the PostHog event stream), the column is kept and filled with a
 * neutral empty value (null/0) rather than dropped: every kind must return a
 * valid table (AC#1).
 */

import { resolveQueryRange } from "../formatters.ts";
import type {
  AdminMetricsClient,
  TokenAggregate,
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
// live task store records `reviewState` as one of `approved | posted | pending`
// (there is no "SHIP IT" value — that's a PostHog event verdict in sql-provider).
const SHIP_IT_REVIEW_STATE = "approved";

// ─── Value helpers (mirror sql-provider) ──────────────────────────────────────

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
  constructor(
    private readonly taskStore: TaskStoreClient,
    private readonly admin: AdminMetricsClient,
    private readonly clock: Clock = SystemClock(),
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
    }
  }

  // ─ Task reads ─

  private tasks(win: { from: string; to: string }): Promise<TaskRecord[]> {
    return Promise.resolve(this.taskStore.listTasks(win));
  }

  private prs(win: { from: string; to: string }): Promise<PrRecord[]> {
    return Promise.resolve(this.taskStore.listPrs(win));
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
      "complexity_1",
      "complexity_2",
      "complexity_3",
      "complexity_4",
      "complexity_5",
      "avg_fix_cascade_depth",
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
      complexityCount(1),
      complexityCount(2),
      complexityCount(3),
      complexityCount(4),
      complexityCount(5),
      null, // avg_fix_cascade_depth — no task-store source
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
      this.admin.cronRunTokenStats(win),
      this.admin.chatTokenStats(win),
    ]);
    // Disjoint sources — summing field-wise is correct, no double count.
    const total = addAggregates(cron.totals, chat.totals);
    return table(tokenColumns(), [tokenCells(total)]);
  }

  private async tokensBySessionType(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const [cron, chat] = await Promise.all([
      this.admin.cronRunTokenStats(win),
      this.admin.chatTokenStats(win),
    ]);
    const rows = [
      ["cron", ...tokenCells(cron.totals)],
      ["chat", ...tokenCells(chat.totals)],
    ].sort((a, b) => Number(b[5]) - Number(a[5]));
    return table(tokenColumns("session_type"), rows);
  }

  private async tokensByAgent(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const [cron, chat] = await Promise.all([
      this.admin.cronRunTokenStats(win),
      this.admin.chatTokenStats(win),
    ]);
    const byAgent = new Map<string, TokenAggregate>();
    for (const a of [...cron.byAgent, ...chat.byAgent]) {
      const prev = byAgent.get(a.key);
      byAgent.set(a.key, prev ? addAggregates(prev, a) : a);
    }
    const rows = [...byAgent.entries()]
      .map(([key, a]) => [key, ...tokenCells(a)])
      .sort((x, y) => Number(y[5]) - Number(x[5]));
    return table(tokenColumns("agent_id"), rows);
  }

  private async tokensTrends(win: {
    from: string;
    to: string;
  }): Promise<MetricTable> {
    const [cron, chat] = await Promise.all([
      this.admin.cronRunTokenStats(win),
      this.admin.chatTokenStats(win),
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
      this.admin.cronRunTokenStats(win),
      this.admin.chatTokenStats(win),
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
    const cron = await this.admin.cronRunTokenStats(win);
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
    const cron = await this.admin.cronRunTokenStats(win);
    const rows = cron.byModel
      .map((a) => [a.key1, a.key2, ...tokenCells(a), a.costUsd ?? 0])
      .sort((a, b) => Number(b[6]) - Number(a[6]));
    return table(["agent_id", "model", ...tokenColumns(), "cost_usd"], rows);
  }
}
