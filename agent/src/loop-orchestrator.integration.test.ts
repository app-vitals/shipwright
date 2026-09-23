/**
 * agent/src/loop-orchestrator.integration.test.ts
 *
 * Integration test for CBD-2.1: composes the REAL task-store HTTP claim
 * client (createTaskStoreClient().claim from check-helpers.ts) with the REAL
 * createLoopOrchestrator() drain loop against a recorded task-store double
 * (a real Bun.serve stub) that returns a 5xx from POST /tasks/:id/claim.
 *
 * loop-orchestrator.unit.test.ts covers this seam with a stubbed claimTask
 * function that throws directly — correct, but it never exercises the real
 * HTTP client's actual throw behavior (check-helpers.ts's claim() throwing
 * `task-store POST /tasks/${id}/claim → ${status}` on any non-200/409). This
 * is exactly the class of bug CBD-2.1 fixes: each piece was unit-correct in
 * isolation (claim() throws as designed; the drain loop's per-item claim call
 * was not wrapped in try/catch), but the system-level composition was wrong
 * (the throw aborted the whole tick instead of skipping one item). Only an
 * integration test wiring the real pieces together catches that.
 *
 * No mock.module(), no global.fetch override — the stub is a real Bun.serve
 * process listening on a real port, and createTaskStoreClient() uses the
 * default (real) global fetch to reach it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTaskStoreClient } from "./check-helpers.ts";
import {
  ClaudeTimeoutError,
  type ClaudeRunResult,
  type ModelUsage,
  type ProgressCallback,
} from "./claude.ts";
import { FixedClock } from "./clock.ts";
import type {
  CronRunReporter,
  ModelBreakdownEntry,
} from "./cron-run-reporter.ts";
import type { CronJobLike } from "./loop-cron-classifier.ts";
import { createLoopOrchestrator } from "./loop-orchestrator.ts";
import type { WorkQueueReporter } from "./work-queue-reporter.ts";
import type { WorkPrCandidate, WorkTaskCandidate } from "./work-selector.ts";

function job(name: string, enabled: boolean): CronJobLike {
  return { id: name, name, enabled, parentCronId: "shipwright-loop" };
}

const ALL_PHASES_ON: CronJobLike[] = [
  job("shipwright-dev-task", true),
  job("shipwright-review", true),
  job("shipwright-patch", true),
  job("shipwright-deploy", true),
];

/**
 * Builds a CronJobLike fixture representing a child phase row exactly as
 * reconcileSystemCrons() (agent-types/coding/manifest.yaml, LPC-1.2) produces
 * it — parentCronId set to the loop row's own id. Distinct from the local job()
 * helper above (which defaults parentCronId to the CBD-2.1 test's fixed
 * "shipwright-loop" id) since this section's tests use their own explicit
 * parent loop id to make the parent/child relationship visible in the
 * fixtures themselves.
 */
function childPhaseJob(
  name: string,
  enabled: boolean,
  parentCronId: string,
): CronJobLike {
  return { id: `${parentCronId}-${name}`, name, enabled, parentCronId };
}

function task(id: string, createdAt: string): WorkTaskCandidate {
  return { id, createdAt };
}

function pr(
  id: string,
  age: string,
  phase: "review" | "patch" | "deploy",
): WorkPrCandidate {
  return { id, age, phase, commitSha: `${id}-sha` };
}

describe("loop-orchestrator + real task-store claim client (CBD-2.1)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: Server type param varies by bun version
  let server: ReturnType<typeof Bun.serve<any>>;
  let claimStatusByTaskId: Record<string, number>;
  let claimRequests: string[];
  let savedEnv: { url?: string; token?: string };

  beforeEach(() => {
    claimStatusByTaskId = {};
    claimRequests = [];
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const match = new URL(req.url).pathname.match(
          /^\/tasks\/([^/]+)\/claim$/,
        );
        if (req.method === "POST" && match) {
          const taskId = decodeURIComponent(match[1]);
          claimRequests.push(taskId);
          const status = claimStatusByTaskId[taskId] ?? 200;
          if (status >= 400) {
            return new Response(JSON.stringify({ error: "stub error" }), {
              status,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ ok: true }), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    savedEnv = {
      url: process.env.SHIPWRIGHT_TASK_STORE_URL,
      token: process.env.SHIPWRIGHT_TASK_STORE_TOKEN,
    };
    process.env.SHIPWRIGHT_TASK_STORE_URL = `http://localhost:${server.port}`;
    process.env.SHIPWRIGHT_TASK_STORE_TOKEN = "test-token";
  });

  afterEach(async () => {
    await server.stop(true);
    if (savedEnv.url !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_URL = savedEnv.url;
    } else {
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    }
    if (savedEnv.token !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN = savedEnv.token;
    } else {
      delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    }
  });

  function makeRecordingReporter(): {
    reporter: CronRunReporter;
    completedItemIds: string[];
  } {
    const completedItemIds: string[] = [];
    const reporter: CronRunReporter = {
      async createRun() {
        return "run-1";
      },
      async completeRun(
        _cronId,
        _runId,
        _completedAt,
        _outcome,
        _opts,
        _phaseId,
        _itemType,
        itemId,
      ) {
        if (itemId) completedItemIds.push(itemId);
      },
      async skipRun() {},
      async recordProgress() {},
      async recordSessionId() {},
    };
    return { reporter, completedItemIds };
  }

  const noopWorkQueueReporter: WorkQueueReporter = {
    async reportSnapshot() {},
  };

  test("a real 500 from POST /tasks/:id/claim does not abort the drain — it's skipped and a different candidate still dispatches", async () => {
    // SWC-BOOM (older) gets a real 500 from the stub; acme/x#9 (younger PR
    // review candidate) gets a real 200 from claimPr's own endpoint stub —
    // wired to always succeed since claimPr isn't the seam under test here.
    claimStatusByTaskId["SWC-BOOM"] = 500;

    const devTaskCandidates = [task("SWC-BOOM", "2026-01-01T00:00:00Z")];
    const reviewCandidates = [pr("acme/x#9", "2026-01-02T00:00:00Z", "review")];
    let devTaskCallCount = 0;
    let reviewConsumed = false;

    const { reporter, completedItemIds } = makeRecordingReporter();
    const messages: string[] = [];
    const runner = async (message: string): Promise<ClaudeRunResult> => {
      messages.push(message);
      if (message.includes("acme/x#9")) reviewConsumed = true;
      return { result: "done" };
    };

    const realClaim = createTaskStoreClient().claim;

    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => {
        devTaskCallCount += 1;
        return devTaskCandidates;
      },
      getReviewCandidates: async () => (reviewConsumed ? [] : reviewCandidates),
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: realClaim,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      // DTW-1.3: no live status (null) → the dev-task resume loop never fires.
      getTaskState: async () => null,
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-18T00:00:00Z")),
    });

    // The real claim() throw must not reject runLoopTick.
    await expect(loop(ALL_PHASES_ON)).resolves.toBeUndefined();

    // The real stub actually received the failing claim request — exactly
    // once. The drain re-collects dev-task candidates on every iteration
    // (including the one that dispatches the PR and the final dry-check),
    // so devTaskCallCount alone doesn't bound the spin-loop guarantee; what
    // matters is that SWC-BOOM itself is never re-claimed after its first
    // (failed) attempt within this tick.
    expect(claimRequests.filter((id) => id === "SWC-BOOM")).toHaveLength(1);

    // The offending dev-task never dispatched; the PR candidate did.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("/shipwright:review acme/x#9");
    expect(completedItemIds).toEqual(["acme/x#9"]);

    // Dev-task candidates are re-collected once per drain iteration (fail
    // attempt, PR dispatch, final dry-check) — three iterations here, not an
    // unbounded spin on the same failed item.
    expect(devTaskCallCount).toBe(3);
  });
});

