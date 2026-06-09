/**
 * metrics/src/providers/sqlite-provider.ts
 * MetricsProvider backed by the local SQLite event store (LDS-1.1). Each
 * MetricQuery kind reads the relevant event rows from the store within the
 * resolved date window and aggregates them into a MetricTable whose columns
 * EXACTLY match what the api.ts handlers expect — so the dashboard renders
 * identically whether the data came from PostHog or local SQLite.
 *
 * Event/property selection mirrors the HogQL builders in queries.ts. Date
 * windows are resolved via the shared `resolveQueryRange` helper so local SQL
 * and PostHog agree on what each preset / custom range means.
 */

import { type Clock, SystemClock } from "../lib/clock.ts";
import { resolveQueryRange } from "../formatters.ts";
import type { LocalEventStore, StoredEvent } from "../local-store.ts";
import type {
  MetricQuery,
  MetricTable,
  MetricsProvider,
} from "../metrics-provider.ts";
import type { QueryDateRange } from "../queries.ts";

// ─── Event-name alias sets (mirror queries.ts) ────────────────────────────────

const TASK_COMPLETED_EVENTS = [
  "shipwright_task_merged",
  "shipwright_task_complete",
  "shipwright_task_completed",
];
const TASK_REVIEWED_EVENTS = [
  "shipwright_task_approved",
  "shipwright_task_reviewed",
  "shipwright_review_complete",
];
const DASHBOARD_TZ = "America/Los_Angeles";

