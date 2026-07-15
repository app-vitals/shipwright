/**
 * agent/src/loop-orchestrator.unit.test.ts
 *
 * Unit tests for createLoopOrchestrator() — the WL-3.3 busy-guard +
 * drain-until-dry loop handler. Pure orchestration logic over injected deps:
 * a FixedClock, a stub claude runner, four stub WL-2.2 qualification
 * functions, and a recording stub CronRunReporter. No real Claude invocation,
 * no HTTP calls, no global overrides — per the repo's test-isolation contract.
 */

import { describe, expect, test } from "bun:test";
import type { ClaudeRunResult } from "./claude.ts";
import { FixedClock } from "./clock.ts";
import type { CronRunReporter } from "./cron-run-reporter.ts";
import type { CronJobLike } from "./loop-cron-classifier.ts";
import {
  type LoopOrchestratorDeps,
  type LoopOrchestratorProductionOptions,
  createLoopOrchestrator,
  createLoopOrchestratorGetter,
} from "./loop-orchestrator.ts";
import type { WorkPrCandidate, WorkTaskCandidate } from "./work-selector.ts";

// ─── Stub reporter ──────────────────────────────────────────────────────────

interface CreateCall {
  cronId: string;
  phase?: string;
}
interface CompleteCall {
  cronId: string;
  runId: string | null;
  outcome: "completed" | "failed";
  phase?: string;
}
interface SkipCall {
  cronId: string;
  runId: string | null;
  skipReason: string;
  phase?: string;
}

function makeRecordingReporter(): {
  reporter: CronRunReporter;
  creates: CreateCall[];
  completes: CompleteCall[];
  skips: SkipCall[];
} {
  const creates: CreateCall[] = [];
  const completes: CompleteCall[] = [];
  const skips: SkipCall[] = [];
  let counter = 0;

  const reporter: CronRunReporter = {
    async createRun(cronId, _startedAt, phase) {
      creates.push({ cronId, phase });
      counter += 1;
      return `run-${counter}`;
    },
    async completeRun(cronId, runId, _completedAt, outcome, _opts, phase) {
      completes.push({ cronId, runId, outcome, phase });
    },
    async skipRun(cronId, runId, _completedAt, skipReason, _opts, phase) {
      skips.push({ cronId, runId, skipReason, phase });
    },
  };

  return { reporter, creates, completes, skips };
}

// ─── Stub runner ──────────────────────────────────────────────────────────

/** Records each dispatched message and returns a scripted result per call. */
function makeRunner(results: (string | ClaudeRunResult)[] = []): {
  runner: (message: string) => Promise<ClaudeRunResult>;
  messages: string[];
} {
  const messages: string[] = [];
  let idx = 0;
  const runner = async (message: string): Promise<ClaudeRunResult> => {
    messages.push(message);
    const scripted = results[idx];
    idx += 1;
    if (scripted === undefined) return { result: "done" };
    if (typeof scripted === "string") return { result: scripted };
    return scripted;
  };
  return { runner, messages };
}

/**
 * A runner that drains a shared candidate pool: on each dispatch it records
 * the message and marks the oldest still-unconsumed candidate matching the
 * dispatched command's phase as consumed, so the next collection pass no
 * longer returns it. This models the real drain end-to-end without brittle
 * per-iteration candidate arrays.
 */