describe("loop-orchestrator + child AgentCronJob rows (LPC-2.1)", () => {
  // No Bun.serve stub needed here — this suite exercises the real
  // createLoopOrchestrator() end-to-end against resolveLoopPhaseToggles'
  // child-row-scoped resolution, not the real task-store HTTP claim client
  // (that seam is covered by the CBD-2.1 suite above). Stub claim functions
  // are used per this repo's isolation contract (no real I/O needed to prove
  // this behavior).

  const PARENT_LOOP_ID = "loop-abc";

  function makeRecordingReporter(): {
    reporter: CronRunReporter;
    completedItemIds: string[];
  } {
    const completedItemIds: string[] = [];
    const reporter: CronRunReporter = {
      async createRun() {
        return "run-1";
      },
      async completeRun(
        _cronId,
        _runId,
        _completedAt,
        _outcome,
        _opts,
        _phaseId,
        _itemType,
        itemId,
      ) {
        if (itemId) completedItemIds.push(itemId);
      },
      async skipRun() {},
      async recordProgress() {},
      async recordSessionId() {},
    };
    return { reporter, completedItemIds };
  }

  const noopWorkQueueReporter: WorkQueueReporter = {
    async reportSnapshot() {},
  };

  /**
   * A realistic reconciled cron-job set: a parent loop row plus four child
   * phase rows (parentCronId: PARENT_LOOP_ID), mirroring exactly what
   * reconcileSystemCrons() produces per agent-types/coding/manifest.yaml's
   * parentCron: "shipwright-loop" declarations. Only the dev-task child's
   * enabled flag varies between fixtures below.
   */
  function reconciledJobs(devTaskEnabled: boolean): CronJobLike[] {
    return [
      {
        id: PARENT_LOOP_ID,
        name: "shipwright-loop",
        enabled: true,
        parentCronId: null,
      },
      childPhaseJob("shipwright-dev-task", devTaskEnabled, PARENT_LOOP_ID),
      childPhaseJob("shipwright-review", false, PARENT_LOOP_ID),
      childPhaseJob("shipwright-patch", false, PARENT_LOOP_ID),
      childPhaseJob("shipwright-deploy", false, PARENT_LOOP_ID),
    ];
  }

  test("dispatches dev-task candidates when the dev-task child row is enabled; disabling it stops dispatch; re-enabling resumes it", async () => {
    const { reporter, completedItemIds } = makeRecordingReporter();
    const messages: string[] = [];
    const runner = async (message: string): Promise<ClaudeRunResult> => {
      messages.push(message);
      return { result: "done" };
    };

    // Fresh consumed-tracking pool per makeLoop() call so each of the three
    // runs below (enabled / disabled / re-enabled) gets its own "fresh
    // candidate pool" per the AC's re-run wording, without spinning forever
    // on the same already-dispatched item within a single run.
    const makeLoop = () => {
      const consumed = new Set<string>();
      return createLoopOrchestrator({
        getDevTaskCandidates: async () =>
          consumed.has("SWC-1") ? [] : [task("SWC-1", "2026-01-01T00:00:00Z")],
        getReviewCandidates: async () => [],
        getPatchCandidates: async () => [],
        getDeployCandidates: async () => [],
        claimTask: async (id) => {
          consumed.add(id);
          return true;
        },
        claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
        recordSkip: async () => {},
        resetSkip: async () => {},
        // DTW-1.3: no live status (null) → the dev-task resume loop never fires.
        getTaskState: async () => null,
        runner,
        cronRunReporter: reporter,
        workQueueReporter: noopWorkQueueReporter,
        loopCronId: PARENT_LOOP_ID,
        clock: FixedClock(new Date("2026-07-18T00:00:00Z")),
      });
    };

    // 1. dev-task child row enabled — the loop reads the toggle from the
    // child row (parentCronId: PARENT_LOOP_ID), not any top-level lookup —
    // and dispatches the only candidate.
    await makeLoop()(reconciledJobs(true));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("/shipwright:dev-task SWC-1");
    expect(completedItemIds).toEqual(["SWC-1"]);

    // 2. Disabling the dev-task child row's enabled flag (fresh jobs array,
    // same parent) stops dispatch entirely — a fresh candidate pool yields
    // nothing dispatched (AC #2, disable half).
    messages.length = 0;
    completedItemIds.length = 0;
    await makeLoop()(reconciledJobs(false));
    expect(messages).toHaveLength(0);
    expect(completedItemIds).toHaveLength(0);

    // 3. Re-enabling (a third seeded jobs array, identical to the first)
    // resumes dispatch (AC #2, re-enable half).
    messages.length = 0;
    completedItemIds.length = 0;
    await makeLoop()(reconciledJobs(true));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("/shipwright:dev-task SWC-1");
    expect(completedItemIds).toEqual(["SWC-1"]);
  });
});

// ─── Progress push + partial-usage-on-failure (CSU-3.1) ────────────────────

