/**
 * Integration tests for cron-handler.ts's progress push + partial-usage-on-
 * failure wiring (CSU-3.2 — the generic cron-dispatch-path port of CSU-3.1's
 * loop-orchestrator.ts wiring).
 *
 * Strategy: inject all deps (Clock, CronRunReporter, runner) — no
 * mock.module(), no real Slack/Claude calls. Mirrors
 * loop-orchestrator.integration.test.ts's CSU-3.1 suite.
 */

import { describe, expect, test } from "bun:test";
import type { WebClient } from "@slack/web-api";
import {
  type ClaudeRunResult,
  ClaudeTimeoutError,
  type ModelUsage,
  type ProgressCallback,
} from "./claude.ts";
import type { Clock } from "./clock.ts";
import { handleCronRequest } from "./cron-handler.ts";
import type {
  CronRunReporter,
  ModelBreakdownEntry,
} from "./cron-run-reporter.ts";

// ─── Shared fakes ─────────────────────────────────────────────────────────────

const mockSlack = {
  chat: { postMessage: async () => ({ ok: true, ts: "1234567890.000001" }) },
  conversations: { open: async () => ({ channel: { id: "D_DM" } }) },
} as unknown as WebClient;

function makeUsage(overrides: Partial<ModelBreakdownEntry> = {}): ModelUsage {
  return {
    "claude-opus-4": {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.42,
      ...overrides,
    },
  };
}

/** A mutable clock — lets debounce tests advance "now" between calls. */
function makeMutableClock(start: Date): Clock & { advance(ms: number): void } {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

function makeRecordingReporter(): {
  reporter: CronRunReporter;
  completeCalls: Array<{
    outcome: "completed" | "failed";
    opts?: { error?: string; modelBreakdown?: ModelBreakdownEntry[] };
  }>;
  progressCalls: Array<{
    runId: string | null;
    modelBreakdown: ModelBreakdownEntry[];
  }>;
} {
  const completeCalls: Array<{
    outcome: "completed" | "failed";
    opts?: { error?: string; modelBreakdown?: ModelBreakdownEntry[] };
  }> = [];
  const progressCalls: Array<{
    runId: string | null;
    modelBreakdown: ModelBreakdownEntry[];
  }> = [];
  const reporter: CronRunReporter = {
    async createRun() {
      return "run-1";
    },
    async completeRun(_cronId, _runId, _completedAt, outcome, opts) {
      completeCalls.push({ outcome, opts });
    },
    async skipRun() {},
    async recordProgress(_cronId, runId, modelBreakdown) {
      progressCalls.push({ runId, modelBreakdown });
    },
  };
  return { reporter, completeCalls, progressCalls };
}

// ─── Progress push + partial-usage-on-failure (CSU-3.2) ─────────────────────

describe("handleCronRequest + progress push / partial-usage-on-failure (CSU-3.2)", () => {
  test("a runner that emits progress via onProgress before resolving triggers recordProgress mid-dispatch, before completeRun", async () => {
    const { reporter, completeCalls, progressCalls } = makeRecordingReporter();
    const callOrder: string[] = [];

    const trackedReporter: CronRunReporter = {
      ...reporter,
      async recordProgress(cronId, runId, modelBreakdown) {
        callOrder.push("recordProgress");
        await reporter.recordProgress(cronId, runId, modelBreakdown);
      },
      async completeRun(
        cronId,
        runId,
        completedAt,
        outcome,
        opts,
        phaseId,
        itemType,
        itemId,
      ) {
        callOrder.push("completeRun");
        await reporter.completeRun(
          cronId,
          runId,
          completedAt,
          outcome,
          opts,
          phaseId,
          itemType,
          itemId,
        );
      },
    };

    const runner = async (
      _message: string,
      onProgress?: ProgressCallback,
    ): Promise<ClaudeRunResult> => {
      onProgress?.(makeUsage());
      return { result: "done", sessionId: "s1", modelUsage: makeUsage() };
    };

    await handleCronRequest(
      { jobId: "progress-job", prompt: "hello", channel: "C-X" },
      {
        slack: mockSlack,
        runner,
        cronRunReporter: trackedReporter,
        clock: makeMutableClock(new Date("2026-07-20T00:00:00Z")),
      },
    );

    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0]?.modelBreakdown).toEqual([
      {
        model: "claude-opus-4",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.42,
      },
    ]);
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0]?.outcome).toBe("completed");

    // recordProgress fired before completeRun for this dispatch.
    expect(callOrder).toEqual(["recordProgress", "completeRun"]);
  });

  test("a thrown ClaudeTimeoutError with partial usage results in completeRun's failed call carrying modelBreakdown", async () => {
    const { reporter, completeCalls } = makeRecordingReporter();

    const partialUsage = makeUsage({ inputTokens: 10, outputTokens: 5 });
    const runner = async (): Promise<ClaudeRunResult> => {
      throw new ClaudeTimeoutError(600_000, "ceiling", partialUsage);
    };

    await expect(
      handleCronRequest(
        { jobId: "timeout-job", prompt: "hello", channel: "C-X" },
        {
          slack: mockSlack,
          runner,
          cronRunReporter: reporter,
          clock: makeMutableClock(new Date("2026-07-20T00:00:00Z")),
        },
      ),
    ).rejects.toThrow(ClaudeTimeoutError);

    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0]?.outcome).toBe("failed");
    expect(completeCalls[0]?.opts?.error).toContain("timed out");
    expect(completeCalls[0]?.opts?.modelBreakdown).toEqual([
      {
        model: "claude-opus-4",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.42,
      },
    ]);
  });

  test("two rapid onProgress calls (<5s apart) only trigger one recordProgress call (debounced)", async () => {
    const { reporter, progressCalls } = makeRecordingReporter();
    const clock = makeMutableClock(new Date("2026-07-20T00:00:00Z"));

    const runner = async (
      _message: string,
      onProgress?: ProgressCallback,
    ): Promise<ClaudeRunResult> => {
      onProgress?.(makeUsage({ inputTokens: 10 }));
      // Advance less than the 5s debounce window before the second push.
      clock.advance(1000);
      onProgress?.(makeUsage({ inputTokens: 20 }));
      return {
        result: "done",
        sessionId: "s1",
        modelUsage: makeUsage({ inputTokens: 20 }),
      };
    };

    await handleCronRequest(
      { jobId: "debounce-job", prompt: "hello", channel: "C-X" },
      {
        slack: mockSlack,
        runner,
        cronRunReporter: reporter,
        clock,
      },
    );

    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0]?.modelBreakdown?.[0]?.inputTokens).toBe(10);
  });
});
