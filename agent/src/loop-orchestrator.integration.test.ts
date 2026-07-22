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
import type { ClaudeRunResult } from "./claude.ts";
import { FixedClock } from "./clock.ts";
import type { CronRunReporter } from "./cron-run-reporter.ts";
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
 * reconcileSystemCrons() (admin/src/system-crons.ts, LPC-1.2) produces it —
 * parentCronId set to the loop row's own id. Distinct from the local job()
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
  const PORT = 19962;
  let claimStatusByTaskId: Record<string, number>;
  let claimRequests: string[];
  let savedEnv: { url?: string; token?: string };

  beforeEach(() => {
    claimStatusByTaskId = {};
    claimRequests = [];
    server = Bun.serve({
      port: PORT,
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
    process.env.SHIPWRIGHT_TASK_STORE_URL = `http://localhost:${PORT}`;
    process.env.SHIPWRIGHT_TASK_STORE_TOKEN = "test-token";
  });

  afterEach(() => {
    server.stop(true);
    if (savedEnv.url !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_URL = savedEnv.url;
    } else {
      // biome-ignore lint/performance/noDelete: intentional env cleanup
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    }
    if (savedEnv.token !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN = savedEnv.token;
    } else {
      // biome-ignore lint/performance/noDelete: intentional env cleanup
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
    };
    return { reporter, completedItemIds };
  }

  const noopWorkQueueReporter: WorkQueueReporter = {
    async reportSnapshot() {},
  };

  /**
   * A realistic reconciled cron-job set: a parent loop row plus four child
   * phase rows (parentCronId: PARENT_LOOP_ID), mirroring exactly what
   * reconcileSystemCrons() produces per admin/src/system-crons.ts's
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
