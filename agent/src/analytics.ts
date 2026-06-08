/**
 * Agent usage analytics — lightweight event tracking for observability.
 *
 * Tracks: sessions started, messages handled, errors, response times.
 * File-backed JSON store with daily rollover. Designed for agent-native
 * querying (CLI, cron reports, health endpoint extension).
 *
 * Zero external dependencies. No database required.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AnalyticsEvent {
  type:
    | "message"
    | "mention"
    | "cron"
    | "error"
    | "session_start"
    | "session_fallback";
  timestamp: number; // epoch ms
  sessionKey?: string;
  durationMs?: number;
  error?: string;
  metadata?: Record<string, string | number | boolean>;
}

interface DailyStats {
  date: string; // YYYY-MM-DD
  events: AnalyticsEvent[];
}

export interface AnalyticsSummary {
  date: string;
  totalEvents: number;
  messages: number;
  mentions: number;
  cronJobs: number;
  errors: number;
  sessionStarts: number;
  sessionFallbacks: number;
  avgResponseMs: number | null;
  p95ResponseMs: number | null;
  uniqueSessions: number;
}

interface WeeklyRollup {
  startDate: string; // YYYY-MM-DD (inclusive)
  endDate: string; // YYYY-MM-DD (inclusive)
  totalMessages: number;
  totalMentions: number;
  totalCronJobs: number;
  totalErrors: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  uniqueUsers: number;
  uniqueSessions: number;
  activeDays: number; // days with >= 1 message or mention
  avgResponseMs: number | null;
  errorRate: number | null; // errors / (messages + mentions), null if 0 interactions
  topDay: string | null; // YYYY-MM-DD with highest message count
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateRange(startDate: string, endDate: string): string[] {
  const result: string[] = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (start > end) return result;
  const cur = new Date(start);
  while (cur <= end) {
    result.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return result;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function createAnalyticsStore(dir: string) {
  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  function filePath(date: string): string {
    return join(dir, `${date}.json`);
  }

  function loadDay(date: string): DailyStats {
    const fp = filePath(date);
    try {
      return JSON.parse(readFileSync(fp, "utf8")) as DailyStats;
    } catch {
      return { date, events: [] };
    }
  }

  function saveDay(stats: DailyStats): void {
    const fp = filePath(stats.date);
    writeFileSync(fp, JSON.stringify(stats, null, 2));
  }

  function track(event: Omit<AnalyticsEvent, "timestamp">): void {
    const date = todayString();
    const stats = loadDay(date);
    stats.events.push({ ...event, timestamp: Date.now() });
    saveDay(stats);
  }

  function summarize(date: string = todayString()): AnalyticsSummary {
    const stats = loadDay(date);
    const events = stats.events;

    const durations = events
      .filter(
        (e): e is AnalyticsEvent & { durationMs: number } =>
          e.durationMs !== undefined,
      )
      .map((e) => e.durationMs)
      .sort((a, b) => a - b);

    const sessions = new Set(
      events.filter((e) => e.sessionKey).map((e) => e.sessionKey),
    );

    return {
      date,
      totalEvents: events.length,
      messages: events.filter((e) => e.type === "message").length,
      mentions: events.filter((e) => e.type === "mention").length,
      cronJobs: events.filter((e) => e.type === "cron").length,
      errors: events.filter((e) => e.type === "error").length,
      sessionStarts: events.filter((e) => e.type === "session_start").length,
      sessionFallbacks: events.filter((e) => e.type === "session_fallback")
        .length,
      avgResponseMs:
        durations.length > 0
          ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
          : null,
      p95ResponseMs: durations.length > 0 ? percentile(durations, 95) : null,
      uniqueSessions: sessions.size,
    };
  }

  function summarizeRange(
    startDate: string,
    endDate: string,
  ): AnalyticsSummary[] {
    return dateRange(startDate, endDate).map((date) => summarize(date));
  }

  function rollupWeek(endDate: string = todayString()): WeeklyRollup {
    const start = new Date(`${endDate}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 6);
    const startDate = start.toISOString().slice(0, 10);

    const days = summarizeRange(startDate, endDate);

    let totalMessages = 0;
    let totalMentions = 0;
    let totalCronJobs = 0;
    let totalErrors = 0;
    let totalInputTokens: number | null = null;
    let totalOutputTokens: number | null = null;
    const uniqueSessionsSet = new Set<string>();
    const uniqueUsersSet = new Set<string>();
    let activeDays = 0;
    let totalDurationMs = 0;
    let durationCount = 0;
    let topDay: string | null = null;
    let topDayCount = 0;

    for (const day of days) {
      totalMessages += day.messages;
      totalMentions += day.mentions;
      totalCronJobs += day.cronJobs;
      totalErrors += day.errors;

      // Token aggregation: sum defined values; null only if all days null
      if (
        (day as AnalyticsSummary & { totalInputTokens?: number | null })
          .totalInputTokens != null
      ) {
        totalInputTokens =
          (totalInputTokens ?? 0) +
          ((day as AnalyticsSummary & { totalInputTokens?: number | null })
            .totalInputTokens as number);
      }
      if (
        (day as AnalyticsSummary & { totalOutputTokens?: number | null })
          .totalOutputTokens != null
      ) {
        totalOutputTokens =
          (totalOutputTokens ?? 0) +
          ((day as AnalyticsSummary & { totalOutputTokens?: number | null })
            .totalOutputTokens as number);
      }

      if (day.messages + day.mentions >= 1) activeDays++;

      if (day.avgResponseMs !== null) {
        // Reconstruct total duration from avg (best approximation without per-event data)
        const interactions = day.messages + day.mentions;
        if (interactions > 0) {
          totalDurationMs += day.avgResponseMs * interactions;
          durationCount += interactions;
        }
      }

      if (day.messages > topDayCount) {
        topDayCount = day.messages;
        topDay = day.date;
      }

      // Collect sessions and users from raw daily data
      const raw = loadDay(day.date);
      for (const e of raw.events) {
        if (e.sessionKey) uniqueSessionsSet.add(e.sessionKey);
        const u = (e as AnalyticsEvent & { userId?: string }).userId;
        if (u) uniqueUsersSet.add(u);
      }
    }

    const interactions = totalMessages + totalMentions;
    const avgResponseMs =
      durationCount > 0 ? Math.round(totalDurationMs / durationCount) : null;
    const errorRate = interactions > 0 ? totalErrors / interactions : null;

    return {
      startDate,
      endDate,
      totalMessages,
      totalMentions,
      totalCronJobs,
      totalErrors,
      totalInputTokens,
      totalOutputTokens,
      uniqueUsers: uniqueUsersSet.size,
      uniqueSessions: uniqueSessionsSet.size,
      activeDays,
      avgResponseMs,
      errorRate,
      topDay: topDayCount > 0 ? topDay : null,
    };
  }

  return { track, summarize, summarizeRange, rollupWeek, loadDay };
}