function makeDrainingRunner(
  pools: {
    devTask?: WorkTaskCandidate[];
    review?: WorkPrCandidate[];
    patch?: WorkPrCandidate[];
    deploy?: WorkPrCandidate[];
  },
  consumed: Set<string>,
  results: (string | ClaudeRunResult)[] = [],
): {
  runner: (message: string) => Promise<ClaudeRunResult>;
  messages: string[];
} {
  const messages: string[] = [];
  const commandToPool: Record<string, { id: string; age: string }[]> = {
    "/shipwright:dev-task": (pools.devTask ?? []).map((t) => ({
      id: t.id,
      age: t.createdAt,
    })),
    "/shipwright:review": (pools.review ?? []).map((p) => ({
      id: p.id,
      age: p.age,
    })),
    "/shipwright:patch": (pools.patch ?? []).map((p) => ({
      id: p.id,
      age: p.age,
    })),
    "/shipwright:deploy": (pools.deploy ?? []).map((p) => ({
      id: p.id,
      age: p.age,
    })),
  };
  let idx = 0;
  const runner = async (message: string): Promise<ClaudeRunResult> => {
    messages.push(message);
    // The message is "<command> <itemId>" — match by command prefix since
    // the trailing item id varies per dispatch.
    const command = Object.keys(commandToPool).find(
      (c) => message === c || message.startsWith(`${c} `),
    );
    // Consume the oldest unconsumed candidate of this command's phase.
    const candidates = (command ? commandToPool[command] : []) ?? [];
    const sorted = candidates
      .filter((c) => !consumed.has(c.id))
      .sort((a, b) => (a.age < b.age ? -1 : 1));
    if (sorted[0]) consumed.add(sorted[0].id);

    const scripted = results[idx];
    idx += 1;
    if (scripted === undefined) return { result: "done" };
    if (typeof scripted === "string") return { result: scripted };
    return scripted;
  };
  return { runner, messages };
}

// ─── Candidate fixtures ──────────────────────────────────────────────────────

function task(
  id: string,
  createdAt: string,
  overrides: Partial<WorkTaskCandidate> = {},
): WorkTaskCandidate {
  return { id, status: "pending", createdAt, ...overrides };
}

function pr(
  id: string,
  age: string,
  phase: "review" | "patch" | "deploy",
): WorkPrCandidate {
  return { id, age, phase };
}

// ─── Deps builder ────────────────────────────────────────────────────────────

interface MakeDepsOptions {
  devTaskCandidates?:
    | WorkTaskCandidate[]
    | (() => Promise<WorkTaskCandidate[]>);
  reviewCandidates?: WorkPrCandidate[] | (() => Promise<WorkPrCandidate[]>);
  patchCandidates?: WorkPrCandidate[] | (() => Promise<WorkPrCandidate[]>);
  deployCandidates?: WorkPrCandidate[] | (() => Promise<WorkPrCandidate[]>);
  runner?: (message: string) => Promise<ClaudeRunResult>;
  reporter?: CronRunReporter;
  loopCronId?: string;
  // Records which qualification functions were actually invoked.
  calls?: string[];
  // Set of dispatched-item ids that must stop qualifying — shared across the
  // stubs to model "a claimed item no longer appears as a candidate", giving a
  // deterministic drain without brittle per-iteration arrays.
  consumed?: Set<string>;
  // Direct raw-callable override for the dev-task qualification fn — used by
  // tests that need full control (e.g. hanging or throwing).
  getDevTaskCandidates?: () => Promise<WorkTaskCandidate[]>;
}

/**
 * A qualification stub that returns its candidate pool minus any ids already
 * consumed (dispatched) this run — mirroring real qualification, where a
 * claimed/dispatched item stops qualifying on the next collection pass. A
 * function value bypasses the pool for full control (e.g. throwing, hanging).
 */
function poolStub<T extends { id: string }>(
  name: string,
  pool: T[] | (() => Promise<T[]>) | undefined,
  consumed: Set<string>,
  calls?: string[],
): () => Promise<T[]> {
  if (typeof pool === "function") {
    return async () => {
      calls?.push(name);
      return pool();
    };
  }
  const items = pool ?? [];
  return async () => {
    calls?.push(name);
    return items.filter((it) => !consumed.has(it.id));
  };
}

