/**
 * admin/src/coding/system-cron-runs.unit.test.ts
 * Unit tests for the Recent runs row formatting (SCR-1.10).
 */

import { describe, expect, it } from "bun:test";
import {
  formatScheduledFor,
  formatTaskCount,
  formatTriggerRow,
  recentTriggers,
} from "./system-cron-runs.ts";

const trig = (scheduledFor: string, taskCount = 1) => ({
  scheduledFor,
  claimedAt: scheduledFor,
  taskCount,
});

describe("formatScheduledFor", () => {
  it("renders minute precision in UTC", () => {
    expect(formatScheduledFor("2026-11-14T09:00:00.000Z")).toBe(
      "2026-11-14 09:00 UTC",
    );
  });
  it("returns unparseable input unchanged", () => {
    expect(formatScheduledFor("not-a-date")).toBe("not-a-date");
  });
});

describe("formatTaskCount", () => {
  it("pluralizes", () => {
    expect(formatTaskCount(0)).toBe("0 tasks created");
    expect(formatTaskCount(1)).toBe("1 task created");
    expect(formatTaskCount(3)).toBe("3 tasks created");
  });
});

describe("formatTriggerRow", () => {
  it("joins scheduled time and task count", () => {
    expect(formatTriggerRow(trig("2026-11-14T09:00:00.000Z", 2))).toBe(
      "2026-11-14 09:00 UTC — 2 tasks created",
    );
  });
});

describe("recentTriggers", () => {
  it("sorts newest first and caps at the limit", () => {
    const input = [1, 2, 3, 4, 5, 6, 7].map((d) =>
      trig(`2026-11-0${d}T09:00:00.000Z`),
    );
    const out = recentTriggers(input);
    expect(out).toHaveLength(5);
    expect(out[0]?.scheduledFor).toBe("2026-11-07T09:00:00.000Z");
    expect(out[4]?.scheduledFor).toBe("2026-11-03T09:00:00.000Z");
    expect(input[0]?.scheduledFor).toBe("2026-11-01T09:00:00.000Z");
  });
});
