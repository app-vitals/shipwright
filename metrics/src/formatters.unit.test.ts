/**
 * metrics/src/formatters.test.ts
 * Tests for date range resolution, custom range validation, and response envelope.
 *
 * All presets and the validation "future" check anchor on America/Los_Angeles
 * so the response meta agrees with the timezone-aware HogQL queries.
 */

import { describe, expect, test } from "bun:test";
import { FixedClock } from "./lib/test-helpers.ts";
import {
  resolveDateRangeForMeta,
  resolvePreset,
  validateCustomRange,
  wrapResponse,
} from "./formatters.ts";

const PST_TZ = "America/Los_Angeles";

/** Returns the YYYY-MM-DD LA-local date for a Date instant. */
function laDateString(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: PST_TZ });
}

/** Returns the LA-local hour (0–23) for a Date instant. */
function laHour(d: Date): number {
  return Number.parseInt(
    d.toLocaleString("en-US", {
      timeZone: PST_TZ,
      hour: "2-digit",
      hour12: false,
    }),
    10,
  );
}

// ─── resolvePreset ────────────────────────────────────────────────────────────

describe("resolvePreset", () => {
  test("today — from is LA midnight, to is LA end-of-day", () => {
    const result = resolvePreset("today");
    const fromDate = new Date(result.from);
    const toDate = new Date(result.to);

    const todayLA = laDateString(new Date());
    expect(laDateString(fromDate)).toBe(todayLA);
    expect(laDateString(toDate)).toBe(todayLA);
    expect(laHour(fromDate)).toBe(0);
    expect(laHour(toDate)).toBe(23);
    expect(result.preset).toBe("today");
  });

  test("7d — spans 7 LA days inclusive of today", () => {
    const result = resolvePreset("7d");
    const fromDate = new Date(result.from);
    const toDate = new Date(result.to);

    // 7 days inclusive ≈ 6 day diff; allow a few hours' slack for DST transitions
    const diffHours =
      (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThanOrEqual(6 * 24 - 1);
    expect(diffHours).toBeLessThanOrEqual(7 * 24 + 1);

    expect(laHour(fromDate)).toBe(0);
    expect(laHour(toDate)).toBe(23);
    expect(result.preset).toBe("7d");
  });

  test("30d — spans 30 LA days inclusive of today", () => {
    const result = resolvePreset("30d");
    const fromDate = new Date(result.from);
    const toDate = new Date(result.to);

    const diffHours =
      (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThanOrEqual(29 * 24 - 1);
    expect(diffHours).toBeLessThanOrEqual(30 * 24 + 1);
    expect(result.preset).toBe("30d");
  });

  test("90d — spans 90 LA days inclusive of today", () => {
    const result = resolvePreset("90d");
    const fromDate = new Date(result.from);
    const toDate = new Date(result.to);

    const diffHours =
      (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThanOrEqual(89 * 24 - 1);
    expect(diffHours).toBeLessThanOrEqual(90 * 24 + 1);
    expect(laHour(fromDate)).toBe(0);
    expect(laHour(toDate)).toBe(23);
    expect(result.preset).toBe("90d");
  });

  test("all presets return ISO strings", () => {
    for (const preset of ["today", "7d", "30d", "90d"] as const) {
      const result = resolvePreset(preset);
      expect(() => new Date(result.from)).not.toThrow();
      expect(() => new Date(result.to)).not.toThrow();
      expect(result.from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(result.to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  test("from is always before to", () => {
    for (const preset of ["today", "7d", "30d", "90d"] as const) {
      const result = resolvePreset(preset);
      expect(new Date(result.from).getTime()).toBeLessThan(
        new Date(result.to).getTime(),
      );
    }
  });
});

// ─── validateCustomRange ──────────────────────────────────────────────────────

describe("validateCustomRange", () => {
  test("valid past range returns null", () => {
    expect(validateCustomRange("2026-01-01", "2026-03-31")).toBeNull();
  });

  test("from equal to to returns error", () => {
    const err = validateCustomRange("2026-04-01", "2026-04-01");
    expect(err).toBeTruthy();
    expect(err).toContain("from must be before to");
  });

  test("from after to returns error", () => {
    const err = validateCustomRange("2026-04-03", "2026-04-01");
    expect(err).toBeTruthy();
    expect(err).toContain("from must be before to");
  });

  test("to date in the future returns error", () => {
    // far future date
    const err = validateCustomRange("2026-01-01", "2099-12-31");
    expect(err).toBeTruthy();
    expect(err).toContain("future");
  });

  test("to date of LA today is valid", () => {
    const todayLA = laDateString(new Date());
    // Subtract 1 day in LA wall-clock for "from"
    const yesterdayLA = (() => {
      const d = new Date(`${todayLA}T00:00:00.000Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();
    expect(validateCustomRange(yesterdayLA, todayLA)).toBeNull();
  });

  test("invalid date format returns error", () => {
    expect(validateCustomRange("garbage", "2026-04-01")).toContain(
      "invalid date format",
    );
    expect(validateCustomRange("2026-04-01", "garbage")).toContain(
      "invalid date format",
    );
    expect(validateCustomRange("2026-13-45", "2026-04-01")).toContain(
      "invalid date format",
    );
  });
});

// ─── resolveDateRangeForMeta ──────────────────────────────────────────────────

describe("resolveDateRangeForMeta", () => {
  test("preset 'today' resolves to LA today range", () => {
    const result = resolveDateRangeForMeta("today", undefined, undefined);
    const fromDate = new Date(result.from);
    expect(laDateString(fromDate)).toBe(laDateString(new Date()));
    expect(laHour(fromDate)).toBe(0);
  });

  test("preset '7d' resolves to ~7-day range", () => {
    const result = resolveDateRangeForMeta("7d", undefined, undefined);
    const fromDate = new Date(result.from);
    const toDate = new Date(result.to);
    const diffHours =
      (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThanOrEqual(6 * 24 - 1);
    expect(diffHours).toBeLessThanOrEqual(7 * 24 + 1);
  });

  test("preset '30d' resolves to ~30-day range", () => {
    const result = resolveDateRangeForMeta("30d", undefined, undefined);
    const fromDate = new Date(result.from);
    const toDate = new Date(result.to);
    const diffHours =
      (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThanOrEqual(29 * 24 - 1);
    expect(diffHours).toBeLessThanOrEqual(30 * 24 + 1);
  });

  test("custom from/to anchors on LA day boundaries", () => {
    const result = resolveDateRangeForMeta(
      undefined,
      "2026-04-01",
      "2026-04-03",
    );
    const fromDate = new Date(result.from);
    const toDate = new Date(result.to);
    expect(laDateString(fromDate)).toBe("2026-04-01");
    expect(laDateString(toDate)).toBe("2026-04-03");
    expect(laHour(fromDate)).toBe(0);
    expect(laHour(toDate)).toBe(23);
  });

  test("fallback (no params) defaults to 'today' (matches dashboard default)", () => {
    const result = resolveDateRangeForMeta(undefined, undefined, undefined);
    const fromDate = new Date(result.from);
    expect(laDateString(fromDate)).toBe(laDateString(new Date()));
    expect(laHour(fromDate)).toBe(0);
  });

  test("unknown preset string falls back to 'today'", () => {
    const result = resolveDateRangeForMeta("ytd", undefined, undefined);
    const fromDate = new Date(result.from);
    expect(laDateString(fromDate)).toBe(laDateString(new Date()));
    expect(laHour(fromDate)).toBe(0);
  });

  test("preset '90d' resolves to ~90-day range", () => {
    const result = resolveDateRangeForMeta("90d", undefined, undefined);
    const fromDate = new Date(result.from);
    const toDate = new Date(result.to);
    const diffHours =
      (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThanOrEqual(89 * 24 - 1);
    expect(diffHours).toBeLessThanOrEqual(90 * 24 + 1);
  });
});

// ─── wrapResponse ─────────────────────────────────────────────────────────────

describe("wrapResponse", () => {
  test("wraps data with meta envelope", () => {
    const data = { tasksCompleted: 5, ciPasses: 10 };
    const meta = {
      dateRange: {
        from: "2026-04-01T00:00:00.000Z",
        to: "2026-04-07T23:59:59.999Z",
      },
      generatedAt: "2026-04-03T12:00:00.000Z",
      queryTimeMs: 42,
    };

    const result = wrapResponse(data, meta);

    expect(result.data).toBe(data);
    expect(result.meta).toBe(meta);
    expect(result.data.tasksCompleted).toBe(5);
    expect(result.meta.queryTimeMs).toBe(42);
    expect(result.meta.generatedAt).toBe("2026-04-03T12:00:00.000Z");
  });

  test("preserves data reference identity", () => {
    const data = { rows: [{ period: "2026-04-01" }] };
    const meta = {
      dateRange: {
        from: "2026-04-01T00:00:00.000Z",
        to: "2026-04-01T23:59:59.999Z",
      },
      generatedAt: new Date().toISOString(),
      queryTimeMs: 10,
    };

    const result = wrapResponse(data, meta);
    expect(result.data).toBe(data);
    expect(result.data.rows).toBe(data.rows);
  });
});

// ─── resolvePreset / validateCustomRange — clock injection ────────────────────

describe("resolvePreset — clock injection", () => {
  test("uses clock.now() as anchor instead of wall-clock", () => {
    // Fix clock to a known LA date: 2026-01-15 (PST, UTC-8, so 08:00 UTC = midnight PST)
    const clock = FixedClock("2026-01-15T08:00:00.000Z");

    const result = resolvePreset("today", clock);
    const fromDate = new Date(result.from);
    const toDate = new Date(result.to);

    // LA date for 2026-01-15T08:00:00Z (= midnight PST) should be 2026-01-15
    expect(
      fromDate.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }),
    ).toBe("2026-01-15");
    expect(
      toDate.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }),
    ).toBe("2026-01-15");
  });

  test("7d preset uses clock.now() as anchor", () => {
    const clock = FixedClock("2026-01-15T08:00:00.000Z");
    const result = resolvePreset("7d", clock);
    const fromDate = new Date(result.from);
    const toDate = new Date(result.to);

    // To date should be 2026-01-15 (today by clock)
    expect(
      toDate.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }),
    ).toBe("2026-01-15");
    // From date should be 6 days earlier
    expect(
      fromDate.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }),
    ).toBe("2026-01-09");
  });
});

describe("validateCustomRange — clock injection", () => {
  test("uses clock.now() to determine 'today' for future check", () => {
    // Fix clock to 2026-01-15 LA time
    const clock = FixedClock("2026-01-15T08:00:00.000Z");

    // 2026-01-16 would be tomorrow by this clock → error
    const err = validateCustomRange("2026-01-01", "2026-01-16", clock);
    expect(err).toContain("future");

    // 2026-01-15 is today by this clock → valid
    const ok = validateCustomRange("2026-01-01", "2026-01-15", clock);
    expect(ok).toBeNull();
  });
});
