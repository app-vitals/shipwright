/**
 * Unit tests for readiness-api-detectors.ts — pure helpers and catalogue wiring.
 */
import { describe, expect, test } from "bun:test";
import {
  daysBetween,
  detectorCheckIds,
  OWNER_CRON_IDS,
  type PatrolFinding,
  readySince,
} from "./readiness-api-detectors.ts";
import { READINESS_CATALOGUE } from "./readiness-catalogue.ts";

describe("detector ids", () => {
  test("every detector check id exists in the RDY-1.1 catalogue", () => {
    const ids = new Set(READINESS_CATALOGUE.map((c) => c.id));
    expect(detectorCheckIds.length).toBe(7);
    for (const id of detectorCheckIds) expect(ids.has(id)).toBe(true);
  });

  test("owner crons are the seeded system-cron ids", () => {
    expect([...OWNER_CRON_IDS]).toEqual([
      "docs-freshness",
      "test-readiness",
      "entropy-patrol",
      "security-patrol",
      "consolidation-patrol",
    ]);
  });
});

describe("daysBetween", () => {
  test("exactly 30 days is 30; one ms more is over", () => {
    const to = new Date("2026-11-28T00:00:00.000Z");
    expect(daysBetween("2026-10-29T00:00:00.000Z", to)).toBe(30);
    expect(daysBetween("2026-10-28T23:59:59.999Z", to)).toBeGreaterThan(30);
  });
});

describe("readySince", () => {
  const base: PatrolFinding = {
    cronId: "consolidation-patrol",
    repo: "o/r",
    fingerprint: "f",
    status: "ready_to_propose",
    firstSeen: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-11-01T00:00:00.000Z",
    detail: null,
    history: [],
  };
  test("uses the start of the trailing ready streak", () => {
    const f = {
      ...base,
      history: [
        { at: "2026-02-01T00:00:00.000Z", status: "ready_to_propose" as const },
        { at: "2026-03-01T00:00:00.000Z", status: "tracking" as const },
        { at: "2026-10-01T00:00:00.000Z", status: "ready_to_propose" as const },
        { at: "2026-11-01T00:00:00.000Z", status: "ready_to_propose" as const },
      ],
    };
    expect(readySince(f)).toBe("2026-10-01T00:00:00.000Z");
  });
  test("falls back to firstSeen without history", () => {
    expect(readySince(base)).toBe(base.firstSeen);
  });
});
