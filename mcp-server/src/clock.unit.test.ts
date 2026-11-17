import { describe, expect, test } from "bun:test";
import { FixedClock, SystemClock } from "./clock.ts";

describe("clock", () => {
  test("FixedClock returns the same instant, as a fresh Date each call", () => {
    const fixed = new Date("2026-01-02T03:04:05.000Z");
    const clock = FixedClock(fixed);
    const a = clock.now();
    expect(a.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    a.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(clock.now()).not.toBe(clock.now());
  });

  test("SystemClock.now() tracks real time", () => {
    const before = Date.now();
    const got = SystemClock().now().getTime();
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(Date.now());
  });
});