describe("loop-orchestrator + progress push / partial-usage-on-failure (CSU-3.1)", () => {
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

  function makeRecordingReporter(): {
    reporter: CronRunReporter;
    completeCalls: Array<{
      outcome: "completed" | "failed";
      opts?: {
        error?: string;
        modelBreakdown?: ModelBreakdownEntry[];
        sessionId?: string;
      };
    }>;
    progressCalls: Array<{
      runId: string | null;
      modelBreakdown: ModelBreakdownEntry[];
    }>;
  } {
    const completeCalls: Array<{
      outcome: "completed" | "failed";
      opts?: {
        error?: string;
        modelBreakdown?: ModelBreakdownEntry[];
        sessionId?: string;
      };
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
      async recordSessionId() {},
    };
    return { reporter, completeCalls, progressCalls };
  }

  const noopWorkQueueReporter: WorkQueueReporter = {
    async reportSnapshot() {},
  };

  test("a runner that emits progress via onProgress before resolving triggers recordProgress mid-dispatch, before completeRun", async () => {
    const devTaskCandidates = [task("SWC-1.1", "2026-01-01T00:00:00Z")];
    const { reporter, completeCalls, progressCalls } = makeRecordingReporter();
    const callOrder: string[] = [];

    const trackedReporter: CronRunReporter = {
      ...reporter,
      async recordProgress(cronId, runId, modelBreakdown, lastHeartbeatAt) {
        callOrder.push("recordProgress");
        await reporter.recordProgress(
          cronId,
          runId,
          modelBreakdown,
          lastHeartbeatAt,
        );
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
      return {
        result: "done",
        modelUsage: makeUsage(),
        sessionId: "session-integration-completed",
      };
    };

    let devTaskCalls = 0;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => {
        devTaskCalls += 1;
        return devTaskCalls === 1 ? devTaskCandidates : [];
      },
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      // DTW-1.3: no live status (null) → the dev-task resume loop never fires.
      getTaskState: async () => null,
      runner,
      cronRunReporter: trackedReporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-dev-task", true)]);

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
    // CSI-2.3: runResult.sessionId reaches completeRun's opts on success.
    expect(completeCalls[0]?.opts?.sessionId).toBe(
      "session-integration-completed",
    );

    // recordProgress fired before completeRun for this dispatch.
    expect(callOrder).toEqual(["recordProgress", "completeRun"]);
  });

  test("a thrown ClaudeTimeoutError with partial usage results in completeRun's failed call carrying modelBreakdown, without aborting the tick", async () => {
    const devTaskCandidates = [task("SWC-2.2", "2026-01-01T00:00:00Z")];
    const consumed = new Set<string>();
    const { reporter, completeCalls } = makeRecordingReporter();

    const partialUsage = makeUsage({ inputTokens: 10, outputTokens: 5 });
    const runner = async (): Promise<ClaudeRunResult> => {
      throw new ClaudeTimeoutError(
        600_000,
        "ceiling",
        partialUsage,
        "session-integration-timeout",
      );
    };

    // Only offer the candidate once — mirrors production, where a
    // successful pre-claim (claimTask below always resolves true) removes
    // the task-store record from subsequent candidate queries even though
    // the dispatch itself went on to fail.
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () =>
        devTaskCandidates.filter((t) => !consumed.has(t.id)),
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      // Claim succeeding removes the item from candidacy (matches real
      // claimTask semantics) — without this, CBD-2.3's caught-and-isolated
      // dispatch throw would keep re-selecting the same always-failing item
      // forever instead of the tick resolving after one dispatch.
      claimTask: async (taskId: string) => {
        consumed.add(taskId);
        return true;
      },
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      // DTW-1.3: no live status (null) → the dev-task resume loop never fires.
      getTaskState: async () => null,
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    // Resolves cleanly — the throw is caught per-item in the drain loop
    // (throw isolation) rather than propagated out of the tick.
    await loop([job("shipwright-dev-task", true)]);

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
    // CSI-2.3: err.sessionId (ClaudeTimeoutError) reaches completeRun's opts
    // on the failure path.
    expect(completeCalls[0]?.opts?.sessionId).toBe(
      "session-integration-timeout",
    );
  });

  test("a [silent]-marker dispatch forwards runResult.sessionId to skipRun's opts (CSI-2.3)", async () => {
    const devTaskCandidates = [task("SWC-2.3", "2026-01-01T00:00:00Z")];
    const skipCalls: Array<{
      skipReason: string;
      opts?: { sessionId?: string };
    }> = [];
    const { reporter } = makeRecordingReporter();
    const trackedReporter: CronRunReporter = {
      ...reporter,
      async skipRun(
        cronId,
        runId,
        completedAt,
        skipReason,
        opts,
        phaseId,
        itemType,
        itemId,
      ) {
        skipCalls.push({ skipReason, opts });
        await reporter.skipRun(
          cronId,
          runId,
          completedAt,
          skipReason,
          opts,
          phaseId,
          itemType,
          itemId,
        );
      },
    };

    let devTaskCalls = 0;
    const runner = async (): Promise<ClaudeRunResult> => {
      devTaskCalls += 1;
      return {
        result: "Nothing to do here.\n[silent]",
        sessionId: "session-integration-skipped",
      };
    };

    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () =>
        devTaskCalls === 0 ? devTaskCandidates : [],
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      // DTW-1.3: no live status (null) → the dev-task resume loop never fires.
      getTaskState: async () => null,
      runner,
      cronRunReporter: trackedReporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-dev-task", true)]);

    expect(skipCalls).toHaveLength(1);
    expect(skipCalls[0]?.opts?.sessionId).toBe("session-integration-skipped");
  });
});

// ─── DTW-1.3 / DTR-1.1 / CRT-1.3: same-session auto-resume loop ──────────────

describe("loop-orchestrator + same-session auto-resume (DTW-1.3 / CRT-1.3)", () => {
  const noopWorkQueueReporter: WorkQueueReporter = {
    async reportSnapshot() {},
  };

  /** The agent id these tests run as — i.e. the expected `claimedBy` owner. */
  const OWNER_AGENT_ID = "agent-owner";

  /**
   * Records one entry per createRun/completeRun, tagged with the itemId the
   * dispatch was made against — so a test can assert "one AgentCronRun row per
   * attempt, all sharing the same itemId".
   */
  function makeAttemptRecordingReporter(): {
    reporter: CronRunReporter;
    creates: Array<{ itemId?: string }>;
    completes: Array<{ itemId?: string; outcome: string }>;
  } {
    const creates: Array<{ itemId?: string }> = [];
    const completes: Array<{ itemId?: string; outcome: string }> = [];
    let counter = 0;
    const reporter: CronRunReporter = {
      async createRun(_cronId, _startedAt, _phaseId, _itemType, itemId) {
        creates.push({ itemId });
        counter += 1;
        return `run-${counter}`;
      },
      async completeRun(
        _cronId,
        _runId,
        _completedAt,
        outcome,
        _opts,
        _phaseId,
        _itemType,
        itemId,
      ) {
        completes.push({ itemId, outcome });
      },
      async skipRun() {},
      async recordProgress() {},
      async recordSessionId() {},
    };
    return { reporter, creates, completes };
  }

  /** A runner that records the sessionKey it was handed on every call. */
  function makeSessionKeyRecordingRunner(): {
    runner: (
      message: string,
      onProgress?: ProgressCallback,
      sessionKey?: string,
    ) => Promise<ClaudeRunResult>;
    sessionKeys: Array<string | undefined>;
  } {
    const sessionKeys: Array<string | undefined> = [];
    const runner = async (
      _message: string,
      _onProgress?: ProgressCallback,
      sessionKey?: string,
    ): Promise<ClaudeRunResult> => {
      sessionKeys.push(sessionKey);
      return { result: "done" };
    };
    return { runner, sessionKeys };
  }

  /**
   * Scripted getTaskState: one entry per expected poll. A bare string is
   * shorthand for "that status, claimed by OWNER_AGENT_ID" (the common case —
   * this agent still owns the claim); pass an object to model a different
   * claimant. `null` models a task that's gone.
   */
  function makeStateStub(
    states: Array<string | null | { status: string; claimedBy: string | null }>,
  ): {
    getTaskState: (
      taskId: string,
    ) => Promise<{ status: string; claimedBy: string | null } | null>;
    calls: string[];
  } {
    const calls: string[] = [];
    let idx = 0;
    return {
      calls,
      getTaskState: async (taskId: string) => {
        calls.push(taskId);
        const entry = states[idx] ?? null;
        idx += 1;
        if (entry === null) return null;
        return typeof entry === "string"
          ? { status: entry, claimedBy: OWNER_AGENT_ID }
          : entry;
      },
    };
  }

  test("a dev-task dispatch left in_progress auto-resumes with the SAME sessionKey, capped at 3 resumes (4 runner calls)", async () => {
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter, creates, completes } = makeAttemptRecordingReporter();
    // in_progress for every check the cap allows; the trailing terminal value
    // is never reached because the 3-resume cap trips first.
    const { getTaskState, calls } = makeStateStub([
      "in_progress",
      "in_progress",
      "in_progress",
      "pr_open",
    ]);

    let devTaskCalls = 0;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => {
        devTaskCalls += 1;
        return devTaskCalls === 1
          ? [task("DTW-9.1", "2026-01-01T00:00:00Z")]
          : [];
      },
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      getTaskState,
      agentId: OWNER_AGENT_ID,
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-dev-task", true)]);

    // 1 initial + 3 resumes.
    expect(sessionKeys).toHaveLength(4);
    // Every call — initial AND resumes — reuses the same sessionKey, which is
    // what makes the underlying runner build `-r <sessionId>` on the resumes.
    expect(new Set(sessionKeys).size).toBe(1);
    // ...and that key is the exact stable `dev-task:{taskId}` form (DTR-1.1,
    // no per-dispatch nonce) — a later, independent dispatch of this same
    // task deliberately CAN resume this session (see the cross-dispatch test
    // below), which is the whole point of dropping the nonce.
    expect(sessionKeys[0]).toBe("dev-task:DTW-9.1");
    // Every status check was against the dispatched task.
    expect(calls.every((id) => id === "DTW-9.1")).toBe(true);
    // One AgentCronRun row per attempt, all tagged with the same itemId.
    expect(creates).toHaveLength(4);
    expect(completes).toHaveLength(4);
    expect(creates.every((c) => c.itemId === "DTW-9.1")).toBe(true);
    expect(completes.every((c) => c.itemId === "DTW-9.1")).toBe(true);
    expect(completes.every((c) => c.outcome === "completed")).toBe(true);
  });

  test("a task that never reaches a terminal state stops at exactly 3 resumes — not an infinite loop", async () => {
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter, creates, completes } = makeAttemptRecordingReporter();
    const alwaysInProgress = async () => ({
      status: "in_progress",
      claimedBy: OWNER_AGENT_ID,
    });

    let devTaskCalls = 0;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => {
        devTaskCalls += 1;
        return devTaskCalls === 1
          ? [task("DTW-9.2", "2026-01-01T00:00:00Z")]
          : [];
      },
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      getTaskState: alwaysInProgress,
      agentId: OWNER_AGENT_ID,
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-dev-task", true)]);

    expect(sessionKeys).toHaveLength(4);
    expect(creates).toHaveLength(4);
    expect(completes).toHaveLength(4);
  });

  test("a dev-task that reaches a terminal status after the first attempt is not resumed at all", async () => {
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter, creates } = makeAttemptRecordingReporter();
    // Two entries: the resume loop's own check consumes the first (sees
    // pr_open, stops resuming); the finally block's fresh DTR-1.1
    // terminal-status re-check consumes the second.
    const { getTaskState, calls } = makeStateStub(["pr_open", "pr_open"]);

    let devTaskCalls = 0;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => {
        devTaskCalls += 1;
        return devTaskCalls === 1
          ? [task("DTW-9.3", "2026-01-01T00:00:00Z")]
          : [];
      },
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      getTaskState,
      agentId: OWNER_AGENT_ID,
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-dev-task", true)]);

    expect(sessionKeys).toHaveLength(1);
    expect(creates).toHaveLength(1);
    expect(calls).toEqual(["DTW-9.3", "DTW-9.3"]);
  });

  test("two independent dispatches of the SAME in-progress task id resume the SAME sessionKey — cross-dispatch resume (DTR-1.1)", async () => {
    // DTR-1.1: sessionKey is now stable (`dev-task:{taskId}`, no per-dispatch
    // nonce) precisely so a LATER, fully independent dispatch of the same
    // task — the next tick after the StaleClaimReaper releases a stale
    // claim, a dispatch after an agent-process restart, or a human re-run —
    // picks up the SAME underlying Claude session instead of starting cold,
    // matching dev-task.md's resume contract across dispatches, not just
    // within one dispatch's own internal resume loop. The task stays
    // in_progress (never terminal) across both dispatches below, which under
    // the new finally-block logic means its sessionKey is never cleared
    // between them — that's what lets the second dispatch resume the
    // first's session via `-r`.
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter } = makeAttemptRecordingReporter();

    // Models "the task is claimable again on a later tick": the claim removes
    // it from candidacy for the rest of THIS drain, and the test resets the
    // flag between ticks to stand in for the reaper releasing the claim.
    let claimedThisTick = false;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () =>
        claimedThisTick ? [] : [task("DTW-9.4", "2026-01-01T00:00:00Z")],
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => {
        claimedThisTick = true;
        return true;
      },
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      // Never terminal → each dispatch exhausts its 3-resume cap, and the
      // key is never cleared between the two separate loop() calls below.
      getTaskState: async () => ({
        status: "in_progress",
        claimedBy: OWNER_AGENT_ID,
      }),
      agentId: OWNER_AGENT_ID,
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-dev-task", true)]);
    const firstDispatchKeys = [...sessionKeys];
    sessionKeys.length = 0;

    // Later, fully independent dispatch of the same task id (e.g. the next
    // cron tick after the StaleClaimReaper released a stale claim).
    claimedThisTick = false;
    await loop([job("shipwright-dev-task", true)]);
    const secondDispatchKeys = [...sessionKeys];

    // Each dispatch ran its full 1-initial + 3-resumes loop...
    expect(firstDispatchKeys).toHaveLength(4);
    expect(secondDispatchKeys).toHaveLength(4);
    // ...reusing one key WITHIN the dispatch (that's what makes `-r` fire on
    // its own resumes)...
    expect(new Set(firstDispatchKeys).size).toBe(1);
    expect(new Set(secondDispatchKeys).size).toBe(1);
    // ...and now the two SEPARATE dispatches share that SAME exact stable
    // key too — the core cross-dispatch resume behavior DTR-1.1 exists to
    // provide.
    expect(secondDispatchKeys[0]).toBe(firstDispatchKeys[0]);
    expect(firstDispatchKeys[0]).toBe("dev-task:DTW-9.4");
    expect(secondDispatchKeys[0]).toBe("dev-task:DTW-9.4");
  });

  test("a review dispatch never consults getTaskState — it gets a PR-phase nonce sessionKey and, with no getPrState wired, never resumes", async () => {
    // CRT-1.3 updated this test's premise: review/patch/deploy DO get a
    // sessionKey now (a per-dispatch `{phase}:{itemId}:{uuid}` nonce), so the
    // old "undefined sessionKey" assertion no longer describes the design.
    // What still holds — and is the point worth keeping here — is that a PR
    // item never touches the TASK-side resume deps: ownership for PR phases is
    // proven via getPrState, and with that dep unwired (as below) the loop has
    // no way to verify the claim, so it stops after the first attempt rather
    // than falling back to getTaskState against an id the task store would
    // never recognize.
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter, creates } = makeAttemptRecordingReporter();
    const statusCalls: string[] = [];

    let reviewConsumed = false;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => [],
      getReviewCandidates: async () =>
        reviewConsumed
          ? []
          : [pr("acme/x#7", "2026-01-01T00:00:00Z", "review")],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => {
        reviewConsumed = true;
        return { id: p.id, commitSha: p.commitSha };
      },
      recordSkip: async () => {},
      resetSkip: async () => {},
      getTaskState: async (id) => {
        statusCalls.push(id);
        return { status: "in_progress", claimedBy: OWNER_AGENT_ID };
      },
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-review", true)]);

    // One attempt only (no getPrState → no way to prove the claim is still
    // ours → no resume), handed a review-phase nonce key.
    expect(sessionKeys).toHaveLength(1);
    expect(sessionKeys[0]).toMatch(
      /^review:acme\/x#7:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // The task-side dep is still never consulted for a PR item.
    expect(statusCalls).toEqual([]);
    expect(creates).toHaveLength(1);
  });

  test("a task that is in_progress but claimed by ANOTHER agent is not resumed — the reap-then-reclaim race", async () => {
    // Regression test for the second-round review finding: one dispatch can
    // hold a task across up to 4 sequential runner() calls, long enough for the
    // claim TTL to lapse if an attempt stalls past its heartbeat. If the
    // StaleClaimReaper then releases the claim and a DIFFERENT claimant claims
    // it back to in_progress before this loop's next poll, a status-only gate
    // would resume this dispatch's stale session against a task another session
    // now owns. The gate must check ownership, not just status.
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter, creates } = makeAttemptRecordingReporter();
    // First poll (resume loop's own ownership check): still in_progress, but
    // reaped and re-claimed by someone else. Second poll (the finally
    // block's fresh DTR-1.1 terminal-status re-check): same non-terminal
    // status, so the key is not cleared.
    const { getTaskState, calls } = makeStateStub([
      { status: "in_progress", claimedBy: "agent-someone-else" },
      { status: "in_progress", claimedBy: "agent-someone-else" },
    ]);

    let devTaskCalls = 0;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => {
        devTaskCalls += 1;
        return devTaskCalls === 1
          ? [task("DTW-9.5", "2026-01-01T00:00:00Z")]
          : [];
      },
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      getTaskState,
      agentId: OWNER_AGENT_ID,
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-dev-task", true)]);

    // The initial attempt ran; the resume did not.
    expect(sessionKeys).toHaveLength(1);
    expect(creates).toHaveLength(1);
    expect(calls).toEqual(["DTW-9.5", "DTW-9.5"]);
  });

  test("an unclaimed (reaped, not yet re-claimed) in_progress task is not resumed either", async () => {
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter } = makeAttemptRecordingReporter();
    const { getTaskState } = makeStateStub([
      { status: "in_progress", claimedBy: null },
    ]);

    let devTaskCalls = 0;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => {
        devTaskCalls += 1;
        return devTaskCalls === 1
          ? [task("DTW-9.6", "2026-01-01T00:00:00Z")]
          : [];
      },
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      getTaskState,
      agentId: OWNER_AGENT_ID,
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-dev-task", true)]);

    expect(sessionKeys).toHaveLength(1);
  });

  test("with no agentId configured the gate stays status-only — resuming still works", async () => {
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter } = makeAttemptRecordingReporter();
    // claimedBy is whatever the store says; without an agentId to compare it
    // against, the loop must behave exactly as it did before the ownership gate.
    const { getTaskState } = makeStateStub([
      { status: "in_progress", claimedBy: "agent-someone-else" },
      { status: "pr_open", claimedBy: "agent-someone-else" },
    ]);

    let devTaskCalls = 0;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => {
        devTaskCalls += 1;
        return devTaskCalls === 1
          ? [task("DTW-9.7", "2026-01-01T00:00:00Z")]
          : [];
      },
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      getTaskState,
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-dev-task", true)]);

    // 1 initial + 1 resume, then the terminal pr_open stops the loop.
    expect(sessionKeys).toHaveLength(2);
  });

  test("the sessionKey is cleared once the task reaches a terminal status", async () => {
    // DTR-1.1: the sessionKey is now stable (`dev-task:{taskId}`, no
    // per-dispatch nonce) so it can survive across separate dispatches —
    // it must therefore be cleared explicitly, and only once the task-store
    // confirms (via a FRESH getTaskState check in the finally block) that
    // the task has actually left active dev-task work. Without this,
    // sessions.json (shared with Slack thread sessions, read+rewritten on
    // every Slack message) would keep a stable key around forever once a
    // task reaches pr_open/blocked/cancelled/done. Two stub entries: the
    // resume loop's own check (sees pr_open, stops resuming without
    // clearing) and the finally block's fresh terminal-status re-check that
    // actually triggers the clear.
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter } = makeAttemptRecordingReporter();
    const cleared: string[] = [];
    const { getTaskState } = makeStateStub(["pr_open", "pr_open"]);

    let devTaskCalls = 0;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => {
        devTaskCalls += 1;
        return devTaskCalls === 1
          ? [task("DTW-9.8", "2026-01-01T00:00:00Z")]
          : [];
      },
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      getTaskState,
      agentId: OWNER_AGENT_ID,
      clearSessionKey: async (key) => {
        cleared.push(key);
      },
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-dev-task", true)]);

    // Exactly the key this dispatch used, cleared exactly once, in the
    // exact stable dev-task:{taskId} form.
    expect(cleared).toEqual([sessionKeys[0] as string]);
    expect(cleared[0]).toBe("dev-task:DTW-9.8");
  });

  test("a failed dev-task attempt with unknown final status does NOT clear its sessionKey — the key must survive so a later dispatch can still resume", async () => {
    // DTR-1.1: getTaskState returning null (task not found / lookup failed)
    // means the finally block cannot confirm the task reached a terminal
    // status — fail toward PRESERVING the key. A wrongly-preserved key only
    // costs one future resume attempt; a wrongly-cleared one silently and
    // permanently loses resumability for a task that may still be
    // in_progress.
    const { reporter } = makeAttemptRecordingReporter();
    const cleared: string[] = [];
    const runner = async (): Promise<ClaudeRunResult> => {
      throw new Error("runner boom");
    };

    let devTaskCalls = 0;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => {
        devTaskCalls += 1;
        return devTaskCalls === 1
          ? [task("DTW-9.9", "2026-01-01T00:00:00Z")]
          : [];
      },
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      getTaskState: async () => null,
      agentId: OWNER_AGENT_ID,
      clearSessionKey: async (key) => {
        cleared.push(key);
      },
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    // The dispatch failure is caught+isolated by the drain loop (CBD-2.3), so
    // the tick resolves — the point here is that an unconfirmed final status
    // leaves the sessionKey untouched.
    await loop([job("shipwright-dev-task", true)]);

    expect(cleared).toHaveLength(0);
  });

  test("a clearSessionKey failure never masks the dispatch outcome, when the task IS confirmed terminal", async () => {
    // Companion to the test above: this exercises the invariant that a
    // clearSessionKey failure is swallowed and never crashes the dispatch,
    // in the one scenario where the finally block actually attempts a clear
    // (a confirmed terminal status) rather than skipping it.
    const { reporter, completes } = makeAttemptRecordingReporter();
    const cleared: string[] = [];
    const runner = async (): Promise<ClaudeRunResult> => {
      throw new Error("runner boom");
    };

    let devTaskCalls = 0;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => {
        devTaskCalls += 1;
        return devTaskCalls === 1
          ? [task("DTW-9.13", "2026-01-01T00:00:00Z")]
          : [];
      },
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      getTaskState: async () => ({
        status: "pr_open",
        claimedBy: OWNER_AGENT_ID,
      }),
      agentId: OWNER_AGENT_ID,
      clearSessionKey: async (key) => {
        cleared.push(key);
        throw new Error("session store unwritable");
      },
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    // Must not throw out of the tick — the drain loop isolates the runner's
    // own failure (CBD-2.3), and the clearSessionKey failure inside the
    // finally block must be swallowed on top of that.
    await loop([job("shipwright-dev-task", true)]);

    // The clear was attempted (and failed, harmlessly) exactly once, against
    // the exact stable key.
    expect(cleared).toEqual(["dev-task:DTW-9.13"]);
    // The runner's own failure is still faithfully reported as a failed run —
    // the clearSessionKey failure did not mask it.
    expect(completes).toEqual([{ itemId: "DTW-9.13", outcome: "failed" }]);
  });

  test("a getTaskState failure during the finally block's own terminal-status check does not clear the sessionKey or crash the dispatch", async () => {
    // Distinct from the "unknown final status" test above (which models
    // getTaskState resolving to null): this models getTaskState REJECTING
    // during the finally block's fresh check — a task-store blip, not a
    // "task not found". Same fail-safe contract either way: cannot confirm
    // terminal, so the key must survive and the dispatch must not crash.
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter } = makeAttemptRecordingReporter();
    const cleared: string[] = [];

    let devTaskCalls = 0;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => {
        devTaskCalls += 1;
        return devTaskCalls === 1
          ? [task("DTW-9.14", "2026-01-01T00:00:00Z")]
          : [];
      },
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      // Throws on every call: the resume loop's own check (line ~1035) hits
      // this first and stops resuming (pre-existing fail-safe, unchanged by
      // DTR-1.1); the finally block's fresh terminal-status check (the new
      // DTR-1.1 code path this test targets) then hits it again on its own.
      getTaskState: async () => {
        throw new Error("task-store 503");
      },
      clearSessionKey: async (key) => {
        cleared.push(key);
      },
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-dev-task", true)]);

    expect(sessionKeys).toEqual(["dev-task:DTW-9.14"]);
    expect(cleared).toHaveLength(0);
  });

  test("every resume attempt renews the claim FIRST — one dispatch never outlives the single-session claim TTL", async () => {
    // Regression test for the third-round review finding: lib/claim-ttl.ts
    // sizes DEFAULT_CLAIM_TTL_MS as "one Claude session + 5min buffer", an
    // invariant that assumes a claim spans exactly one session. This loop can
    // hold one claim across up to 4 sequential runner() calls, and an attempt
    // that exits before its in-session heartbeat step leaves the claim to go
    // stale mid-dispatch — the StaleClaimReaper then releases it and a sibling
    // agent can start a second, cold session on the same task/branch. The
    // ownership gate closes the resume half of that race; renewing the claim
    // before each attempt closes the reap half.
    const events: string[] = [];
    const runner = async (): Promise<ClaudeRunResult> => {
      events.push("run");
      return { result: "done" };
    };
    const { reporter, creates } = makeAttemptRecordingReporter();
    // Never terminal → the dispatch exhausts its 3-resume cap.
    const { getTaskState } = makeStateStub([
      "in_progress",
      "in_progress",
      "in_progress",
    ]);

    let devTaskCalls = 0;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => {
        devTaskCalls += 1;
        return devTaskCalls === 1
          ? [task("DTW-9.10", "2026-01-01T00:00:00Z")]
          : [];
      },
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      getTaskState,
      agentId: OWNER_AGENT_ID,
      heartbeatTask: async (id) => {
        events.push(`heartbeat:${id}`);
      },
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-dev-task", true)]);

    // The initial attempt runs on the claim the loop just took (POST /claim
    // sets heartbeatAt itself, so no renewal is needed before it); every
    // resume is preceded by exactly one renewal of THIS task's claim.
    expect(events).toEqual([
      "run",
      "heartbeat:DTW-9.10",
      "run",
      "heartbeat:DTW-9.10",
      "run",
      "heartbeat:DTW-9.10",
      "run",
    ]);
    expect(creates).toHaveLength(4);
  });

  test("a claim renewal failure stops the resume loop but leaves the dispatch itself successful", async () => {
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter, creates, completes } = makeAttemptRecordingReporter();
    const { getTaskState } = makeStateStub(["in_progress", "in_progress"]);

    let devTaskCalls = 0;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => {
        devTaskCalls += 1;
        return devTaskCalls === 1
          ? [task("DTW-9.11", "2026-01-01T00:00:00Z")]
          : [];
      },
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      getTaskState,
      agentId: OWNER_AGENT_ID,
      heartbeatTask: async () => {
        throw new Error("task-store POST /tasks/DTW-9.11/heartbeat → 503");
      },
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-dev-task", true)]);

    // Fail-safe: a claim that can't be proven fresh is never resumed against
    // (pre-DTW-1.3 behavior — the reaper + next tick take over)...
    expect(sessionKeys).toHaveLength(1);
    // ...and the renewal blip must not turn an otherwise-successful dispatch
    // into a failed cron run.
    expect(creates).toHaveLength(1);
    expect(completes).toEqual([{ itemId: "DTW-9.11", outcome: "completed" }]);
  });

  test("a task reaped and re-claimed by another agent is never heartbeated on that agent's behalf", async () => {
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter } = makeAttemptRecordingReporter();
    const heartbeats: string[] = [];
    const { getTaskState } = makeStateStub([
      { status: "in_progress", claimedBy: "agent-someone-else" },
    ]);

    let devTaskCalls = 0;
    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => {
        devTaskCalls += 1;
        return devTaskCalls === 1
          ? [task("DTW-9.12", "2026-01-01T00:00:00Z")]
          : [];
      },
      getReviewCandidates: async () => [],
      getPatchCandidates: async () => [],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async (p) => ({ id: p.id, commitSha: p.commitSha }),
      recordSkip: async () => {},
      resetSkip: async () => {},
      getTaskState,
      agentId: OWNER_AGENT_ID,
      heartbeatTask: async (id) => {
        heartbeats.push(id);
      },
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-dev-task", true)]);

    expect(sessionKeys).toHaveLength(1);
    // The renewal is ordered after the ownership gate, so a claim that now
    // belongs to a sibling agent is left to age out on its own schedule.
    expect(heartbeats).toEqual([]);
  });

  // ─── CRT-1.3: the same resume loop, widened to the PR phases ───────────────
  //
  // review/patch/deploy now participate in the auto-resume loop too, but on
  // their OWN mechanism — deliberately parallel to dev-task's rather than
  // shared with it:
  //   - sessionKey is a PER-DISPATCH nonce (`{phase}:{itemId}:{uuid}`), i.e.
  //     exactly the shape dev-task used before DTR-1.1 dropped its nonce. A
  //     later, separate dispatch of the same PR therefore starts cold.
  //   - ownership is proven via getPrState (claimedBy only — a PR has no
  //     in_progress-equivalent status gate, since every real PR completion
  //     path already nulls claimedBy) and renewed via heartbeatPr.
  //   - the key is cleared UNCONDITIONALLY on exit, since nothing downstream
  //     is ever meant to resume it.
  // dev-task's DTR-1.1 behavior above is untouched by any of this.

  /** The three PR phases CRT-1.3 widened the resume gate to. */
  const PR_PHASES = ["review", "patch", "deploy"] as const;
  type PrPhase = (typeof PR_PHASES)[number];

  /** Maps a PR phase to the child cron job name that enables it. */
  const PR_PHASE_JOB: Record<PrPhase, string> = {
    review: "shipwright-review",
    patch: "shipwright-patch",
    deploy: "shipwright-deploy",
  };

  /**
   * Matches the per-dispatch nonce sessionKey CRT-1.3 mints for a PR phase:
   * `{phase}:{itemId}:{randomUUID()}`. Asserted by pattern rather than exact
   * equality because the nonce is, by design, unpredictable.
   */
  function nonceKeyPattern(phase: string, itemId: string): RegExp {
    const literalItemId = itemId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `^${phase}:${literalItemId}:` +
        "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    );
  }

  /**
   * Scripted getPrState — the PR-item analog of makeStateStub above, one entry
   * per expected poll. `"mine"` is shorthand for "still claimed by
   * OWNER_AGENT_ID" (the common case); pass an object to model a release
   * (`claimedBy: null`) or a reap-then-reclaim by a sibling agent; `null`
   * models a PR record that's gone. There is deliberately no status field —
   * ownership is the entire gate for a PR item.
   */
  function makePrStateStub(
    states: Array<"mine" | null | { claimedBy: string | null }>,
  ): {
    getPrState: (prId: string) => Promise<{ claimedBy: string | null } | null>;
    calls: string[];
  } {
    const calls: string[] = [];
    let idx = 0;
    return {
      calls,
      getPrState: async (prId: string) => {
        calls.push(prId);
        const entry = states[idx] ?? null;
        idx += 1;
        if (entry === null) return null;
        return entry === "mine" ? { claimedBy: OWNER_AGENT_ID } : entry;
      },
    };
  }

  /** The PullRequest DB record id claimPr hands back for `prId`. */
  function recordIdFor(prId: string): string {
    return `clx-${prId.replace(/\W/g, "")}`;
  }

  /**
   * Builds an orchestrator wired to dispatch exactly ONE PR candidate in the
   * given phase, then drain dry.
   *
   * The record id claimPr returns is deliberately NOT equal to the
   * human-readable `org/repo#123` itemId, so a test can prove the resume gate
   * calls getPrState/heartbeatPr with the PullRequest DB record's CUID (what
   * GET/POST /prs/{id} expects) rather than the display id those routes would
   * 404 on. getTaskState throws for the same reason: a PR item must never
   * reach the task-side resume deps.
   */
  function makePrPhaseLoop(opts: {
    phase: PrPhase;
    prId: string;
    runner: (
      message: string,
      onProgress?: ProgressCallback,
      sessionKey?: string,
    ) => Promise<ClaudeRunResult>;
    reporter: CronRunReporter;
    getPrState?: (prId: string) => Promise<{ claimedBy: string | null } | null>;
    heartbeatPr?: (prId: string) => Promise<void>;
    clearSessionKey?: (key: string) => Promise<void>;
    /** Models SHIPWRIGHT_AGENT_ID being unset (the fail-open gate). */
    noAgentId?: boolean;
  }): (jobs: CronJobLike[]) => Promise<void> {
    const recordId = recordIdFor(opts.prId);
    const commitSha = `${opts.prId}-sha`;
    let consumed = false;
    const candidates = async (): Promise<WorkPrCandidate[]> =>
      consumed
        ? []
        : [
            {
              id: opts.prId,
              age: "2026-01-01T00:00:00Z",
              phase: opts.phase,
              commitSha,
            },
          ];
    const noCandidates = async (): Promise<WorkPrCandidate[]> => [];

    return createLoopOrchestrator({
      getDevTaskCandidates: async () => [],
      getReviewCandidates: opts.phase === "review" ? candidates : noCandidates,
      getPatchCandidates: opts.phase === "patch" ? candidates : noCandidates,
      getDeployCandidates: opts.phase === "deploy" ? candidates : noCandidates,
      claimTask: async () => true,
      claimPr: async () => {
        consumed = true;
        return { id: recordId, commitSha };
      },
      recordSkip: async () => {},
      resetSkip: async () => {},
      getTaskState: async () => {
        throw new Error("getTaskState must never be consulted for a PR item");
      },
      agentId: opts.noAgentId ? undefined : OWNER_AGENT_ID,
      getPrState: opts.getPrState,
      heartbeatPr: opts.heartbeatPr,
      clearSessionKey: opts.clearSessionKey,
      runner: opts.runner,
      cronRunReporter: opts.reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });
  }

  for (const phase of PR_PHASES) {
    const prId = `acme/${phase}#7`;
    const recordId = recordIdFor(prId);

    test(`a ${phase} dispatch whose PR is still claimed by this agent auto-resumes the SAME nonce sessionKey, capped at 3 resumes (4 runner calls)`, async () => {
      const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
      const { reporter, creates, completes } = makeAttemptRecordingReporter();
      // Three polls is exactly what the 3-resume cap allows; unlike dev-task
      // there is no fourth, finally-block poll (the clear is unconditional).
      const { getPrState, calls } = makePrStateStub(["mine", "mine", "mine"]);
      const heartbeats: string[] = [];
      const cleared: string[] = [];

      const loop = makePrPhaseLoop({
        phase,
        prId,
        runner,
        reporter,
        getPrState,
        heartbeatPr: async (id) => {
          heartbeats.push(id);
        },
        clearSessionKey: async (key) => {
          cleared.push(key);
        },
      });

      await loop([job(PR_PHASE_JOB[phase], true)]);

      // 1 initial + 3 resumes, every call reusing the one key that makes the
      // underlying runner build `-r <sessionId>` on the resumes...
      expect(sessionKeys).toHaveLength(4);
      expect(new Set(sessionKeys).size).toBe(1);
      // ...and that key is a per-dispatch nonce, not dev-task's stable form.
      expect(sessionKeys[0]).toMatch(nonceKeyPattern(phase, prId));
      // Both PR-side deps are called with the PullRequest DB record id.
      expect(calls).toEqual([recordId, recordId, recordId]);
      expect(heartbeats).toEqual([recordId, recordId, recordId]);
      // One AgentCronRun row per attempt, all tagged with the display itemId.
      expect(creates).toHaveLength(4);
      expect(completes).toHaveLength(4);
      expect(completes.every((c) => c.itemId === prId)).toBe(true);
      expect(completes.every((c) => c.outcome === "completed")).toBe(true);
      // Unconditional clear on exit — no cross-dispatch persistence.
      expect(cleared).toEqual([sessionKeys[0] as string]);
    });

    test(`a ${phase} dispatch whose PR claim was released is not resumed`, async () => {
      const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
      const { reporter, creates, completes } = makeAttemptRecordingReporter();
      // The normal clean-completion shape: every real PR completion path nulls
      // claimedBy, which is precisely why ownership alone is a sufficient gate.
      const { getPrState, calls } = makePrStateStub([{ claimedBy: null }]);
      const heartbeats: string[] = [];

      const loop = makePrPhaseLoop({
        phase,
        prId,
        runner,
        reporter,
        getPrState,
        heartbeatPr: async (id) => {
          heartbeats.push(id);
        },
      });

      await loop([job(PR_PHASE_JOB[phase], true)]);

      expect(sessionKeys).toHaveLength(1);
      expect(creates).toHaveLength(1);
      expect(completes).toEqual([{ itemId: prId, outcome: "completed" }]);
      expect(calls).toEqual([recordId]);
      // Never heartbeat a claim the gate just rejected.
      expect(heartbeats).toEqual([]);
    });

    test(`a ${phase} dispatch whose PR was reaped and re-claimed by ANOTHER agent is not resumed`, async () => {
      const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
      const { reporter, creates } = makeAttemptRecordingReporter();
      const { getPrState } = makePrStateStub([
        { claimedBy: "agent-someone-else" },
      ]);
      const heartbeats: string[] = [];

      const loop = makePrPhaseLoop({
        phase,
        prId,
        runner,
        reporter,
        getPrState,
        heartbeatPr: async (id) => {
          heartbeats.push(id);
        },
      });

      await loop([job(PR_PHASE_JOB[phase], true)]);

      // Resuming here would put two sessions on one PR/branch.
      expect(sessionKeys).toHaveLength(1);
      expect(creates).toHaveLength(1);
      expect(heartbeats).toEqual([]);
    });
  }

  test("a PR-phase resume renews the claim FIRST — heartbeatPr is ordered before every resume attempt", async () => {
    const events: string[] = [];
    const runner = async (): Promise<ClaudeRunResult> => {
      events.push("run");
      return { result: "done" };
    };
    const { reporter, creates } = makeAttemptRecordingReporter();
    const { getPrState } = makePrStateStub(["mine", "mine", "mine"]);
    const prId = "acme/x#21";

    const loop = makePrPhaseLoop({
      phase: "patch",
      prId,
      runner,
      reporter,
      getPrState,
      heartbeatPr: async (id) => {
        events.push(`heartbeat:${id}`);
      },
    });

    await loop([job("shipwright-patch", true)]);

    // POST /prs/claim set heartbeatAt itself, so the initial attempt needs no
    // renewal; every resume is preceded by exactly one.
    const recordId = recordIdFor(prId);
    expect(events).toEqual([
      "run",
      `heartbeat:${recordId}`,
      "run",
      `heartbeat:${recordId}`,
      "run",
      `heartbeat:${recordId}`,
      "run",
    ]);
    expect(creates).toHaveLength(4);
  });

  test("two separate dispatches of the same PR get DIFFERENT nonce keys — PR phases have no cross-dispatch persistence (unlike dev-task's DTR-1.1)", async () => {
    // The mirror image of the dev-task cross-dispatch test above: dev-task's
    // stable key deliberately survives a dispatch so the next one resumes it,
    // while a PR phase's nonce deliberately does not — a reclaim, or simply
    // this dispatch ending, always means a cold start next time.
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter } = makeAttemptRecordingReporter();
    const cleared: string[] = [];
    // A fresh commitSha on the second tick, so CBD-2.2's redispatch cooldown
    // (keyed on id+phase+commitSha) doesn't suppress the second dispatch.
    let commitSha = "sha-1";
    let consumed = false;

    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () => [],
      getReviewCandidates: async () => [],
      getPatchCandidates: async () =>
        consumed
          ? []
          : [
              {
                id: "acme/x#22",
                age: "2026-01-01T00:00:00Z",
                phase: "patch" as const,
                commitSha,
              },
            ],
      getDeployCandidates: async () => [],
      claimTask: async () => true,
      claimPr: async () => {
        consumed = true;
        return { id: "clx-22", commitSha };
      },
      recordSkip: async () => {},
      resetSkip: async () => {},
      getTaskState: async () => null,
      agentId: OWNER_AGENT_ID,
      // Released after the first attempt, so each dispatch is a single attempt.
      getPrState: async () => ({ claimedBy: null }),
      clearSessionKey: async (key) => {
        cleared.push(key);
      },
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([job("shipwright-patch", true)]);
    consumed = false;
    commitSha = "sha-2";
    await loop([job("shipwright-patch", true)]);

    expect(sessionKeys).toHaveLength(2);
    expect(sessionKeys[0]).toMatch(nonceKeyPattern("patch", "acme/x#22"));
    expect(sessionKeys[1]).toMatch(nonceKeyPattern("patch", "acme/x#22"));
    // Different nonces → the second dispatch cannot resume the first.
    expect(sessionKeys[1]).not.toBe(sessionKeys[0]);
    // Each dispatch cleared its own key on the way out.
    expect(cleared).toEqual(sessionKeys as string[]);
  });

  test("a PR record that has vanished (getPrState → null) is not resumed", async () => {
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter, completes } = makeAttemptRecordingReporter();
    const { getPrState } = makePrStateStub([null]);

    const loop = makePrPhaseLoop({
      phase: "deploy",
      prId: "acme/x#23",
      runner,
      reporter,
      getPrState,
    });

    await loop([job("shipwright-deploy", true)]);

    expect(sessionKeys).toHaveLength(1);
    expect(completes).toEqual([{ itemId: "acme/x#23", outcome: "completed" }]);
  });

  test("a getPrState failure stops the resume loop but leaves the dispatch itself successful", async () => {
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter, creates, completes } = makeAttemptRecordingReporter();
    const cleared: string[] = [];

    const loop = makePrPhaseLoop({
      phase: "review",
      prId: "acme/x#24",
      runner,
      reporter,
      getPrState: async () => {
        throw new Error("task-store GET /prs/clx-24 → 503");
      },
      clearSessionKey: async (key) => {
        cleared.push(key);
      },
    });

    await loop([job("shipwright-review", true)]);

    // Resuming is an optimization — a task-store blip must not fail a dispatch.
    expect(sessionKeys).toHaveLength(1);
    expect(creates).toHaveLength(1);
    expect(completes).toEqual([{ itemId: "acme/x#24", outcome: "completed" }]);
    expect(cleared).toHaveLength(1);
  });

  test("a heartbeatPr failure stops the resume loop but leaves the dispatch itself successful", async () => {
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter, completes } = makeAttemptRecordingReporter();
    const { getPrState } = makePrStateStub(["mine", "mine"]);

    const loop = makePrPhaseLoop({
      phase: "patch",
      prId: "acme/x#25",
      runner,
      reporter,
      getPrState,
      heartbeatPr: async () => {
        throw new Error("task-store POST /prs/clx-25/heartbeat → 503");
      },
    });

    await loop([job("shipwright-patch", true)]);

    expect(sessionKeys).toHaveLength(1);
    expect(completes).toEqual([{ itemId: "acme/x#25", outcome: "completed" }]);
  });

  test("with heartbeatPr unwired the PR-phase loop still resumes — identical to the pre-CRT-1.2 no-renewal behavior", async () => {
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter } = makeAttemptRecordingReporter();
    const { getPrState } = makePrStateStub(["mine", { claimedBy: null }]);

    const loop = makePrPhaseLoop({
      phase: "deploy",
      prId: "acme/x#26",
      runner,
      reporter,
      getPrState,
    });

    await loop([job("shipwright-deploy", true)]);

    // 1 initial + 1 resume, then the released claim stops the loop.
    expect(sessionKeys).toHaveLength(2);
    expect(new Set(sessionKeys).size).toBe(1);
  });

  test("with no agentId configured the PR-phase gate fails open — resuming still works", async () => {
    // Mirrors the dev-task gate's stance: an agent with no SHIPWRIGHT_AGENT_ID
    // has nothing to compare claimedBy against, so it must behave as it did
    // before the ownership gate existed rather than silently never resuming.
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter } = makeAttemptRecordingReporter();
    const { getPrState } = makePrStateStub([
      { claimedBy: "agent-someone-else" },
      null,
    ]);

    const loop = makePrPhaseLoop({
      phase: "review",
      prId: "acme/x#27",
      runner,
      reporter,
      getPrState,
      noAgentId: true,
    });

    await loop([job("shipwright-review", true)]);

    // 1 initial + 1 resume, then the vanished record stops the loop.
    expect(sessionKeys).toHaveLength(2);
  });

  test("a thrown PR-phase attempt never resumes and still clears its nonce key", async () => {
    // AC4: crash/timeout handling is unchanged — the throw propagates to the
    // drain loop's per-item isolation (CBD-2.3) and the reaper fallback, and
    // the resume loop is never entered. The nonce is still cleared, since
    // nothing downstream is ever meant to resume it.
    const { reporter, completes } = makeAttemptRecordingReporter();
    const cleared: string[] = [];
    const prStateCalls: string[] = [];
    const runner = async (): Promise<ClaudeRunResult> => {
      throw new Error("runner boom");
    };

    const loop = makePrPhaseLoop({
      phase: "patch",
      prId: "acme/x#28",
      runner,
      reporter,
      getPrState: async (id) => {
        prStateCalls.push(id);
        return { claimedBy: OWNER_AGENT_ID };
      },
      clearSessionKey: async (key) => {
        cleared.push(key);
      },
    });

    await loop([job("shipwright-patch", true)]);

    expect(completes).toEqual([{ itemId: "acme/x#28", outcome: "failed" }]);
    // A failed attempt is never followed by an ownership poll or a resume.
    expect(prStateCalls).toEqual([]);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatch(nonceKeyPattern("patch", "acme/x#28"));
  });

  test("a clearSessionKey failure on a PR phase never masks the dispatch outcome", async () => {
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter, completes } = makeAttemptRecordingReporter();
    const cleared: string[] = [];
    const { getPrState } = makePrStateStub([{ claimedBy: null }]);

    const loop = makePrPhaseLoop({
      phase: "review",
      prId: "acme/x#29",
      runner,
      reporter,
      getPrState,
      clearSessionKey: async (key) => {
        cleared.push(key);
        throw new Error("session store unwritable");
      },
    });

    await loop([job("shipwright-review", true)]);

    expect(cleared).toHaveLength(1);
    expect(sessionKeys).toHaveLength(1);
    expect(completes).toEqual([{ itemId: "acme/x#29", outcome: "completed" }]);
  });

  test("widening the gate leaves dev-task's key format and clear condition untouched — one tick, both mechanisms side by side", async () => {
    // AC1: the same drain dispatches a dev-task item and a PR item. The
    // dev-task key stays the stable, nonce-free `dev-task:{taskId}` form and
    // is cleared only because its task is confirmed terminal (pr_open); the
    // PR key carries a nonce and is cleared unconditionally.
    const { runner, sessionKeys } = makeSessionKeyRecordingRunner();
    const { reporter } = makeAttemptRecordingReporter();
    const cleared: string[] = [];
    let taskConsumed = false;
    let prConsumed = false;

    const loop = createLoopOrchestrator({
      getDevTaskCandidates: async () =>
        taskConsumed ? [] : [task("CRT-9.1", "2026-01-01T00:00:00Z")],
      getReviewCandidates: async () => [],
      getPatchCandidates: async () =>
        prConsumed ? [] : [pr("acme/x#30", "2026-01-02T00:00:00Z", "patch")],
      getDeployCandidates: async () => [],
      claimTask: async () => {
        taskConsumed = true;
        return true;
      },
      claimPr: async (p) => {
        prConsumed = true;
        return { id: "clx-30", commitSha: p.commitSha };
      },
      recordSkip: async () => {},
      resetSkip: async () => {},
      // Terminal right away: the dev-task loop stops resuming AND its finally
      // block clears the stable key.
      getTaskState: async () => ({
        status: "pr_open",
        claimedBy: OWNER_AGENT_ID,
      }),
      // Released right away: the PR loop stops resuming after one attempt.
      getPrState: async () => ({ claimedBy: null }),
      agentId: OWNER_AGENT_ID,
      clearSessionKey: async (key) => {
        cleared.push(key);
      },
      runner,
      cronRunReporter: reporter,
      workQueueReporter: noopWorkQueueReporter,
      loopCronId: "shipwright-loop",
      clock: FixedClock(new Date("2026-07-20T00:00:00Z")),
    });

    await loop([
      job("shipwright-dev-task", true),
      job("shipwright-patch", true),
    ]);

    expect(sessionKeys).toHaveLength(2);
    // The older task item wins the FIFO, so it's dispatched first.
    expect(sessionKeys[0]).toBe("dev-task:CRT-9.1");
    expect(sessionKeys[1]).toMatch(nonceKeyPattern("patch", "acme/x#30"));
    expect(cleared).toEqual([sessionKeys[0], sessionKeys[1]] as string[]);
  });
});
