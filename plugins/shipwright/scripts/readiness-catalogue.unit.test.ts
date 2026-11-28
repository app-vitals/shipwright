/**
 * Unit tests for readiness-catalogue.ts — pure logic, no I/O.
 */
import { describe, expect, test } from "bun:test";
import {
  type CheckResult,
  computeLevel,
  READINESS_CATALOGUE,
  READINESS_OWNERS,
  type ReadinessCheck,
} from "./readiness-catalogue.ts";

const allPass = (): Record<string, CheckResult> =>
  Object.fromEntries(READINESS_CATALOGUE.map((c) => [c.id, "pass" as const]));

const firstAt = (level: number): ReadinessCheck => {
  const c = READINESS_CATALOGUE.find((x) => x.level === level);
  if (!c) throw new Error(`no check at level ${level}`);
  return c;
};

describe("READINESS_CATALOGUE shape", () => {
  test("has the 29 Feature 1 checks, with per-level counts 4/8/10/5/2", () => {
    expect(READINESS_CATALOGUE).toHaveLength(29);
    const counts = [1, 2, 3, 4, 5].map(
      (n) => READINESS_CATALOGUE.filter((c) => c.level === n).length,
    );
    expect(counts).toEqual([4, 8, 10, 5, 2]);
  });

  test("every check has a level 1-5, non-empty id/title and one allowed owner", () => {
    for (const c of READINESS_CATALOGUE) {
      expect([1, 2, 3, 4, 5]).toContain(c.level);
      expect(c.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(c.title.length).toBeGreaterThan(0);
      expect(typeof c.owner).toBe("string");
      expect(READINESS_OWNERS as readonly string[]).toContain(c.owner);
    }
  });

  test("ids and titles are unique", () => {
    expect(new Set(READINESS_CATALOGUE.map((c) => c.id)).size).toBe(READINESS_CATALOGUE.length);
    expect(new Set(READINESS_CATALOGUE.map((c) => c.title)).size).toBe(READINESS_CATALOGUE.length);
  });

  test("is ordered by level", () => {
    const levels = READINESS_CATALOGUE.map((c) => c.level);
    expect(levels).toEqual([...levels].sort());
  });
});

describe("computeLevel", () => {
  test("all pass → 5", () => {
    expect(computeLevel(allPass())).toBe(5);
  });

  test("a Level 1 failure → 0", () => {
    expect(computeLevel({ ...allPass(), [firstAt(1).id]: "fail" })).toBe(0);
  });

  test("a failure at level N+1 caps the level at N", () => {
    for (const n of [1, 2, 3, 4] as const) {
      expect(computeLevel({ ...allPass(), [firstAt(n + 1).id]: "fail" })).toBe(n);
    }
  });

  test("a failing lower level wins over passing higher levels", () => {
    expect(computeLevel({ ...allPass(), [firstAt(2).id]: "fail" })).toBe(1);
  });

  test("n/a counts as pass", () => {
    const r = allPass();
    for (const c of READINESS_CATALOGUE) if (c.level <= 3) r[c.id] = "n/a";
    expect(computeLevel(r)).toBe(5);
    expect(computeLevel({ ...r, [firstAt(4).id]: "fail" })).toBe(3);
  });

  test("missing results are not a pass", () => {
    const r = allPass();
    delete r[firstAt(3).id];
    expect(computeLevel(r)).toBe(2);
    expect(computeLevel({})).toBe(0);
  });
});
