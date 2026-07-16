/**
 * agent/src/cron-failure-reporter.unit.test.ts
 *
 * Unit tests for reportCronFailure() — pure logic, no I/O. Verifies a thrown
 * cron dispatch error results in a createRun/completeRun("failed") pair on
 * the injected CronRunReporter and a captureException call on the injected
 * ErrorCapturingClient, mirroring loop-orchestrator.ts's dispatch() pattern.
 */

import { describe, expect, it } from "bun:test";
import { FixedClock } from "./clock.ts";
import { reportCronFailure } from "./cron-failure-reporter.ts";
import type {
  CronRunReporter,
  ModelBreakdownEntry,
} from "./cron-run-reporter.ts";

const FIXED_TIME = new Date("2024-01-01T00:00:00.000Z");

interface CreateRunCall {
  cronId: string;
  startedAt: Date;
  phase?: string;
}

interface CompleteRunCall {
  cronId: string;
  runId: string | null;
  completedAt: Date;
  outcome: "completed" | "failed";
  opts?: {
    error?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    modelBreakdown?: ModelBreakdownEntry[];
  };
  phase?: string;
}

function createFakeCronRunReporter(runId: string | null = "run-1") {
  const createRunCalls: CreateRunCall[] = [];
  const completeRunCalls: CompleteRunCall[] = [];

  const reporter: CronRunReporter = {
    async createRun(cronId, startedAt, phase) {
      createRunCalls.push({ cronId, startedAt, phase });
      return runId;
    },
    async completeRun(cronId, callRunId, completedAt, outcome, opts, phase) {
      completeRunCalls.push({
        cronId,
        runId: callRunId,
        completedAt,
        outcome,
        opts,
        phase,
      });
    },
    async skipRun() {
      throw new Error("skipRun should not be called by reportCronFailure");
    },
  };

  return { reporter, createRunCalls, completeRunCalls };
}

function createFakeErrorCapturingClient() {
  const capturedErrors: unknown[] = [];
  return {
    client: {
      captureException: (err: unknown) => {
        capturedErrors.push(err);
      },
    },
    capturedErrors,
  };
}

describe("reportCronFailure", () => {
  it("creates a run and completes it as failed with the error message", async () => {
    const { reporter, createRunCalls, completeRunCalls } =
      createFakeCronRunReporter();
    const clock = FixedClock(FIXED_TIME);
    const err = new Error("dispatch exploded");

    await reportCronFailure("my-cron-id", err, {
      cronRunReporter: reporter,
      clock,
    });

    expect(createRunCalls).toHaveLength(1);
    expect(createRunCalls[0]?.cronId).toBe("my-cron-id");
    expect(createRunCalls[0]?.startedAt).toEqual(FIXED_TIME);

    expect(completeRunCalls).toHaveLength(1);
    expect(completeRunCalls[0]?.cronId).toBe("my-cron-id");
    expect(completeRunCalls[0]?.runId).toBe("run-1");
    expect(completeRunCalls[0]?.completedAt).toEqual(FIXED_TIME);
    expect(completeRunCalls[0]?.outcome).toBe("failed");
    expect(completeRunCalls[0]?.opts?.error).toBe("dispatch exploded");
  });

  it("stringifies a non-Error thrown value for the error field", async () => {
    const { reporter, completeRunCalls } = createFakeCronRunReporter();
    const clock = FixedClock(FIXED_TIME);

    await reportCronFailure("my-cron-id", "just a string failure", {
      cronRunReporter: reporter,
      clock,
    });

    expect(completeRunCalls[0]?.outcome).toBe("failed");
    expect(completeRunCalls[0]?.opts?.error).toBe("just a string failure");
  });

  it("calls captureException on the injected sentry client with the original error", async () => {
    const { reporter } = createFakeCronRunReporter();
    const { client, capturedErrors } = createFakeErrorCapturingClient();
    const clock = FixedClock(FIXED_TIME);
    const err = new Error("boom");

    await reportCronFailure("my-cron-id", err, {
      cronRunReporter: reporter,
      sentryClient: client,
      clock,
    });

    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0]).toBe(err);
  });

  it("does not throw when no sentryClient is provided", async () => {
    const { reporter } = createFakeCronRunReporter();
    const clock = FixedClock(FIXED_TIME);

    await expect(
      reportCronFailure("my-cron-id", new Error("boom"), {
        cronRunReporter: reporter,
        clock,
      }),
    ).resolves.toBeUndefined();
  });
});