function makeDeps(options: MakeDepsOptions = {}): LoopOrchestratorDeps {
  const calls = options.calls;
  const consumed = options.consumed ?? new Set<string>();
  const baseRunner = options.runner ?? makeRunner().runner;
  return {
    getDevTaskCandidates:
      options.getDevTaskCandidates ??
      poolStub("devTask", options.devTaskCandidates, consumed, calls),
    getReviewCandidates: poolStub(
      "review",
      options.reviewCandidates,
      consumed,
      calls,
    ),
    getPatchCandidates: poolStub(
      "patch",
      options.patchCandidates,
      consumed,
      calls,
    ),
    getDeployCandidates: poolStub(
      "deploy",
      options.deployCandidates,
      consumed,
      calls,
    ),
    runner: baseRunner,
    cronRunReporter: options.reporter ?? makeRecordingReporter().reporter,
    loopCronId: options.loopCronId ?? "shipwright-loop",
    clock: FixedClock(new Date("2026-07-10T00:00:00Z")),
  };
}

// ─── Job fixtures ────────────────────────────────────────────────────────────

function job(name: string, enabled: boolean): CronJobLike {
  return { id: name, name, enabled };
}

const ALL_PHASES_ON: CronJobLike[] = [
  job("shipwright-dev-task", true),
  job("shipwright-review", true),
  job("shipwright-patch", true),
  job("shipwright-deploy", true),
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createLoopOrchestratorGetter", () => {
  test("calls createOrchestrator once on first invocation with the provided loopCronId", async () => {
    const { reporter } = makeRecordingReporter();
    const { runner } = makeRunner();
    const calls: Array<{ loopCronId: string | undefined }> = [];

    const fakeCreateOrchestrator = async (
      opts: LoopOrchestratorProductionOptions,
    ) => {
      calls.push({ loopCronId: opts.loopCronId });
      return async (_jobs: CronJobLike[]) => {
        // stub orchestrator
      };
    };

    const getter = createLoopOrchestratorGetter({
      runner,
      cronRunReporter: reporter,
      createOrchestrator: fakeCreateOrchestrator,
    });

    const orch1 = await getter("real-cron-id-123");
    expect(calls).toEqual([{ loopCronId: "real-cron-id-123" }]);
    expect(orch1).toBeDefined();
  });

  test("memoizes the orchestrator and never calls createOrchestrator twice", async () => {
    const { reporter } = makeRecordingReporter();
    const { runner } = makeRunner();
    const calls: Array<{ loopCronId: string | undefined }> = [];

    const fakeCreateOrchestrator = async (
      opts: LoopOrchestratorProductionOptions,
    ) => {
      calls.push({ loopCronId: opts.loopCronId });
      return async (_jobs: CronJobLike[]) => {
        // stub orchestrator
      };
    };

    const getter = createLoopOrchestratorGetter({
      runner,
      cronRunReporter: reporter,
      createOrchestrator: fakeCreateOrchestrator,
    });

    const orch1 = await getter("real-cron-id-123");
    const orch2 = await getter("different-id-456");

    // Should only be called once, with the first ID, and the second call
    // should return the same orchestrator
    expect(calls).toEqual([{ loopCronId: "real-cron-id-123" }]);
    expect(orch1).toBe(orch2);
  });

  test("resets memoization on rejection and retries on next call", async () => {
    const { reporter } = makeRecordingReporter();
    const { runner } = makeRunner();
    const calls: Array<{ loopCronId: string | undefined; attempt: number }> =
      [];
    let attempt = 0;

    const fakeCreateOrchestrator = async (
      opts: LoopOrchestratorProductionOptions,
    ) => {
      attempt += 1;
      calls.push({ loopCronId: opts.loopCronId, attempt });
      if (attempt === 1) {
        throw new Error("transient failure");
      }
      return async (_jobs: CronJobLike[]) => {
        // stub orchestrator
      };
    };

    const getter = createLoopOrchestratorGetter({
      runner,
      cronRunReporter: reporter,
      createOrchestrator: fakeCreateOrchestrator,
    });

    // First call fails
    try {
      await getter("real-cron-id-123");
    } catch (e) {
      expect((e as Error).message).toBe("transient failure");
    }

    // Second call should retry (not use cached rejection)
    const orch = await getter("real-cron-id-123");
    expect(orch).toBeDefined();

    // Should have called createOrchestrator twice (once failed, once succeeded)
    expect(calls).toEqual([
      { loopCronId: "real-cron-id-123", attempt: 1 },
      { loopCronId: "real-cron-id-123", attempt: 2 },
    ]);
  });
});

