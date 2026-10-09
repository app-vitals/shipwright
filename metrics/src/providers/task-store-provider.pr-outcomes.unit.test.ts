/**
 * metrics/src/providers/task-store-provider.pr-outcomes.unit.test.ts
 * Unit (PAU-1.8): prOutcomes aggregation over a recorded GET /prs fixture.
 * fp-a's baselines window covers 06-01..06-04 (pr-1..pr-4); fp-b's covers
 * 06-08 only (pr-5). Read-only — no PullRequest schema change.
 */

import { describe, expect, test } from "bun:test";
import fixture from "../fixtures/task-store/list-prs-outcomes.json";
import type { CronRunTokenStats } from "../lib/admin-metrics-client.ts";
import type { PrRecord } from "../lib/task-store-client.ts";
import { FixedClock } from "../lib/test-helpers.ts";
import { TaskStoreProvider } from "./task-store-provider.ts";
import {
  FaultingCronAdminMetricsClient,
  RecordedAdminMetricsClient,
  RecordedTaskStoreClient,
} from "./task-store-recorded.ts";

const CLOCK = FixedClock("2026-06-10T12:00:00.000Z");
const RANGE = { from: "2026-06-01", to: "2026-06-09" } as const;
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
const EMPTY_CHAT = { totals: ZERO, byAgent: [], byModel: [], daily: [] };

const prs = fixture.listPrs_pr_outcomes.body.prs as unknown as PrRecord[];

function baseline(fp: string | null, firstSeen: string, lastSeen: string) {
  return {
    contextFingerprint: fp,
    baselineModel: "m",
    phase: "dev-task",
    runs: 1,
    avgContextTokens: 1,
    minContextTokens: 1,
    maxContextTokens: 1,
    avgTurns: null,
    avgToolCalls: null,
    firstSeen,
    lastSeen,
  };
}

function cronStats(
  baselines: ReturnType<typeof baseline>[],
): CronRunTokenStats {
  return {
    totals: ZERO,
    byAgent: [],
    byCron: [],
    byModel: [],
    daily: [],
    byCronModel: [],
    byPhase: [],
    baselines,
  };
}

function provider(baselines: ReturnType<typeof baseline>[]) {
  return new TaskStoreProvider(
    new RecordedTaskStoreClient([], prs),
    new RecordedAdminMetricsClient(cronStats(baselines), EMPTY_CHAT),
    CLOCK,
  );
}

describe("TaskStoreProvider prOutcomes (PAU-1.8)", () => {
  test("aggregates reviewState mix, avg cycles and median time-to-merge per fingerprint window", async () => {
    const t = await provider([
      baseline("fp-a", "2026-06-01T00:00:00.000Z", "2026-06-04T23:59:59.000Z"),
      baseline("fp-b", "2026-06-08T00:00:00.000Z", "2026-06-08T23:00:00.000Z"),
    ]).query({ kind: "prOutcomes", range: RANGE });

    const rows = t.results.map((r) =>
      Object.fromEntries(t.columns.map((c, i) => [c, r[i]])),
    );
    const a = rows.find((r) => r.context_fingerprint === "fp-a");
    expect(a).toMatchObject({
      prs: 4,
      merged: 3,
      approved: 2,
      posted: 1,
      other: 1,
      avg_review_cycles: 1.5,
      avg_patch_cycles: 0.75,
      median_time_to_merge_ms: 4 * 3600_000,
    });
    const b = rows.find((r) => r.context_fingerprint === "fp-b");
    expect(b).toMatchObject({
      prs: 1,
      approved: 1,
      median_time_to_merge_ms: 3600_000,
    });
  });

  test("a fingerprint seen across several baseline rows spans min firstSeen..max lastSeen", async () => {
    const t = await provider([
      baseline("fp-a", "2026-06-02T00:00:00.000Z", "2026-06-02T23:00:00.000Z"),
      baseline("fp-a", "2026-06-01T00:00:00.000Z", "2026-06-03T23:00:00.000Z"),
    ]).query({ kind: "prOutcomes", range: RANGE });
    expect(t.results).toHaveLength(1);
    expect(t.results[0][t.columns.indexOf("prs")]).toBe(3);
  });

  test("no baselines (or null fingerprints) → empty table", async () => {
    const t = await provider([
      baseline(null, "2026-06-01T00:00:00.000Z", "2026-06-04T00:00:00.000Z"),
    ]).query({ kind: "prOutcomes", range: RANGE });
    expect(t.results).toEqual([]);
  });

  test("admin stats failure degrades to an empty table", async () => {
    const p = new TaskStoreProvider(
      new RecordedTaskStoreClient([], prs),
      new FaultingCronAdminMetricsClient(cronStats([]), EMPTY_CHAT),
      CLOCK,
    );
    const t = await p.query({ kind: "prOutcomes", range: RANGE });
    expect(t.results).toEqual([]);
  });
});
