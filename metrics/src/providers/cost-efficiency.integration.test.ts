/**
 * metrics/src/providers/cost-efficiency.integration.test.ts
 * Integration tests for TaskStoreProvider.costEfficiency() using run-level data.
 *
 * Verifies that costEfficiency() reads byModel + byCronModel from the admin
 * client and computes routedUsd + opusUsd correctly. No TaskRecord dependency.
 */

import { describe, expect, test } from "bun:test";
import type {
  ChatTokenStats,
  CronRunTokenStats,
} from "../lib/admin-metrics-client.ts";
import { FixedClock } from "../lib/test-helpers.ts";
import { TaskStoreProvider } from "./task-store-provider.ts";
import {
  RecordedAdminMetricsClient,
  RecordedTaskStoreClient,
} from "./task-store-recorded.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const agg = (
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
  costUsd?: number,
) => ({
  input,
  output,
  cacheRead,
  cacheCreation,
  total: input + output + cacheRead + cacheCreation,
  ...(costUsd !== undefined ? { costUsd } : {}),
});

// Cassette: two model families across two agents and two crons.
// byModel (key1=agentId, key2=model):
//   - agent-a uses sonnet: 100k input, 20k output, 5k cacheRead, 2k cacheCreation, costUsd=0.50
//   - agent-b uses opus:   50k input,  10k output, 0k cacheRead, 0k cacheCreation, costUsd=1.00
// byCronModel (key1=agentId:cronName, key2=model):
//   - agent-a:morning-brief × sonnet: 60k input, 12k output, 3k cacheRead, 1k cacheCreation, costUsd=0.30
//   - agent-a:patrol × sonnet:        40k input,  8k output, 2k cacheRead, 1k cacheCreation, costUsd=0.20
//   - agent-b:morning-brief × opus:   50k input, 10k output, 0k cacheRead, 0k cacheCreation, costUsd=1.00

const CRON_STATS: CronRunTokenStats = {
  totals: agg(150_000, 30_000, 5_000, 2_000, 1.5),
  byAgent: [
    { key: "agent-a", ...agg(100_000, 20_000, 5_000, 2_000, 0.5) },
    { key: "agent-b", ...agg(50_000, 10_000, 0, 0, 1.0) },
  ],
  byCron: [
    {
      key1: "agent-a",
      key2: "morning-brief",
      ...agg(60_000, 12_000, 3_000, 1_000, 0.3),
    },
    {
      key1: "agent-a",
      key2: "patrol",
      ...agg(40_000, 8_000, 2_000, 1_000, 0.2),
    },
    {
      key1: "agent-b",
      key2: "morning-brief",
      ...agg(50_000, 10_000, 0, 0, 1.0),
    },
  ],
  byModel: [
    {
      key1: "agent-a",
      key2: "claude-sonnet-4-6",
      ...agg(100_000, 20_000, 5_000, 2_000, 0.5),
    },
    {
      key1: "agent-b",
      key2: "claude-opus-4-8",
      ...agg(50_000, 10_000, 0, 0, 1.0),
    },
  ],
  byCronModel: [
    {
      key1: "agent-a:morning-brief",
      key2: "claude-sonnet-4-6",
      ...agg(60_000, 12_000, 3_000, 1_000, 0.3),
    },
    {
      key1: "agent-a:patrol",
      key2: "claude-sonnet-4-6",
      ...agg(40_000, 8_000, 2_000, 1_000, 0.2),
    },
    {
      key1: "agent-b:morning-brief",
      key2: "claude-opus-4-8",
      ...agg(50_000, 10_000, 0, 0, 1.0),
    },
  ],
  daily: [],
  byPhase: [],
};

const CHAT_STATS: ChatTokenStats = {
  totals: agg(0, 0, 0, 0),
  byAgent: [],
  byModel: [],
  daily: [],
};

const CLOCK = FixedClock("2026-06-10T12:00:00.000Z");
const RANGE = { from: "2026-06-01", to: "2026-06-07" } as const;

