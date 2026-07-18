/**
 * plugins/shipwright/scripts/check-consolidation-patrol.unit.test.ts
 *
 * Unit tests for check-consolidation-patrol.ts
 *
 * Design: the script exports a `run(deps)` function that accepts injected
 * dependencies. Tests inject stub implementations — no file I/O is executed.
 * No mock.module()/global.fetch overrides per the repo's test isolation rule.
 */

import { describe, expect, test } from "bun:test";
import { run } from "./check-consolidation-patrol.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface LedgerCandidate {
  description: string;
  files: string[];
  occurrence_count: number;
  consecutive_stable_runs: number;
  status: "tracking" | "ready_to_propose";
  firstSeen: string;
  lastSeen: string;
}

interface Ledger {
  lastRun: string | null;
  candidates: Record<string, LedgerCandidate>;
}

function makeDeps(overrides: { readLedger?: () => Ledger | null }) {
  return {
    readLedger:
      overrides.readLedger ?? (() => ({ lastRun: null, candidates: {} })),
  };
}

function candidate(
  overrides: Partial<LedgerCandidate> = {},
): LedgerCandidate {
  return {
    description: "Shared retry-with-backoff logic",
    files: ["src/a.ts", "src/b.ts"],
    occurrence_count: 1,
    consecutive_stable_runs: 0,
    status: "tracking",
    firstSeen: "2026-07-01T00:00:00.000Z",
    lastSeen: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("check-consolidation-patrol", () => {
  test("exits 1 when the ledger is missing (normal first run — no candidates possible)", async () => {
    const deps = makeDeps({ readLedger: () => null });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when the ledger has zero candidates", async () => {
    const deps = makeDeps({
      readLedger: () => ({ lastRun: "2026-07-01T00:00:00.000Z", candidates: {} }),
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when all candidates are tracking with occurrence_count < 2", async () => {
    const deps = makeDeps({
      readLedger: () => ({
        lastRun: "2026-07-01T00:00:00.000Z",
        candidates: {
          fp1: candidate({ occurrence_count: 1, status: "tracking" }),
        },
      }),
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when a candidate is ready_to_propose", async () => {
    const deps = makeDeps({
      readLedger: () => ({
        lastRun: "2026-07-01T00:00:00.000Z",
        candidates: {
          fp1: candidate({
            occurrence_count: 3,
            consecutive_stable_runs: 2,
            status: "ready_to_propose",
          }),
        },
      }),
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("exits 0 when a tracking candidate has occurrence_count >= 2 (close to threshold)", async () => {
    const deps = makeDeps({
      readLedger: () => ({
        lastRun: "2026-07-01T00:00:00.000Z",
        candidates: {
          fp1: candidate({ occurrence_count: 2, status: "tracking" }),
        },
      }),
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("exits 0 with a summary mentioning the count of interesting candidates", async () => {
    const deps = makeDeps({
      readLedger: () => ({
        lastRun: "2026-07-01T00:00:00.000Z",
        candidates: {
          fp1: candidate({
            occurrence_count: 3,
            consecutive_stable_runs: 2,
            status: "ready_to_propose",
          }),
          fp2: candidate({ occurrence_count: 2, status: "tracking" }),
          fp3: candidate({ occurrence_count: 1, status: "tracking" }),
        },
      }),
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("2");
  });

  test("exits 0 permissively when the ledger is unreadable/corrupt (readLedger throws)", async () => {
    const deps = makeDeps({
      readLedger: () => {
        throw new Error("corrupt JSON");
      },
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });
});
