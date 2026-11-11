/**
 * plugins/shipwright/scripts/check-prompt-audit.unit.test.ts
 *
 * Unit tests for check-prompt-audit.ts
 *
 * Design: the script exports a `run(deps)` function that accepts injected
 * dependencies (ledger reader and clock). No file I/O, no real time.
 */

import { describe, expect, test } from "bun:test";
import { run } from "./check-prompt-audit.ts";
import type { Clock } from "./clock.ts";
import type { FindingStatus } from "./prompt-audit/ledger.ts";

const NOW = new Date("2026-10-08T00:00:00.000Z");
const clock: Clock = { now: () => NOW };

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function ledger(lastRun: string | null, statuses: FindingStatus[] = []) {
  return {
    lastRun,
    findings: Object.fromEntries(
      statuses.map((status, i) => [`fp${i}`, { status }]),
    ),
  };
}

describe("check-prompt-audit", () => {
  test("exits 0 when the ledger is missing (bootstrap)", async () => {
    const result = await run({ clock, readLedger: () => null });
    expect(result.exit).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("exits 1 when lastRun is under 7 days old and nothing is proposed", async () => {
    const result = await run({
      clock,
      readLedger: () => ledger(daysAgo(3), ["tracking", "queued"]),
    });
    expect(result).toEqual({ exit: 1, output: "" });
  });

  test("exits 0 with a summary when lastRun is under 7 days old but findings are proposed", async () => {
    const result = await run({
      clock,
      readLedger: () => ledger(daysAgo(3), ["proposed", "proposed", "tracking"]),
    });
    expect(result.exit).toBe(0);
    expect(result.output).toContain("2");
  });

  test("exits 0 when lastRun is 7 or more days old", async () => {
    const result = await run({
      clock,
      readLedger: () => ledger(daysAgo(7)),
    });
    expect(result.exit).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("exits 0 when lastRun is null (never scanned)", async () => {
    const result = await run({ clock, readLedger: () => ledger(null) });
    expect(result.exit).toBe(0);
  });

  test("exits 0 when the ledger is corrupt (readLedger throws)", async () => {
    const result = await run({
      clock,
      readLedger: () => {
        throw new Error("malformed");
      },
    });
    expect(result.exit).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("exits 0 when lastRun is unparseable", async () => {
    const result = await run({
      clock,
      readLedger: () => ledger("not-a-date"),
    });
    expect(result.exit).toBe(0);
  });
});
