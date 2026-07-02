/**
 * Unit tests for the pure cron-expression validator in agent-cron-jobs.ts.
 * Pure logic, no I/O — see docs/testing.md for the unit-layer contract.
 */
import { describe, expect, test } from "bun:test";
import { isValidCron } from "./agent-cron-jobs.ts";

describe("isValidCron", () => {
  test("accepts standard 5-field schedules", () => {
    expect(isValidCron("0 9 * * *")).toBe(true);
    expect(isValidCron("*/5 * * * *")).toBe(true);
    expect(isValidCron("0 4 * * 1")).toBe(true);
  });

  // The staggered pipeline schedules (SYSTEM_CRONS) use comma-separated
  // minute lists like "0,30" to keep a 30-minute cadence while firing at a
  // distinct offset from sibling crons. Confirm the validator accepts them.
  test("accepts comma-separated minute lists", () => {
    expect(isValidCron("0,30 * * * *")).toBe(true);
    expect(isValidCron("5,35 * * * *")).toBe(true);
    expect(isValidCron("10,40 * * * *")).toBe(true);
    expect(isValidCron("15,45 * * * *")).toBe(true);
    expect(isValidCron("20,50 * * * *")).toBe(true);
  });

  test("accepts comma lists in other fields", () => {
    expect(isValidCron("0 9 * * 1,3,5")).toBe(true);
    expect(isValidCron("0 9,17 * * *")).toBe(true);
  });

  test("rejects schedules without exactly 5 fields", () => {
    expect(isValidCron("0 9 * *")).toBe(false);
    expect(isValidCron("0 9 * * * *")).toBe(false);
    expect(isValidCron("")).toBe(false);
  });

  test("rejects non-cron garbage", () => {
    expect(isValidCron("not-a-cron")).toBe(false);
    expect(isValidCron("bad")).toBe(false);
  });
});
