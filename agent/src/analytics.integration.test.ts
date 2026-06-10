/**
 * Tests for agent/src/analytics.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createAnalyticsStore } from "./analytics.ts";

const ANALYTICS_DIR = `/tmp/shipwright-analytics-test-${process.pid}`;

afterEach(() => {
  try {
    rmSync(ANALYTICS_DIR, { recursive: true, force: true });
  } catch {}
});

describe("analytics — track", () => {
  test("records an event and retrieves it in summary", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    store.track({ type: "message", sessionKey: "C1:ts1", durationMs: 500 });

    const summary = store.summarize();
    expect(summary.totalEvents).toBe(1);
    expect(summary.messages).toBe(1);
    expect(summary.uniqueSessions).toBe(1);
    expect(summary.avgResponseMs).toBe(500);
  });

  test("tracks multiple event types", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    store.track({ type: "message", sessionKey: "C1:ts1", durationMs: 200 });
    store.track({ type: "mention", sessionKey: "C2:ts2", durationMs: 300 });
    store.track({ type: "cron" });
    store.track({ type: "error", error: "spawn failed" });
    store.track({ type: "session_start", sessionKey: "C1:ts1" });
    store.track({ type: "session_fallback", sessionKey: "C3:ts3" });

    const summary = store.summarize();
    expect(summary.totalEvents).toBe(6);
    expect(summary.messages).toBe(1);
    expect(summary.mentions).toBe(1);
    expect(summary.cronJobs).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.sessionStarts).toBe(1);
    expect(summary.sessionFallbacks).toBe(1);
    expect(summary.uniqueSessions).toBe(3);
  });

  test("events include timestamp", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    const before = Date.now();
    store.track({ type: "message" });
    const after = Date.now();

    const today = new Date().toISOString().slice(0, 10);
    const events = store.loadDay(today).events;
    expect(events.length).toBe(1);
    expect(events[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(events[0].timestamp).toBeLessThanOrEqual(after);
  });

  test("events on different calendar days land in separate daily files", () => {
    mkdirSync(ANALYTICS_DIR, { recursive: true });

    // Write events directly to two different day files
    writeFileSync(
      `${ANALYTICS_DIR}/2099-06-01.json`,
      JSON.stringify({
        date: "2099-06-01",
        events: [{ type: "message", timestamp: 1000, durationMs: 100 }],
      }),
    );
    writeFileSync(
      `${ANALYTICS_DIR}/2099-06-02.json`,
      JSON.stringify({
        date: "2099-06-02",
        events: [
          { type: "message", timestamp: 2000, durationMs: 200 },
          { type: "cron", timestamp: 3000 },
        ],
      }),
    );

    const store = createAnalyticsStore(ANALYTICS_DIR);
    const day1 = store.loadDay("2099-06-01");
    const day2 = store.loadDay("2099-06-02");

    expect(day1.events.length).toBe(1);
    expect(day1.events[0].type).toBe("message");
    expect(day2.events.length).toBe(2);
    expect(day2.events.map((e) => e.type)).toEqual(["message", "cron"]);
  });
});

describe("analytics — summarize", () => {
  test("returns zeros for empty day", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    const summary = store.summarize("2099-01-01");
    expect(summary.totalEvents).toBe(0);
    expect(summary.messages).toBe(0);
    expect(summary.avgResponseMs).toBeNull();
    expect(summary.p95ResponseMs).toBeNull();
    expect(summary.uniqueSessions).toBe(0);
  });

  test("calculates avg and p95 response times", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    for (let i = 1; i <= 10; i++) {
      store.track({ type: "message", durationMs: i * 100 });
    }
    const summary = store.summarize();
    expect(summary.avgResponseMs).toBe(550);
    expect(summary.p95ResponseMs).toBe(1000);
  });

  test("p95 works with small dataset", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    store.track({ type: "message", durationMs: 100 });
    store.track({ type: "message", durationMs: 200 });
    const summary = store.summarize();
    expect(summary.p95ResponseMs).toBe(200);
  });

  test("unique sessions deduplicates by sessionKey", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    store.track({ type: "message", sessionKey: "C1:ts1" });
    store.track({ type: "message", sessionKey: "C1:ts1" });
    store.track({ type: "mention", sessionKey: "C1:ts1" });
    store.track({ type: "message", sessionKey: "C2:ts2" });
    const summary = store.summarize();
    expect(summary.uniqueSessions).toBe(2);
  });

  test("metadata is stored on events", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    store.track({
      type: "message",
      metadata: { channel: "C1", isThread: true },
    });
    const today = new Date().toISOString().slice(0, 10);
    const events = store.loadDay(today).events;
    expect(events[0].metadata).toEqual({ channel: "C1", isThread: true });
  });
});

describe("analytics — summarizeRange", () => {
  test("returns empty array for inverted range", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    const result = store.summarizeRange("2099-01-10", "2099-01-01");
    expect(result).toEqual([]);
  });

  test("returns single day for same start/end", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    const result = store.summarizeRange("2099-01-01", "2099-01-01");
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2099-01-01");
  });

  test("returns one summary per day in range", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    const result = store.summarizeRange("2099-01-01", "2099-01-03");
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.date)).toEqual([
      "2099-01-01",
      "2099-01-02",
      "2099-01-03",
    ]);
  });

  test("empty days return zero counts", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    const result = store.summarizeRange("2099-01-01", "2099-01-02");
    for (const s of result) {
      expect(s.totalEvents).toBe(0);
      expect(s.avgResponseMs).toBeNull();
    }
  });
});

describe("analytics — rollupWeek", () => {
  test("spans 7 days ending on endDate", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    const rollup = store.rollupWeek("2099-01-07");
    expect(rollup.startDate).toBe("2099-01-01");
    expect(rollup.endDate).toBe("2099-01-07");
  });

  test("zero counts for empty week", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    const rollup = store.rollupWeek("2099-12-31");
    expect(rollup.totalMessages).toBe(0);
    expect(rollup.totalMentions).toBe(0);
    expect(rollup.totalErrors).toBe(0);
    expect(rollup.activeDays).toBe(0);
    expect(rollup.uniqueSessions).toBe(0);
    expect(rollup.uniqueUsers).toBe(0);
    expect(rollup.totalInputTokens).toBeNull();
    expect(rollup.totalOutputTokens).toBeNull();
    expect(rollup.avgResponseMs).toBeNull();
    expect(rollup.errorRate).toBeNull();
    expect(rollup.topDay).toBeNull();
  });

  test("activeDays counts only days with messages or mentions", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    mkdirSync(ANALYTICS_DIR, { recursive: true });
    const makeDay = (date: string, events: object[]) =>
      writeFileSync(
        `${ANALYTICS_DIR}/${date}.json`,
        JSON.stringify({ date, events }),
      );
    makeDay("2099-01-01", [
      { type: "message", timestamp: 1000, durationMs: 100 },
    ]);
    makeDay("2099-01-02", [{ type: "cron", timestamp: 2000 }]);
    makeDay("2099-01-03", [
      { type: "mention", timestamp: 3000, durationMs: 200 },
    ]);
    const rollup = store.rollupWeek("2099-01-07");
    expect(rollup.activeDays).toBe(2);
    expect(rollup.totalCronJobs).toBe(1);
  });

  test("errorRate computed correctly", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    mkdirSync(ANALYTICS_DIR, { recursive: true });
    writeFileSync(
      `${ANALYTICS_DIR}/2099-02-01.json`,
      JSON.stringify({
        date: "2099-02-01",
        events: [
          { type: "message", timestamp: 1000, durationMs: 100 },
          { type: "message", timestamp: 2000, durationMs: 200 },
          { type: "error", timestamp: 3000 },
        ],
      }),
    );
    const rollup = store.rollupWeek("2099-02-07");
    expect(rollup.totalMessages).toBe(2);
    expect(rollup.totalErrors).toBe(1);
    expect(rollup.errorRate).toBeCloseTo(0.5);
  });

  test("topDay is the day with most messages", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    mkdirSync(ANALYTICS_DIR, { recursive: true });
    writeFileSync(
      `${ANALYTICS_DIR}/2099-03-01.json`,
      JSON.stringify({
        date: "2099-03-01",
        events: [{ type: "message", timestamp: 1000, durationMs: 100 }],
      }),
    );
    writeFileSync(
      `${ANALYTICS_DIR}/2099-03-03.json`,
      JSON.stringify({
        date: "2099-03-03",
        events: [
          { type: "message", timestamp: 2000, durationMs: 100 },
          { type: "message", timestamp: 3000, durationMs: 100 },
        ],
      }),
    );
    const rollup = store.rollupWeek("2099-03-07");
    expect(rollup.topDay).toBe("2099-03-03");
  });

  test("uniqueSessions deduplicates across days", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    mkdirSync(ANALYTICS_DIR, { recursive: true });
    writeFileSync(
      `${ANALYTICS_DIR}/2099-04-01.json`,
      JSON.stringify({
        date: "2099-04-01",
        events: [
          { type: "message", timestamp: 1000, sessionKey: "C1:ts1" },
          { type: "message", timestamp: 2000, sessionKey: "C2:ts2" },
        ],
      }),
    );
    writeFileSync(
      `${ANALYTICS_DIR}/2099-04-02.json`,
      JSON.stringify({
        date: "2099-04-02",
        events: [
          { type: "message", timestamp: 3000, sessionKey: "C1:ts1" },
          { type: "message", timestamp: 4000, sessionKey: "C3:ts3" },
        ],
      }),
    );
    const rollup = store.rollupWeek("2099-04-07");
    expect(rollup.uniqueSessions).toBe(3);
  });
});

describe("analytics — loadDay", () => {
  test("returns empty stats for nonexistent date", () => {
    const store = createAnalyticsStore(ANALYTICS_DIR);
    const stats = store.loadDay("2099-12-31");
    expect(stats.date).toBe("2099-12-31");
    expect(stats.events).toEqual([]);
  });

  test("persists across store instances", () => {
    const store1 = createAnalyticsStore(ANALYTICS_DIR);
    store1.track({ type: "cron" });
    const store2 = createAnalyticsStore(ANALYTICS_DIR);
    const today = new Date().toISOString().slice(0, 10);
    expect(store2.loadDay(today).events.length).toBe(1);
  });
});