describe("createLoopOrchestrator", () => {
  test("no-ops when the busy flag is already set from an in-flight tick", async () => {
    // First tick's qualification hangs until we release it, so the tick is
    // still draining when the second tick fires.
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const messages: string[] = [];

    const deps = makeDeps({
      getDevTaskCandidates: async () => {
        await gate;
        return [];
      },
      runner: async (m: string) => {
        messages.push(m);
        return { result: "done" };
      },
    });
    const loop = createLoopOrchestrator(deps);

    const first = loop(ALL_PHASES_ON);
    // Second call while first is still draining — must no-op immediately.
    await loop(ALL_PHASES_ON);
    expect(messages).toEqual([]);

    release();
    await first;
    // First tick found nothing → still no dispatch.
    expect(messages).toEqual([]);
  });

  test("skips disabled phases: a disabled phase's qualification fn is never called", async () => {
    const calls: string[] = [];
    const deps = makeDeps({ calls });
    const loop = createLoopOrchestrator(deps);

    await loop([
      job("shipwright-dev-task", true),
      job("shipwright-review", false),
      job("shipwright-patch", false),
      job("shipwright-deploy", false),
    ]);

    expect(calls).toContain("devTask");
    expect(calls).not.toContain("review");
    expect(calls).not.toContain("patch");
    expect(calls).not.toContain("deploy");
  });

  test("dispatches /shipwright:dev-task for a winning task", async () => {
    const consumed = new Set<string>();
    const devTaskCandidates = [task("SWC-1.1", "2026-01-01T00:00:00Z")];
    const { runner, messages } = makeDrainingRunner(
      { devTask: devTaskCandidates },
      consumed,
    );
    const deps = makeDeps({ devTaskCandidates, runner, consumed });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-dev-task", true)]);

    expect(messages).toEqual(["/shipwright:dev-task SWC-1.1"]);
  });

  test("dispatches /shipwright:review for a winning review PR", async () => {
    const consumed = new Set<string>();
    const reviewCandidates = [pr("acme/x#1", "2026-01-01T00:00:00Z", "review")];
    const { runner, messages } = makeDrainingRunner(
      { review: reviewCandidates },
      consumed,
    );
    const deps = makeDeps({ reviewCandidates, runner, consumed });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-review", true)]);

    expect(messages).toEqual(["/shipwright:review acme/x#1"]);
  });

  test("dispatches /shipwright:patch for a winning patch PR", async () => {
    const consumed = new Set<string>();
    const patchCandidates = [pr("acme/x#2", "2026-01-01T00:00:00Z", "patch")];
    const { runner, messages } = makeDrainingRunner(
      { patch: patchCandidates },
      consumed,
    );
    const deps = makeDeps({ patchCandidates, runner, consumed });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-patch", true)]);

    expect(messages).toEqual(["/shipwright:patch acme/x#2"]);
  });

  test("dispatches /shipwright:deploy for a winning deploy PR", async () => {
    const consumed = new Set<string>();
    const deployCandidates = [pr("acme/x#3", "2026-01-01T00:00:00Z", "deploy")];
    const { runner, messages } = makeDrainingRunner(
      { deploy: deployCandidates },
      consumed,
    );
    const deps = makeDeps({ deployCandidates, runner, consumed });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-deploy", true)]);

    expect(messages).toEqual(["/shipwright:deploy acme/x#3"]);
  });

  test("selects the globally-oldest item across phases and drains in age order", async () => {
    // A patch PR is oldest, then a dev task, then a review PR. As each item is
    // dispatched the draining runner marks it consumed, so it stops qualifying
    // on the next collection pass — the loop drains in strict age order across
    // all three phases.
    const consumed = new Set<string>();
    const devTaskCandidates = [task("SWC-1.1", "2026-01-02T00:00:00Z")];
    const reviewCandidates = [pr("acme/x#9", "2026-01-03T00:00:00Z", "review")];
    const patchCandidates = [pr("acme/x#5", "2026-01-01T00:00:00Z", "patch")];
    const { runner, messages } = makeDrainingRunner(
      {
        devTask: devTaskCandidates,
        review: reviewCandidates,
        patch: patchCandidates,
      },
      consumed,
    );
    const deps = makeDeps({
      devTaskCandidates,
      reviewCandidates,
      patchCandidates,
      runner,
      consumed,
    });
    const loop = createLoopOrchestrator(deps);

    await loop(ALL_PHASES_ON);

    expect(messages).toEqual([
      "/shipwright:patch acme/x#5",
      "/shipwright:dev-task SWC-1.1",
      "/shipwright:review acme/x#9",
    ]);
  });

  test("never invokes /shipwright:review-patch regardless of that job's enabled state", async () => {
    const consumed = new Set<string>();
    const reviewCandidates = [pr("acme/x#1", "2026-01-01T00:00:00Z", "review")];
    const { runner, messages } = makeDrainingRunner(
      { review: reviewCandidates },
      consumed,
    );
    const deps = makeDeps({ reviewCandidates, runner, consumed });
    const loop = createLoopOrchestrator(deps);

    // review-patch enabled=true must not change what is invoked.
    await loop([
      job("shipwright-review", true),
      job("shipwright-review-patch", true),
    ]);

    expect(messages).toEqual(["/shipwright:review acme/x#1"]);
    expect(messages).not.toContain("/shipwright:review-patch");
  });

  test("review-patch enabled state does not change dispatch when disabled either", async () => {
    const consumed = new Set<string>();
    const reviewCandidates = [pr("acme/x#1", "2026-01-01T00:00:00Z", "review")];
    const { runner, messages } = makeDrainingRunner(
      { review: reviewCandidates },
      consumed,
    );
    const deps = makeDeps({ reviewCandidates, runner, consumed });
    const loop = createLoopOrchestrator(deps);

    await loop([
      job("shipwright-review", true),
      job("shipwright-review-patch", false),
    ]);

    expect(messages).toEqual(["/shipwright:review acme/x#1"]);
  });

  test("reports a tagged createRun/completeRun pair per dispatch", async () => {
    const consumed = new Set<string>();
    const { reporter, creates, completes, skips } = makeRecordingReporter();
    const devTaskCandidates = [task("SWC-1.1", "2026-01-02T00:00:00Z")];
    const deployCandidates = [pr("acme/x#3", "2026-01-01T00:00:00Z", "deploy")];
    const { runner } = makeDrainingRunner(
      { devTask: devTaskCandidates, deploy: deployCandidates },
      consumed,
    );
    const deps = makeDeps({
      devTaskCandidates,
      deployCandidates,
      runner,
      reporter,
      consumed,
    });
    const loop = createLoopOrchestrator(deps);

    await loop([
      job("shipwright-dev-task", true),
      job("shipwright-deploy", true),
    ]);

    // Two dispatches → two create/complete pairs, deploy first (older).
    expect(creates.map((c) => c.phase)).toEqual(["deploy", "dev-task"]);
    expect(completes.map((c) => c.phase)).toEqual(["deploy", "dev-task"]);
    expect(completes.every((c) => c.outcome === "completed")).toBe(true);
    expect(creates.every((c) => c.cronId === "shipwright-loop")).toBe(true);
    expect(skips).toEqual([]);
  });

  test("an idle tick with no candidates across all phases reports zero runs", async () => {
    const { reporter, creates, completes, skips } = makeRecordingReporter();
    const deps = makeDeps({ reporter });
    const loop = createLoopOrchestrator(deps);

    await loop(ALL_PHASES_ON);

    expect(creates).toEqual([]);
    expect(completes).toEqual([]);
    expect(skips).toEqual([]);
  });

  test("a dispatch whose command reports [silent] is recorded as skipped, not completed", async () => {
    const consumed = new Set<string>();
    const { reporter, creates, completes, skips } = makeRecordingReporter();
    const devTaskCandidates = [task("SWC-1.1", "2026-01-01T00:00:00Z")];
    // The command runs but reports [silent] — it was dispatched (selected) but
    // found nothing to do. The draining runner still consumes the candidate,
    // so the next collection pass returns nothing and the drain ends.
    const { runner } = makeDrainingRunner(
      { devTask: devTaskCandidates },
      consumed,
      [{ result: "Nothing to do here.\n[silent]" }],
    );
    const deps = makeDeps({ devTaskCandidates, runner, reporter, consumed });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-dev-task", true)]);

    expect(creates.map((c) => c.phase)).toEqual(["dev-task"]);
    expect(completes).toEqual([]);
    expect(skips.map((s) => s.phase)).toEqual(["dev-task"]);
  });

  test("a runner throw during dispatch reports a failed run, rethrows, and still releases the busy flag", async () => {
    const consumed = new Set<string>();
    const { reporter, creates, completes, skips } = makeRecordingReporter();
    const devTaskCandidates = [task("SWC-1.1", "2026-01-01T00:00:00Z")];
    const runner = async (message: string) => {
      throw new Error(`claude run failed for ${message}`);
    };
    const deps = makeDeps({
      devTaskCandidates,
      runner,
      reporter,
      consumed,
    });
    const loop = createLoopOrchestrator(deps);

    await expect(loop([job("shipwright-dev-task", true)])).rejects.toThrow(
      "claude run failed for /shipwright:dev-task",
    );

    // The run was created and then completed with outcome "failed" — never
    // silently dropped — and the error propagated instead of being swallowed.
    expect(creates.map((c) => c.phase)).toEqual(["dev-task"]);
    expect(completes).toEqual([
      {
        cronId: "shipwright-loop",
        runId: "run-1",
        outcome: "failed",
        phase: "dev-task",
      },
    ]);
    expect(skips).toEqual([]);

    // The SAME closure's busy flag is released — a subsequent tick on it is
    // not blocked (all phases disabled here, so it just no-ops on candidates).
    await loop([job("shipwright-dev-task", false)]);
    expect(creates.map((c) => c.phase)).toEqual(["dev-task"]);
  });

  test("releases the busy flag even when an iteration throws", async () => {
    let firstCall = true;
    const deps = makeDeps({
      getDevTaskCandidates: async () => {
        if (firstCall) {
          firstCall = false;
          throw new Error("boom");
        }
        return [];
      },
    });
    const loop = createLoopOrchestrator(deps);

    // First tick throws mid-drain.
    await expect(loop([job("shipwright-dev-task", true)])).rejects.toThrow(
      "boom",
    );

    // A subsequent tick must NOT be blocked by a stuck busy flag: it runs
    // and reaches the (now non-throwing) qualification path.
    await loop([job("shipwright-dev-task", true)]);
    expect(firstCall).toBe(false);
  });

  test("empty jobs array dispatches nothing and reports nothing", async () => {
    const { reporter, creates } = makeRecordingReporter();
    const { runner, messages } = makeRunner();
    const deps = makeDeps({ reporter, runner });
    const loop = createLoopOrchestrator(deps);

    await loop([]);

    expect(messages).toEqual([]);
    expect(creates).toEqual([]);
  });
});