// ─── Value helpers ────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** Mean of the non-null numeric values, or null when none. */
function avg(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Sum of the non-null numeric values (0 when none). */
function sum(values: Array<number | null>): number {
  return values.reduce<number>((a, b) => a + (b ?? 0), 0);
}

/** Coalesced task identity: properties.task_id ?? properties.task. */
function taskKey(e: StoredEvent): string | null {
  const id = e.properties.task_id;
  if (typeof id === "string" && id) return id;
  const t = e.properties.task;
  if (typeof t === "string" && t) return t;
  return null;
}

const FEATURE_PREFIX_RE = /^[A-Z]+-[0-9]+\.[0-9]+$/;
function featurePrefix(e: StoredEvent): string | null {
  const key = taskKey(e);
  if (!key || !FEATURE_PREFIX_RE.test(key)) return null;
  const m = key.match(/^([A-Z]+)-/);
  return m ? m[1] : null;
}

/** Per-event cycle hours from started_at→ts, or null when not derivable. */
function cycleHours(e: StoredEvent): number | null {
  const start = e.properties.started_at;
  const end = e.properties.ts;
  if (typeof start !== "string" || typeof end !== "string") return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (Number.isNaN(ms)) return null;
  return ms / (1000 * 60 * 60);
}

/** LA-local YYYY-MM-DD bucket for a stored UTC timestamp. */
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

// ─── Provider ─────────────────────────────────────────────────────────────────

export class SqliteProvider implements MetricsProvider {
  constructor(
    private readonly store: LocalEventStore,
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
        return this.cycleRows(win, TASK_COMPLETED_EVENTS, "started");
      case "queueCycleMerged":
        return this.cycleRows(win, TASK_COMPLETED_EVENTS, "merged");
      case "tokensTotals":
        return this.tokensTotals(win);
      case "tokensBySessionType":
        return this.tokensGrouped(win, "session_type");
      case "tokensByAgent":
        return this.tokensGrouped(win, "agent_id");
      case "tokensTrends":
        return this.tokensTrends(win);
    }
  }

  // ─ Read helpers ─

  private events(name: string, win: { from: string; to: string }) {
    return this.store.queryByEvent(name, win);
  }

  private eventsAny(names: string[], win: { from: string; to: string }) {
    return names.flatMap((n) => this.events(n, win));
  }

  // ─ Summary ─

  private summary(win: { from: string; to: string }): MetricTable {
    const completed = this.eventsAny(TASK_COMPLETED_EVENTS, win);
    const blocked = this.events("shipwright_task_blocked", win);
    const ci = this.events("shipwright_ci_result", win);
    const simplify = this.events("shipwright_simplify_complete", win);
    const reviews = this.eventsAny(TASK_REVIEWED_EVENTS, win);

    const actualHours = completed.map((e) => {
      const a = num(e.properties.actual_h);
      return a ?? cycleHours(e);
    });

    const ciFirst = ci.filter(
      (e) => String(e.properties.passed_first_try) === "true",
    ).length;

    const complexityCount = (n: number) =>
      completed.filter((e) => num(e.properties.complexity) === n).length;

    const cascadeDepths = completed
      .filter((e) => e.properties.fix_cascade_depth != null)
      .map((e) => num(e.properties.fix_cascade_depth));

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
      avg(actualHours),
      avg(completed.map((e) => num(e.properties.estimated_h))),
      avg(completed.map((e) => num(e.properties.retries))),
      avg(completed.map((e) => num(e.properties.files_changed))),
      ci.length,
      ciFirst,
      avg(ci.map((e) => num(e.properties.fix_attempts))),
      simplify.length,
      sum(simplify.map((e) => num(e.properties.total_fixes))),
      avg(simplify.map((e) => num(e.properties.dry))),
      avg(simplify.map((e) => num(e.properties.dead_code))),
      avg(simplify.map((e) => num(e.properties.naming))),
      avg(simplify.map((e) => num(e.properties.complexity_fixes))),
      avg(simplify.map((e) => num(e.properties.consistency))),
      reviews.length,
      reviews.filter((e) => e.properties.verdict === "SHIP IT").length,
      complexityCount(1),
      complexityCount(2),
      complexityCount(3),
      complexityCount(4),
      complexityCount(5),
      avg(cascadeDepths),
    ];

    return table(columns, [row]);
  }

  // ─ Summary cycle time ─

  private summaryCycleTime(win: { from: string; to: string }): MetricTable {
    const completed = this.eventsAny(TASK_COMPLETED_EVENTS, win);
    const positive = completed
      .map(cycleHours)
      .filter((h): h is number => h !== null && h > 0);
    const avgHours = positive.length
      ? positive.reduce((a, b) => a + b, 0) / positive.length
      : null;
    return table(["avg_cycle_time_hours"], [[avgHours]]);
  }

  // ─ Trends ─

  private trends(win: { from: string; to: string }): MetricTable {
    const completed = this.eventsAny(TASK_COMPLETED_EVENTS, win);
    const blocked = this.events("shipwright_task_blocked", win);
    const ci = this.events("shipwright_ci_result", win);
    const simplify = this.events("shipwright_simplify_complete", win);
    const reviews = this.eventsAny(TASK_REVIEWED_EVENTS, win);
    const started = this.events("shipwright_task_started", win);

    const periods = new Set<string>();
    const bucketOf = (e: StoredEvent) => dayBucket(e.timestamp);
    for (const e of [
      ...completed,
      ...blocked,
      ...ci,
      ...simplify,
      ...reviews,
      ...started,
    ]) {
      periods.add(bucketOf(e));
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

    const inP = <T extends StoredEvent>(arr: T[], p: string) =>
      arr.filter((e) => bucketOf(e) === p);

    const rows = [...periods]
      .sort()
      .map((p) => {
        const c = inP(completed, p);
        const cCi = inP(ci, p);
        const cSimplify = inP(simplify, p);
        const cReviews = inP(reviews, p);

        const positiveCycle = c
          .map(cycleHours)
          .filter((h): h is number => h !== null && h > 0);
        const avgCycle = positiveCycle.length
          ? positiveCycle.reduce((a, b) => a + b, 0) / positiveCycle.length
          : null;

        const estAcc = c
          .map((e) => {
            const est = num(e.properties.estimated_h);
            const act = num(e.properties.actual_h);
            if (est === null || act === null || est <= 0) return null;
            return act / est;
          })
          .filter((v): v is number => v !== null);

        return [
          p,
          c.length,
          cCi.length,
          cCi.filter((e) => String(e.properties.passed_first_try) === "true")
            .length,
          cCi.filter((e) => String(e.properties.first_pass) === "true").length,
          cSimplify.length,
          sum(cSimplify.map((e) => num(e.properties.total_fixes))),
          inP(blocked, p).length,
          cReviews.length,
          inP(started, p).length,
          cReviews.filter((e) => e.properties.verdict === "SHIP IT").length,
          avg(
            c.map((e) => num(e.properties.actual_h) ?? cycleHours(e)),
          ),
          avg(c.map((e) => num(e.properties.estimated_h))),
          avg(c.map((e) => num(e.properties.retries))),
          avg(c.map((e) => num(e.properties.files_changed))),
          avg(cCi.map((e) => num(e.properties.fix_attempts))),
          avgCycle,
          estAcc.length
            ? estAcc.reduce((a, b) => a + b, 0) / estAcc.length
            : null,
          avg(cSimplify.map((e) => num(e.properties.dry))),
          avg(cSimplify.map((e) => num(e.properties.dead_code))),
          avg(cSimplify.map((e) => num(e.properties.naming))),
          avg(cSimplify.map((e) => num(e.properties.complexity_fixes))),
          avg(cSimplify.map((e) => num(e.properties.consistency))),
          avg(cReviews.map((e) => num(e.properties.findings))),
        ];
      });

    return table(columns, rows);
  }

  // ─ Features ─

  private groupByPrefix(events: StoredEvent[]): Map<string, StoredEvent[]> {
    const map = new Map<string, StoredEvent[]>();
    for (const e of events) {
      const p = featurePrefix(e);
      if (!p) continue;
      const arr = map.get(p) ?? [];
      arr.push(e);
      map.set(p, arr);
    }
    return map;
  }

  private featuresTasks(win: { from: string; to: string }): MetricTable {
    const completed = this.eventsAny(TASK_COMPLETED_EVENTS, win);
    const groups = this.groupByPrefix(completed);
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
        avg(group.map((e) => num(e.properties.actual_h))),
        avg(group.map((e) => num(e.properties.estimated_h))),
      ])
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    return table(columns, rows);
  }

  private featuresCi(win: { from: string; to: string }): MetricTable {
    const ci = this.events("shipwright_ci_result", win);
    const groups = this.groupByPrefix(ci);
    const columns = ["feature_prefix", "ci_total", "ci_first_pass"];
    const rows = [...groups.entries()].map(([prefix, group]) => [
      prefix,
      group.length,
      group.filter((e) => String(e.properties.passed_first_try) === "true")
        .length,
    ]);
    return table(columns, rows);
  }

  private featuresReviews(win: { from: string; to: string }): MetricTable {
    const reviews = this.eventsAny(TASK_REVIEWED_EVENTS, win);
    const groups = this.groupByPrefix(reviews);
    const columns = ["feature_prefix", "reviews_total", "reviews_ship_it"];
    const rows = [...groups.entries()].map(([prefix, group]) => [
      prefix,
      group.length,
      group.filter((e) => e.properties.verdict === "SHIP IT").length,
    ]);
    return table(columns, rows);
  }

  // ─ Queue ─

  private queueFunnel(win: { from: string; to: string }): MetricTable {
    const started = this.events("shipwright_task_started", win);
    const approved = this.eventsAny(TASK_REVIEWED_EVENTS, win);
    const merged = this.eventsAny(TASK_COMPLETED_EVENTS, win);
    const blocked = this.events("shipwright_task_blocked", win);

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
      avg(approved.map((e) => num(e.properties.findings))),
    ];
    return table(columns, [row]);
  }

  private cycleRows(
    win: { from: string; to: string },
    events: string[],
    which: "started" | "merged",
  ): MetricTable {
    const source =
      which === "started"
        ? this.events("shipwright_task_started", win)
        : this.eventsAny(events, win);
    const columns = ["task_id", "timestamp"];
    const rows = source
      .map((e) => [taskKey(e), e.timestamp])
      .filter((r) => r[0] !== null);
    return table(columns, rows);
  }

  // ─ Tokens ─

  private tokenSumRow(events: StoredEvent[]): {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
  } {
    const input = sum(events.map((e) => num(e.properties.input_tokens)));
    const output = sum(events.map((e) => num(e.properties.output_tokens)));
    const cacheRead = sum(
      events.map((e) => num(e.properties.cache_read_input_tokens)),
    );
    const cacheCreation = sum(
      events.map((e) => num(e.properties.cache_creation_input_tokens)),
    );
    return {
      input,
      output,
      cacheRead,
      cacheCreation,
      total: input + output + cacheRead + cacheCreation,
    };
  }

  private tokenColumns(groupCol?: string): string[] {
    const base = [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "total_tokens",
    ];
    return groupCol ? [groupCol, ...base] : base;
  }

  private tokensTotals(win: { from: string; to: string }): MetricTable {
    const events = this.events("agent_token_usage", win);
    const t = this.tokenSumRow(events);
    return table(this.tokenColumns(), [
      [t.input, t.output, t.cacheRead, t.cacheCreation, t.total],
    ]);
  }

  private tokensGrouped(
    win: { from: string; to: string },
    prop: "session_type" | "agent_id",
  ): MetricTable {
    const events = this.events("agent_token_usage", win);
    const groups = new Map<string, StoredEvent[]>();
    for (const e of events) {
      const key = e.properties[prop];
      const k = typeof key === "string" ? key : String(key ?? "");
      const arr = groups.get(k) ?? [];
      arr.push(e);
      groups.set(k, arr);
    }
    const rows = [...groups.entries()]
      .map(([key, group]) => {
        const t = this.tokenSumRow(group);
        return [key, t.input, t.output, t.cacheRead, t.cacheCreation, t.total];
      })
      .sort((a, b) => Number(b[5]) - Number(a[5]));
    return table(this.tokenColumns(prop), rows);
  }

  private tokensTrends(win: { from: string; to: string }): MetricTable {
    const events = this.events("agent_token_usage", win);
    const groups = new Map<string, StoredEvent[]>();
    for (const e of events) {
      const p = dayBucket(e.timestamp);
      const arr = groups.get(p) ?? [];
      arr.push(e);
      groups.set(p, arr);
    }
    const rows = [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([period, group]) => {
        const t = this.tokenSumRow(group);
        return [
          period,
          t.input,
          t.output,
          t.cacheRead,
          t.cacheCreation,
          t.total,
        ];
      });
    return table(this.tokenColumns("period"), rows);
  }
}
