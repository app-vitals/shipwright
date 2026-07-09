/**
 * plugins/shipwright/scripts/check-error-patrol.unit.test.ts
 *
 * Unit tests for check-error-patrol.ts
 *
 * Design: the script exports a `run(deps)` function that accepts injected
 * dependencies. Tests inject stub implementations — no file I/O or network
 * calls are executed. No mock.module()/global.fetch overrides per the
 * repo's test isolation rule.
 */

import { describe, expect, test } from "bun:test";
import { run } from "./check-error-patrol.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface LedgerIssue {
  status: string;
  count: number;
  lastSeen: string;
}

interface Ledger {
  lastRun: string | null;
  issues: Record<string, LedgerIssue>;
}

interface SentryIssue {
  id: string;
  count: number;
  status: string;
}

function makeDeps(overrides: {
  readLedger?: () => Ledger | null;
  fetchUnresolvedIssues?: () => Promise<SentryIssue[] | null>;
}) {
  return {
    readLedger: overrides.readLedger ?? (() => ({ lastRun: null, issues: {} })),
    fetchUnresolvedIssues: overrides.fetchUnresolvedIssues ?? (async () => []),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("check-error-patrol", () => {
  test("exits 1 when Sentry returns zero unresolved issues (empty ledger)", async () => {
    const deps = makeDeps({
      readLedger: () => ({ lastRun: null, issues: {} }),
      fetchUnresolvedIssues: async () => [],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when Sentry returns zero unresolved issues (non-empty ledger)", async () => {
    const deps = makeDeps({
      readLedger: () => ({
        lastRun: "2026-07-01T00:00:00.000Z",
        issues: {
          "issue-1": {
            status: "unresolved",
            count: 5,
            lastSeen: "2026-07-01T00:00:00.000Z",
          },
        },
      }),
      fetchUnresolvedIssues: async () => [],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when all unresolved issues are unchanged from the ledger", async () => {
    const deps = makeDeps({
      readLedger: () => ({
        lastRun: "2026-07-01T00:00:00.000Z",
        issues: {
          "issue-1": {
            status: "unresolved",
            count: 5,
            lastSeen: "2026-07-01T00:00:00.000Z",
          },
          "issue-2": {
            status: "unresolved",
            count: 10,
            lastSeen: "2026-07-01T00:00:00.000Z",
          },
        },
      }),
      fetchUnresolvedIssues: async () => [
        { id: "issue-1", count: 5, status: "unresolved" },
        { id: "issue-2", count: 10, status: "unresolved" },
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when unresolved issue count is lower than ledger's recorded count", async () => {
    const deps = makeDeps({
      readLedger: () => ({
        lastRun: "2026-07-01T00:00:00.000Z",
        issues: {
          "issue-1": {
            status: "unresolved",
            count: 20,
            lastSeen: "2026-07-01T00:00:00.000Z",
          },
        },
      }),
      fetchUnresolvedIssues: async () => [
        { id: "issue-1", count: 5, status: "unresolved" },
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when an unresolved issue has no ledger entry at all (new)", async () => {
    const deps = makeDeps({
      readLedger: () => ({
        lastRun: "2026-07-01T00:00:00.000Z",
        issues: {},
      }),
      fetchUnresolvedIssues: async () => [
        { id: "issue-new", count: 3, status: "unresolved" },
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.output).toContain("1");
  });

  test("exits 0 when a ledger entry's status was resolved but the issue is unresolved now (regressed by status flip)", async () => {
    const deps = makeDeps({
      readLedger: () => ({
        lastRun: "2026-07-01T00:00:00.000Z",
        issues: {
          "issue-1": {
            status: "resolved",
            count: 5,
            lastSeen: "2026-07-01T00:00:00.000Z",
          },
        },
      }),
      fetchUnresolvedIssues: async () => [
        { id: "issue-1", count: 5, status: "unresolved" },
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("exits 0 when a ledger entry's status was ignored but the issue is unresolved now (regressed by status flip)", async () => {
    const deps = makeDeps({
      readLedger: () => ({
        lastRun: "2026-07-01T00:00:00.000Z",
        issues: {
          "issue-1": {
            status: "ignored",
            count: 5,
            lastSeen: "2026-07-01T00:00:00.000Z",
          },
        },
      }),
      fetchUnresolvedIssues: async () => [
        { id: "issue-1", count: 5, status: "unresolved" },
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("exits 0 when a ledger entry's count grew (regressed by count growth)", async () => {
    const deps = makeDeps({
      readLedger: () => ({
        lastRun: "2026-07-01T00:00:00.000Z",
        issues: {
          "issue-1": {
            status: "unresolved",
            count: 5,
            lastSeen: "2026-07-01T00:00:00.000Z",
          },
        },
      }),
      fetchUnresolvedIssues: async () => [
        { id: "issue-1", count: 12, status: "unresolved" },
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("exits 0 with a summary mentioning the count of new/regressed issues", async () => {
    const deps = makeDeps({
      readLedger: () => ({
        lastRun: "2026-07-01T00:00:00.000Z",
        issues: {
          "issue-1": {
            status: "unresolved",
            count: 5,
            lastSeen: "2026-07-01T00:00:00.000Z",
          },
        },
      }),
      fetchUnresolvedIssues: async () => [
        { id: "issue-1", count: 12, status: "unresolved" }, // regressed
        { id: "issue-2", count: 1, status: "unresolved" }, // new
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("2");
  });

  test("exits 0 permissively when fetchUnresolvedIssues returns null (Sentry unreachable / creds missing)", async () => {
    const deps = makeDeps({
      readLedger: () => ({ lastRun: null, issues: {} }),
      fetchUnresolvedIssues: async () => null,
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("exits 0 permissively when the ledger is missing/unreadable and there are unresolved issues (all new)", async () => {
    const deps = makeDeps({
      readLedger: () => null,
      fetchUnresolvedIssues: async () => [
        { id: "issue-1", count: 5, status: "unresolved" },
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("exits 1 when the ledger is missing/unreadable and there are zero unresolved issues", async () => {
    const deps = makeDeps({
      readLedger: () => null,
      fetchUnresolvedIssues: async () => [],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });
});