function buildProvider(): TaskStoreProvider {
  // No tasks — costEfficiency() must not depend on TaskRecord.
  const taskStore = new RecordedTaskStoreClient([], []);
  const admin = new RecordedAdminMetricsClient(CRON_STATS, CHAT_STATS);
  return new TaskStoreProvider(taskStore, admin, CLOCK);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("TaskStoreProvider.costEfficiency() (run-level)", () => {
  test("returns correct column schema", async () => {
    const provider = buildProvider();
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    expect(t.columns).toEqual([
      "scope",
      "model_family",
      "routed_usd",
      "opus_usd",
      "savings_usd",
    ]);
  });

  test("returns fleet-level rows for each model in byModel", async () => {
    const provider = buildProvider();
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    const scopeIdx = t.columns.indexOf("scope");
    const modelIdx = t.columns.indexOf("model_family");

    const fleetRows = t.results.filter(
      (r) => (r[scopeIdx] as string) === "fleet",
    );

    // Two models: sonnet and opus
    expect(fleetRows.length).toBeGreaterThanOrEqual(2);

    const modelFamilies = fleetRows.map((r) => r[modelIdx] as string);
    expect(modelFamilies).toContain("claude-sonnet-4-6");
    expect(modelFamilies).toContain("claude-opus-4-8");
  });

  test("returns cron-level rows for each byCronModel entry", async () => {
    const provider = buildProvider();
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    const scopeIdx = t.columns.indexOf("scope");
    const cronRows = t.results.filter(
      (r) => (r[scopeIdx] as string).startsWith("cron:"),
    );

    // Three byCronModel entries
    expect(cronRows.length).toBeGreaterThanOrEqual(3);
  });

  test("routed_usd matches the costUsd from admin stats for sonnet fleet row", async () => {
    const provider = buildProvider();
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    const scopeIdx = t.columns.indexOf("scope");
    const modelIdx = t.columns.indexOf("model_family");
    const routedIdx = t.columns.indexOf("routed_usd");

    // Sum across all agents for sonnet (only agent-a uses sonnet)
    const sonnetFleet = t.results.find(
      (r) =>
        (r[scopeIdx] as string) === "fleet" &&
        (r[modelIdx] as string) === "claude-sonnet-4-6",
    );
    expect(sonnetFleet).toBeDefined();
    // routed_usd = 0.50 (sum of costUsd for claude-sonnet-4-6 across byModel)
    expect(sonnetFleet?.[routedIdx]).toBeCloseTo(0.5);
  });

  test("opus_usd >= routed_usd for non-opus model families", async () => {
    const provider = buildProvider();
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    const scopeIdx = t.columns.indexOf("scope");
    const modelIdx = t.columns.indexOf("model_family");
    const routedIdx = t.columns.indexOf("routed_usd");
    const opusIdx = t.columns.indexOf("opus_usd");

    const fleetRows = t.results.filter(
      (r) => (r[scopeIdx] as string) === "fleet",
    );

    for (const row of fleetRows) {
      const model = row[modelIdx] as string;
      const routed = row[routedIdx] as number;
      const opus = row[opusIdx] as number;
      if (model !== "claude-opus-4-8" && model !== "opus") {
        // For cheaper models, opus counterfactual must cost >= actual
        expect(opus).toBeGreaterThanOrEqual(routed);
      }
    }
  });

  test("savings_usd = opus_usd - routed_usd", async () => {
    const provider = buildProvider();
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    const routedIdx = t.columns.indexOf("routed_usd");
    const opusIdx = t.columns.indexOf("opus_usd");
    const savingsIdx = t.columns.indexOf("savings_usd");

    for (const row of t.results) {
      const routed = row[routedIdx] as number;
      const opus = row[opusIdx] as number;
      const savings = row[savingsIdx] as number;
      expect(savings).toBeCloseTo(opus - routed, 10);
    }
  });

  test("opus fleet row savings_usd = opus_usd - routed_usd (even for opus model)", async () => {
    const provider = buildProvider();
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    const scopeIdx = t.columns.indexOf("scope");
    const modelIdx = t.columns.indexOf("model_family");
    const routedIdx = t.columns.indexOf("routed_usd");
    const opusIdx = t.columns.indexOf("opus_usd");
    const savingsIdx = t.columns.indexOf("savings_usd");

    const opusFleet = t.results.find(
      (r) =>
        (r[scopeIdx] as string) === "fleet" &&
        (r[modelIdx] as string) === "claude-opus-4-8",
    );
    expect(opusFleet).toBeDefined();
    // savings_usd = opus_usd - routed_usd always holds
    const routed = opusFleet?.[routedIdx] as number;
    const opus = opusFleet?.[opusIdx] as number;
    const savings = opusFleet?.[savingsIdx] as number;
    expect(savings).toBeCloseTo(opus - routed, 10);
  });

  test("no TaskRecord dependency — empty task store still produces results", async () => {
    const provider = buildProvider();
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    // Must have fleet rows even with zero tasks
    const scopeIdx = t.columns.indexOf("scope");
    const fleetRows = t.results.filter(
      (r) => (r[scopeIdx] as string) === "fleet",
    );
    expect(fleetRows.length).toBeGreaterThan(0);
  });

  test("cron-level row scope uses cron identity from key1", async () => {
    const provider = buildProvider();
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    const scopeIdx = t.columns.indexOf("scope");
    const scopes = t.results.map((r) => r[scopeIdx] as string);

    // byCronModel key1 values: "agent-a:morning-brief", "agent-a:patrol", "agent-b:morning-brief"
    expect(scopes).toContain("cron:agent-a:morning-brief");
    expect(scopes).toContain("cron:agent-a:patrol");
    expect(scopes).toContain("cron:agent-b:morning-brief");
  });
});
