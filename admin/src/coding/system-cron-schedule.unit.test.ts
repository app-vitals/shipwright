/**
 * admin/src/coding/system-cron-schedule.unit.test.ts
 * Slot computation for the system-cron scheduler (SCR-1.3): 5-field cron
 * parsing and dueSlots(schedule, timezone, after, until), which lists every
 * matching minute strictly after `after` and at or before `until`, oldest
 * first. Pure — every instant is passed in, no clock.
 */

import { describe, expect, it } from "bun:test";
import {
  dueSlots,
  matchesLocal,
  parseCronSchedule,
} from "./system-cron-schedule.ts";

const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

describe("parseCronSchedule", () => {
  it("rejects anything that is not five valid fields", () => {
    for (const bad of [
      "",
      "* * * *",
      "* * * * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * 32 * *",
      "* * * 13 *",
      "* * * * 8",
      "*/0 * * * *",
      "5-1 * * * *",
      "a * * * *",
      "1,,2 * * * *",
      "* * * FOO *",
    ]) {
      expect(() => parseCronSchedule(bad)).toThrow();
    }
  });

  it("accepts lists, ranges, steps, month/day names and 7 as Sunday", () => {
    const spec = parseCronSchedule("0,30 9-17/4 * JAN-mar sun,7");
    expect([...spec.minute].sort((a, b) => a - b)).toEqual([0, 30]);
    expect([...spec.hour].sort((a, b) => a - b)).toEqual([9, 13, 17]);
    expect([...spec.month].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect([...spec.dayOfWeek]).toEqual([0]);
    expect(spec.dayOfMonthRestricted).toBe(false);
    expect(spec.dayOfWeekRestricted).toBe(true);
  });

  it("treats n/step as n through the field max", () => {
    expect([...parseCronSchedule("50/5 * * * *").minute]).toEqual([50, 55]);
  });
});

describe("matchesLocal", () => {
  it("ORs day-of-month and day-of-week when both are restricted (cron semantics)", () => {
    const spec = parseCronSchedule("0 0 1 * 1");
    const at = (day: number, weekday: number) =>
      matchesLocal(spec, { minute: 0, hour: 0, day, month: 11, weekday });
    expect(at(1, 0)).toBe(true); // the 1st, a Sunday
    expect(at(2, 1)).toBe(true); // a Monday
    expect(at(3, 2)).toBe(false);
  });

  it("ANDs them when only one is restricted", () => {
    const spec = parseCronSchedule("0 0 * * 1");
    expect(
      matchesLocal(spec, { minute: 0, hour: 0, day: 1, month: 11, weekday: 0 }),
    ).toBe(false);
  });
});

describe("dueSlots", () => {
  it("lists every slot strictly after `after` up to and including `until`, oldest first", () => {
    expect(
      iso(
        dueSlots(
          "0 7 * * *",
          "UTC",
          new Date("2026-11-14T07:00:00Z"),
          new Date("2026-11-17T07:00:00Z"),
        ),
      ),
    ).toEqual([
      "2026-11-15T07:00:00.000Z",
      "2026-11-16T07:00:00.000Z",
      "2026-11-17T07:00:00.000Z",
    ]);
  });

  it("a mid-minute baseline excludes that minute's slot", () => {
    expect(
      dueSlots(
        "* * * * *",
        "UTC",
        new Date("2026-11-14T07:00:30Z"),
        new Date("2026-11-14T07:00:59Z"),
      ),
    ).toEqual([]);
    expect(
      iso(
        dueSlots(
          "* * * * *",
          "UTC",
          new Date("2026-11-14T07:00:30Z"),
          new Date("2026-11-14T07:01:00Z"),
        ),
      ),
    ).toEqual(["2026-11-14T07:01:00.000Z"]);
  });

  it("is empty when nothing is due or the window is empty/inverted", () => {
    const t = new Date("2026-11-14T07:30:00Z");
    expect(dueSlots("0 7 * * *", "UTC", t, t)).toEqual([]);
    expect(
      dueSlots("0 7 * * *", "UTC", t, new Date("2026-11-14T06:00:00Z")),
    ).toEqual([]);
  });

  it("evaluates the schedule in the definition's timezone, across a DST change", () => {
    // America/New_York leaves DST on 2026-11-01: 09:00 local is 13:00Z
    // before and 14:00Z after.
    expect(
      iso(
        dueSlots(
          "0 9 * * *",
          "America/New_York",
          new Date("2026-10-30T00:00:00Z"),
          new Date("2026-11-02T23:59:00Z"),
        ),
      ),
    ).toEqual([
      "2026-10-30T13:00:00.000Z",
      "2026-10-31T13:00:00.000Z",
      "2026-11-01T14:00:00.000Z",
      "2026-11-02T14:00:00.000Z",
    ]);
  });

  it("skips a local time that does not exist (spring-forward gap)", () => {
    // 2027-03-14 02:30 never happens in America/New_York.
    expect(
      iso(
        dueSlots(
          "30 2 * * *",
          "America/New_York",
          new Date("2027-03-13T00:00:00Z"),
          new Date("2027-03-15T23:59:00Z"),
        ),
      ),
    ).toEqual(["2027-03-13T07:30:00.000Z", "2027-03-15T06:30:00.000Z"]);
  });

  it("handles steps, ranges and weekdays", () => {
    // 2026-11-13 is a Friday, 2026-11-14 a Saturday.
    expect(
      iso(
        dueSlots(
          "*/30 9-10 * * 1-5",
          "UTC",
          new Date("2026-11-13T00:00:00Z"),
          new Date("2026-11-14T23:59:00Z"),
        ),
      ),
    ).toEqual([
      "2026-11-13T09:00:00.000Z",
      "2026-11-13T09:30:00.000Z",
      "2026-11-13T10:00:00.000Z",
      "2026-11-13T10:30:00.000Z",
    ]);
  });

  it("matches a brute-force minute scan across DST transitions and odd offsets", () => {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const schedules = [
      "0 0 * * *",
      "30 1 * * *",
      "15 2 14,28 * *",
      "30 0 15,29 * *",
      "0 0 * * 0",
      "45 23 * 3 *",
      "*/20 2-3 * * *",
    ].map((s) => [s, parseCronSchedule(s)] as const);
    // Three days around each zone's 2027 transition (UTC/Kathmandu have none).
    for (const [tz, from] of [
      ["UTC", "2027-03-13T00:00:00Z"],
      ["America/New_York", "2027-03-13T00:00:00Z"],
      ["Europe/London", "2027-03-27T00:00:00Z"],
      ["Australia/Lord_Howe", "2027-04-02T12:00:00Z"],
      ["Asia/Kathmandu", "2027-03-13T00:00:00Z"],
    ] as const) {
      const after = new Date(from);
      const until = new Date(after.getTime() + 3 * 24 * 3_600_000);
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        weekday: "short",
      });
      const expected = new Map<string, string[]>(
        schedules.map(([s]) => [s, []]),
      );
      for (
        let t = after.getTime() + 60_000;
        t <= until.getTime();
        t += 60_000
      ) {
        const p = Object.fromEntries(
          fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]),
        );
        const local = {
          minute: Number(p.minute),
          hour: Number(p.hour),
          day: Number(p.day),
          month: Number(p.month),
          weekday: days.indexOf(p.weekday),
        };
        for (const [s, spec] of schedules) {
          if (matchesLocal(spec, local)) {
            expected.get(s)?.push(new Date(t).toISOString());
          }
        }
      }
      for (const [s] of schedules) {
        expect({ tz, s, slots: iso(dueSlots(s, tz, after, until)) }).toEqual({
          tz,
          s,
          slots: expected.get(s) ?? [],
        });
      }
    }
  });
});
