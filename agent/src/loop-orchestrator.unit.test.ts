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
import {
  ClaudeRunError,
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
import {
  type LoopOrchestratorDeps,
  type LoopOrchestratorProductionOptions,
  createLoopOrchestrator,
  createLoopOrchestratorGetter,
  formatPreClaimMarker,
} from "./loop-orchestrator.ts";
import type { WorkQueueReporter } from "./work-queue-reporter.ts";
import {
  type RankedWorkItem,
  type WorkPrCandidate,
  type WorkTaskCandidate,
  rankWorkItems,
} from "./work-selector.ts";

// ─── Stub reporter ──────────────────────────────────────────────────────────

interface CreateCall {
  cronId: string;
  phaseId?: string;
  itemType?: string;
  itemId?: string;
}
interface CompleteCall {
  cronId: string;
  runId: string | null;
  outcome: "completed" | "failed";
  phaseId?: string;
  itemType?: string;
  itemId?: string;
}
interface SkipCall {
  cronId: string;
  runId: string | null;
  skipReason: string;
  opts?: {
    error?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    modelBreakdown?: import("./cron-run-reporter.ts").ModelBreakdownEntry[];
  };
  phaseId?: string;
  itemType?: string;
  itemId?: string;
}
interface ProgressCall {
  cronId: string;
  runId: string | null;
  modelBreakdown: ModelBreakdownEntry[];
}

function makeRecordingReporter(): {
  reporter: CronRunReporter;
  creates: CreateCall[];
  completes: CompleteCall[];
  skips: SkipCall[];
  progressCalls: ProgressCall[];
} {
  const creates: CreateCall[] = [];
  const completes: CompleteCall[] = [];
  const skips: SkipCall[] = [];
  const progressCalls: ProgressCall[] = [];
  let counter = 0;

  const reporter: CronRunReporter = {
    async createRun(cronId, _startedAt, phaseId, itemType, itemId) {
      creates.push({ cronId, phaseId, itemType, itemId });
      counter += 1;
      return `run-${counter}`;
    },
    async completeRun(
      cronId,
      runId,
      _completedAt,
      outcome,
      _opts,
      phaseId,
      itemType,
      itemId,
    ) {
      completes.push({ cronId, runId, outcome, phaseId, itemType, itemId });
    },
    async skipRun(
      cronId,
      runId,
      _completedAt,
      skipReason,
      opts,
      phaseId,
      itemType,
      itemId,
    ) {
      skips.push({
        cronId,
        runId,
        skipReason,
        opts,
        phaseId,
        itemType,
        itemId,
      });
    },
    async recordProgress(cronId, runId, modelBreakdown) {
      progressCalls.push({ cronId, runId, modelBreakdown });
    },
  };

  return { reporter, creates, completes, skips, progressCalls };
}

// ─── Stub skip tracker (SKT-2.1) ────────────────────────────────────────────

interface SkipTrackerCall {
  itemType: "task" | "pr";
  recordId: string;
}

/**
 * A recording stub for the recordSkip/resetSkip deps — analogous to
 * makeRecordingReporter above. Both fns never throw by default (matching the
 * fire-and-forget contract); pass a custom `recordSkip`/`resetSkip` fn to
 * script a rejection for the "errors don't propagate" test.
 */
function makeRecordingSkipTracker(overrides?: {
  recordSkip?: (itemType: "task" | "pr", recordId: string) => Promise<void>;
  resetSkip?: (itemType: "task" | "pr", recordId: string) => Promise<void>;
}): {
  recordSkip: (itemType: "task" | "pr", recordId: string) => Promise<void>;
  resetSkip: (itemType: "task" | "pr", recordId: string) => Promise<void>;
  recordCalls: SkipTrackerCall[];
  resetCalls: SkipTrackerCall[];
} {
  const recordCalls: SkipTrackerCall[] = [];
  const resetCalls: SkipTrackerCall[] = [];

  const recordSkip = async (
    itemType: "task" | "pr",
    recordId: string,
  ): Promise<void> => {
    recordCalls.push({ itemType, recordId });
    if (overrides?.recordSkip) await overrides.recordSkip(itemType, recordId);
  };
  const resetSkip = async (
    itemType: "task" | "pr",
    recordId: string,
  ): Promise<void> => {
    resetCalls.push({ itemType, recordId });
    if (overrides?.resetSkip) await overrides.resetSkip(itemType, recordId);
  };

  return { recordSkip, resetSkip, recordCalls, resetCalls };
}

// ─── Stub work queue reporter ───────────────────────────────────────────────

interface SnapshotCall {
  computedAt: string;
  items: RankedWorkItem[];
}

function makeRecordingWorkQueueReporter(): {
  reporter: WorkQueueReporter;
  snapshots: SnapshotCall[];
} {
  const snapshots: SnapshotCall[] = [];
  const reporter: WorkQueueReporter = {
    async reportSnapshot(snapshot) {
      snapshots.push({
        computedAt: snapshot.computedAt,
        items: snapshot.items,
      });
    },
  };
  return { reporter, snapshots };
}

// ─── Stub runner ──────────────────────────────────────────────────────────

/** Records each dispatched message and returns a scripted result per call. */
function makeRunner(results: (string | ClaudeRunResult)[] = []): {
  runner: (
    message: string,
    onProgress?: ProgressCallback,
  ) => Promise<ClaudeRunResult>;
  messages: string[];
} {
  const messages: string[] = [];
  let idx = 0;
  const runner = async (
    message: string,
    _onProgress?: ProgressCallback,
  ): Promise<ClaudeRunResult> => {
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
  runner: (
    message: string,
    onProgress?: ProgressCallback,
  ) => Promise<ClaudeRunResult>;
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
  const runner = async (
    message: string,
    _onProgress?: ProgressCallback,
  ): Promise<ClaudeRunResult> => {
    messages.push(message);
    // The message is formatCronMessage(loopCronId, "<command> <itemId>") —
    // i.e. "[Cron job: ...] Current time: ...\n\n<command> <itemId>". Match
    // by scanning for the command anywhere in the message (not just as a
    // prefix) since the trailing item id varies per dispatch and the tag
    // prefix now precedes the command.
    const command = Object.keys(commandToPool).find((c) => message.includes(c));
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
  return { id, createdAt, ...overrides };
}

function pr(
  id: string,
  age: string,
  phase: "review" | "patch" | "deploy",
  overrides: Partial<WorkPrCandidate> = {},
): WorkPrCandidate {
  return { id, age, phase, commitSha: `${id}-sha`, ...overrides };
}

/**
 * Asserts that each dispatched message is the given command string wrapped
 * via formatCronMessage("shipwright-loop", command) — i.e. tagged with
 * `[Cron job: shipwright-loop] Current time: ...` so it's excluded from
 * downstream time-tracking session-merging (LCT-1.1). Timestamp-agnostic by
 * design: only the tag prefix and the trailing command are checked.
 */
function expectDispatchedCommands(
  messages: string[],
  commands: string[],
  loopCronId = "shipwright-loop",
): void {
  expect(messages).toHaveLength(commands.length);
  messages.forEach((message, i) => {
    expect(message).toStartWith(`[Cron job: ${loopCronId}] Current time:`);
    expect(message).toEndWith(`\n\n${commands[i]}`);
  });
}

// ─── Deps builder ────────────────────────────────────────────────────────────

interface MakeDepsOptions {
  devTaskCandidates?:
    | WorkTaskCandidate[]
    | (() => Promise<WorkTaskCandidate[]>);
  reviewCandidates?: WorkPrCandidate[] | (() => Promise<WorkPrCandidate[]>);
  patchCandidates?: WorkPrCandidate[] | (() => Promise<WorkPrCandidate[]>);
  deployCandidates?: WorkPrCandidate[] | (() => Promise<WorkPrCandidate[]>);
  runner?: (
    message: string,
    onProgress?: ProgressCallback,
  ) => Promise<ClaudeRunResult>;
  reporter?: CronRunReporter;
  workQueueReporter?: WorkQueueReporter;
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
  // Pre-claim hook (CBD-1.2) invoked before dispatching a winning dev-task
  // item. Defaults to a stub that always resolves true (claim succeeds), so
  // existing tests that don't pass this option are unaffected.
  claimTask?: (taskId: string) => Promise<boolean>;
  // Pre-claim hook (CBD-1.3) invoked before dispatching a winning PR item.
  // Defaults to a stub that echoes the candidate's id+commitSha (claim
  // succeeds), so existing tests that don't pass this option are unaffected.
  claimPr?: (
    pr: WorkPrCandidate,
  ) => Promise<{ id: string; commitSha: string } | null>;
  // Skip-tracking hooks (SKT-2.1). Default to recording stubs that never
  // throw, following the claimTask/claimPr default-stub pattern above.
  recordSkip?: (itemType: "task" | "pr", recordId: string) => Promise<void>;
  resetSkip?: (itemType: "task" | "pr", recordId: string) => Promise<void>;
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

// A claimTask stub that succeeds and marks the task consumed, matching real
// claimTask semantics (a successful claim removes the item from candidacy).
// Needed anywhere a dispatch throw is exercised — without it, CBD-2.3's
// caught-and-isolated dispatch throw would keep re-selecting the same
// always-failing item forever instead of the tick resolving after one
// dispatch.
function consumingClaimTask(consumed: Set<string>) {
  return async (taskId: string) => {
    consumed.add(taskId);
    return true;
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
    workQueueReporter:
      options.workQueueReporter ?? makeRecordingWorkQueueReporter().reporter,
    loopCronId: options.loopCronId ?? "shipwright-loop",
    clock: FixedClock(new Date("2026-07-10T00:00:00Z")),
    claimTask: options.claimTask ?? (async () => true),
    claimPr:
      options.claimPr ??
      (async (pr: WorkPrCandidate) => ({
        id: pr.id,
        commitSha: pr.commitSha,
      })),
    recordSkip: options.recordSkip ?? (async () => {}),
    resetSkip: options.resetSkip ?? (async () => {}),
  };
}

// ─── Job fixtures ────────────────────────────────────────────────────────────

function job(name: string, enabled: boolean): CronJobLike {
  return { id: name, name, enabled, parentCronId: "shipwright-loop" };
}

const ALL_PHASES_ON: CronJobLike[] = [
  job("shipwright-dev-task", true),
  job("shipwright-review", true),
  job("shipwright-patch", true),
  job("shipwright-deploy", true),
];

// ─── console.warn capture ──────────────────────────────────────────────────

// Captures console.warn calls for the duration of `fn`, restoring the
// original afterward even if `fn` throws.
async function withCapturedWarnings(
  fn: () => Promise<void>,
): Promise<string[]> {
  const warnMessages: string[] = [];
  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    warnMessages.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = originalWarn;
  }
  return warnMessages;
}

// ─── console.log / console.info capture (LTO-1.1) ──────────────────────────

// Captures console.log AND console.info calls for the duration of `fn`,
// restoring both originals afterward even if `fn` throws. Used to assert on
// the distinguishable no-op-reason logs runLoopTick emits for the busy /
// backoff-active / genuinely-empty / backoff-newly-engaging paths, without
// caring which of the two methods a given call site happens to use.
async function withCapturedLogs(fn: () => Promise<void>): Promise<string[]> {
  const logMessages: string[] = [];
  const originalLog = console.log.bind(console);
  const originalInfo = console.info.bind(console);
  const capture = (...args: unknown[]) => {
    logMessages.push(args.map(String).join(" "));
  };
  console.log = capture;
  console.info = capture;
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
  }
  return logMessages;
}

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
      workQueueReporter: makeRecordingWorkQueueReporter().reporter,
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
      workQueueReporter: makeRecordingWorkQueueReporter().reporter,
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
      workQueueReporter: makeRecordingWorkQueueReporter().reporter,
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

  test("LPF-7.1: the busy-flag no-op warns a distinguishable message including elapsed busy time before returning", async () => {
    // First tick's qualification hangs until we release it, so the second
    // tick fires while the first is still draining and hits the busy guard.
    // A mutable clock lets us advance wall-clock time between busy=true
    // (set at the top of the first tick) and the second tick's busy-skip, so
    // the elapsed-time content in the warn message is genuinely exercised
    // rather than trivially 0ms.
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const { clock, advanceMs } = makeMutableClockForBackoff(
      "2026-01-01T00:00:00Z",
    );

    const deps = {
      ...makeDeps({
        getDevTaskCandidates: async () => {
          await gate;
          return [];
        },
      }),
      clock,
    };
    const loop = createLoopOrchestrator(deps);

    const first = loop(ALL_PHASES_ON);
    advanceMs(5000);
    const warnMessages = await withCapturedWarnings(async () => {
      // Second call while first is still draining — must no-op immediately
      // and warn a distinguishable "busy" message (including elapsed busy
      // time) before returning.
      await loop(ALL_PHASES_ON);
    });

    release();
    await first;

    expect(warnMessages.length).toBeGreaterThan(0);
    const busyLogs = warnMessages.filter(
      (msg) => msg.toLowerCase().includes("busy") || msg.includes("draining"),
    );
    expect(busyLogs.length).toBeGreaterThan(0);
    // Must surface the elapsed time since busySince (5000ms, derived from the
    // injected clock, not a raw Date.now()/new Date() call).
    expect(busyLogs.some((msg) => msg.includes("5000"))).toBe(true);
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

    expectDispatchedCommands(messages, ["/shipwright:dev-task SWC-1.1"]);
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

    // PR dispatches carry a pre-claim marker (CBD-1.3); the default makeDeps
    // claimPr stub echoes the candidate's id+commitSha.
    expectDispatchedCommands(messages, [
      "/shipwright:review acme/x#1 [preclaim:acme/x#1:acme/x#1-sha]",
    ]);
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

    expectDispatchedCommands(messages, [
      "/shipwright:patch acme/x#2 [preclaim:acme/x#2:acme/x#2-sha]",
    ]);
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

    expectDispatchedCommands(messages, [
      "/shipwright:deploy acme/x#3 [preclaim:acme/x#3:acme/x#3-sha]",
    ]);
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

    expectDispatchedCommands(messages, [
      "/shipwright:patch acme/x#5 [preclaim:acme/x#5:acme/x#5-sha]",
      "/shipwright:dev-task SWC-1.1",
      "/shipwright:review acme/x#9 [preclaim:acme/x#9:acme/x#9-sha]",
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

    expectDispatchedCommands(messages, [
      "/shipwright:review acme/x#1 [preclaim:acme/x#1:acme/x#1-sha]",
    ]);
    expect(messages.some((m) => m.includes("/shipwright:review-patch"))).toBe(
      false,
    );
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

    expectDispatchedCommands(messages, [
      "/shipwright:review acme/x#1 [preclaim:acme/x#1:acme/x#1-sha]",
    ]);
  });

  test("reports itemType/itemId for each PR phase dispatch (review/patch/deploy)", async () => {
    const consumed = new Set<string>();
    const { reporter, creates, completes } = makeRecordingReporter();
    const reviewCandidates = [pr("acme/x#9", "2026-01-03T00:00:00Z", "review")];
    const patchCandidates = [pr("acme/x#5", "2026-01-01T00:00:00Z", "patch")];
    const deployCandidates = [pr("acme/x#3", "2026-01-02T00:00:00Z", "deploy")];
    const { runner } = makeDrainingRunner(
      {
        review: reviewCandidates,
        patch: patchCandidates,
        deploy: deployCandidates,
      },
      consumed,
    );
    const deps = makeDeps({
      reviewCandidates,
      patchCandidates,
      deployCandidates,
      runner,
      reporter,
      consumed,
    });
    const loop = createLoopOrchestrator(deps);

    await loop(ALL_PHASES_ON);

    // Oldest-first drain order: patch (01-01), deploy (01-02), review (01-03).
    expect(
      creates.map((c) => ({ itemType: c.itemType, itemId: c.itemId })),
    ).toEqual([
      { itemType: "pr", itemId: "acme/x#5" },
      { itemType: "pr", itemId: "acme/x#3" },
      { itemType: "pr", itemId: "acme/x#9" },
    ]);
    expect(
      completes.map((c) => ({ itemType: c.itemType, itemId: c.itemId })),
    ).toEqual([
      { itemType: "pr", itemId: "acme/x#5" },
      { itemType: "pr", itemId: "acme/x#3" },
      { itemType: "pr", itemId: "acme/x#9" },
    ]);
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
    expect(creates.map((c) => c.phaseId)).toEqual([
      "shipwright-deploy",
      "shipwright-dev-task",
    ]);
    expect(completes.map((c) => c.phaseId)).toEqual([
      "shipwright-deploy",
      "shipwright-dev-task",
    ]);
    expect(completes.every((c) => c.outcome === "completed")).toBe(true);
    expect(creates.every((c) => c.cronId === "shipwright-loop")).toBe(true);
    expect(skips).toEqual([]);

    // The winning item's type/id is threaded through create AND complete for
    // both the PR-type and task-type dispatches.
    expect(creates.map((c) => c.itemType)).toEqual(["pr", "task"]);
    expect(creates.map((c) => c.itemId)).toEqual(["acme/x#3", "SWC-1.1"]);
    expect(completes.map((c) => c.itemType)).toEqual(["pr", "task"]);
    expect(completes.map((c) => c.itemId)).toEqual(["acme/x#3", "SWC-1.1"]);
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

  // ─── Work queue reporter tests (AWQ-1.3) ────────────────────────────────────

  test("workQueueReporter.reportSnapshot is called exactly once on an idle tick, with an empty items array — no dispatch occurs", async () => {
    const { reporter: workQueueReporter, snapshots } =
      makeRecordingWorkQueueReporter();
    const deps = makeDeps({ workQueueReporter });
    const loop = createLoopOrchestrator(deps);

    await loop(ALL_PHASES_ON);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].items).toEqual([]);
  });

  test("workQueueReporter.reportSnapshot is called exactly once per tick with the full ranked candidate list for a single dispatching tick", async () => {
    const consumed = new Set<string>();
    const { reporter: workQueueReporter, snapshots } =
      makeRecordingWorkQueueReporter();
    const devTaskCandidates = [task("SWC-1.1", "2026-01-01T00:00:00Z")];
    const { runner } = makeDrainingRunner(
      { devTask: devTaskCandidates },
      consumed,
    );
    const deps = makeDeps({
      devTaskCandidates,
      runner,
      consumed,
      workQueueReporter,
    });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-dev-task", true)]);

    // One dispatching iteration (consumes the only candidate) + one final idle
    // iteration that ends the drain = 2 reportSnapshot calls total.
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].items).toEqual(rankWorkItems(devTaskCandidates, []));
    expect(snapshots[1].items).toEqual([]);
  });

  test("workQueueReporter.reportSnapshot is called once per while-loop iteration across a multi-item drain, with decreasing candidate lists each time", async () => {
    const consumed = new Set<string>();
    const { reporter: workQueueReporter, snapshots } =
      makeRecordingWorkQueueReporter();
    const devTaskCandidates = [task("SWC-1.1", "2026-01-02T00:00:00Z")];
    const reviewCandidates = [pr("acme/x#9", "2026-01-01T00:00:00Z", "review")];
    const { runner } = makeDrainingRunner(
      { devTask: devTaskCandidates, review: reviewCandidates },
      consumed,
    );
    const deps = makeDeps({
      devTaskCandidates,
      reviewCandidates,
      runner,
      consumed,
      workQueueReporter,
    });
    const loop = createLoopOrchestrator(deps);

    await loop(ALL_PHASES_ON);

    // 2 candidates drain over 2 dispatching iterations + 1 final idle
    // iteration = 3 reportSnapshot calls total, decreasing each time.
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0].items).toHaveLength(2);
    expect(snapshots[0].items).toEqual(
      rankWorkItems(devTaskCandidates, reviewCandidates),
    );
    expect(snapshots[1].items).toHaveLength(1);
    expect(snapshots[2].items).toEqual([]);
  });

  test("reportSnapshot receives computedAt from the injected clock", async () => {
    const { reporter: workQueueReporter, snapshots } =
      makeRecordingWorkQueueReporter();
    const deps = makeDeps({ workQueueReporter });
    const loop = createLoopOrchestrator(deps);

    await loop(ALL_PHASES_ON);

    expect(snapshots[0].computedAt).toBe("2026-07-10T00:00:00.000Z");
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

    expect(creates.map((c) => c.phaseId)).toEqual(["shipwright-dev-task"]);
    expect(completes).toEqual([]);
    expect(skips.map((s) => s.phaseId)).toEqual(["shipwright-dev-task"]);

    // The skipped run still records which task-type item was dispatched.
    expect(
      creates.map((c) => ({ itemType: c.itemType, itemId: c.itemId })),
    ).toEqual([{ itemType: "task", itemId: "SWC-1.1" }]);
    expect(
      skips.map((s) => ({ itemType: s.itemType, itemId: s.itemId })),
    ).toEqual([{ itemType: "task", itemId: "SWC-1.1" }]);
  });

  // ─── Skip/reset tracking tests (SKT-2.1) ────────────────────────────────────

  test("a [silent]-marker dispatch for a task item calls recordSkip('task', <task-id>) after skipRun", async () => {
    const consumed = new Set<string>();
    const { reporter, skips } = makeRecordingReporter();
    const { recordSkip, resetSkip, recordCalls, resetCalls } =
      makeRecordingSkipTracker();
    const devTaskCandidates = [task("SWC-1.1", "2026-01-01T00:00:00Z")];
    const { runner } = makeDrainingRunner(
      { devTask: devTaskCandidates },
      consumed,
      [{ result: "Nothing to do here.\n[silent]" }],
    );
    const deps = makeDeps({
      devTaskCandidates,
      runner,
      reporter,
      consumed,
      recordSkip,
      resetSkip,
    });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-dev-task", true)]);

    // skipRun was called (proves ordering context) before recordSkip fires.
    expect(skips).toHaveLength(1);
    expect(recordCalls).toEqual([{ itemType: "task", recordId: "SWC-1.1" }]);
    expect(resetCalls).toEqual([]);
  });

  test("a [silent]-marker dispatch for a PR item calls recordSkip('pr', <record-id>) — NOT the display id", async () => {
    const consumed = new Set<string>();
    const { reporter, skips } = makeRecordingReporter();
    const { recordSkip, resetSkip, recordCalls, resetCalls } =
      makeRecordingSkipTracker();
    const reviewCandidates = [pr("acme/x#9", "2026-01-01T00:00:00Z", "review")];
    const { runner } = makeDrainingRunner(
      { review: reviewCandidates },
      consumed,
      [{ result: "Nothing to do here.\n[silent]" }],
    );
    const deps = makeDeps({
      reviewCandidates,
      runner,
      reporter,
      consumed,
      recordSkip,
      resetSkip,
      // The claimed record's id (a CUID) differs from the candidate's
      // human-readable display id ("acme/x#9") — recordSkip must receive the
      // CUID, never the display id.
      claimPr: async (candidate: WorkPrCandidate) => ({
        id: "pr-record-cuid-xyz",
        commitSha: candidate.commitSha,
      }),
    });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-review", true)]);

    expect(skips).toHaveLength(1);
    expect(recordCalls).toEqual([
      { itemType: "pr", recordId: "pr-record-cuid-xyz" },
    ]);
    expect(resetCalls).toEqual([]);
  });

  test("a normal completed task dispatch calls resetSkip('task', <task-id>), not recordSkip", async () => {
    const consumed = new Set<string>();
    const { reporter, completes } = makeRecordingReporter();
    const { recordSkip, resetSkip, recordCalls, resetCalls } =
      makeRecordingSkipTracker();
    const devTaskCandidates = [task("SWC-1.1", "2026-01-01T00:00:00Z")];
    const { runner } = makeDrainingRunner(
      { devTask: devTaskCandidates },
      consumed,
    );
    const deps = makeDeps({
      devTaskCandidates,
      runner,
      reporter,
      consumed,
      recordSkip,
      resetSkip,
    });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-dev-task", true)]);

    expect(completes).toHaveLength(1);
    expect(resetCalls).toEqual([{ itemType: "task", recordId: "SWC-1.1" }]);
    expect(recordCalls).toEqual([]);
  });

  test("a normal completed PR dispatch calls resetSkip('pr', <record-id>), not recordSkip — record id, not display id", async () => {
    const consumed = new Set<string>();
    const { reporter, completes } = makeRecordingReporter();
    const { recordSkip, resetSkip, recordCalls, resetCalls } =
      makeRecordingSkipTracker();
    const patchCandidates = [pr("acme/x#5", "2026-01-01T00:00:00Z", "patch")];
    const { runner } = makeDrainingRunner({ patch: patchCandidates }, consumed);
    const deps = makeDeps({
      patchCandidates,
      runner,
      reporter,
      consumed,
      recordSkip,
      resetSkip,
      claimPr: async (candidate: WorkPrCandidate) => ({
        id: "pr-record-cuid-abc",
        commitSha: candidate.commitSha,
      }),
    });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-patch", true)]);

    expect(completes).toHaveLength(1);
    expect(resetCalls).toEqual([
      { itemType: "pr", recordId: "pr-record-cuid-abc" },
    ]);
    expect(recordCalls).toEqual([]);
  });

  test("recordSkip/resetSkip errors don't propagate or abort the tick — the drain still proceeds", async () => {
    const consumed = new Set<string>();
    const { reporter } = makeRecordingReporter();
    const { recordSkip, resetSkip, recordCalls } = makeRecordingSkipTracker({
      recordSkip: async () => {
        throw new Error("task-store 500");
      },
    });
    // Two dev-task candidates: the older one dispatches [silent] (triggers
    // the rejecting recordSkip), the younger one must still drain normally
    // afterward — proving a recordSkip rejection doesn't abort the tick.
    const devTaskCandidates = [
      task("SWC-OLD", "2026-01-01T00:00:00Z"),
      task("SWC-NEW", "2026-01-02T00:00:00Z"),
    ];
    const { runner, messages } = makeDrainingRunner(
      { devTask: devTaskCandidates },
      consumed,
      [{ result: "Nothing to do here.\n[silent]" }, { result: "done" }],
    );
    const deps = makeDeps({
      devTaskCandidates,
      runner,
      reporter,
      consumed,
      recordSkip,
      resetSkip,
    });
    const loop = createLoopOrchestrator(deps);

    await expect(
      loop([job("shipwright-dev-task", true)]),
    ).resolves.toBeUndefined();

    expect(recordCalls).toEqual([{ itemType: "task", recordId: "SWC-OLD" }]);
    expectDispatchedCommands(messages, [
      "/shipwright:dev-task SWC-OLD",
      "/shipwright:dev-task SWC-NEW",
    ]);
  });

  test("skipRun on the [silent] path is called with buildTokenPayload(usage, modelUsage) instead of undefined", async () => {
    const consumed = new Set<string>();
    const { reporter, skips } = makeRecordingReporter();
    const devTaskCandidates = [task("SWC-1.1", "2026-01-01T00:00:00Z")];
    const { runner } = makeDrainingRunner(
      { devTask: devTaskCandidates },
      consumed,
      [
        {
          result: "Nothing to do here.\n[silent]",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10,
          },
          modelUsage: {
            "claude-sonnet-4-5": {
              inputTokens: 100,
              outputTokens: 50,
              cacheReadInputTokens: 20,
              cacheCreationInputTokens: 10,
              costUSD: 0.01,
              webSearchRequests: 0,
              contextWindow: 200000,
            },
          },
        },
      ],
    );
    const deps = makeDeps({ devTaskCandidates, runner, reporter, consumed });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-dev-task", true)]);

    expect(skips).toHaveLength(1);
    expect(skips[0].opts).toBeDefined();
    expect(skips[0].opts?.inputTokens).toBe(100);
    expect(skips[0].opts?.outputTokens).toBe(50);
    expect(skips[0].opts?.cacheReadTokens).toBe(20);
    expect(skips[0].opts?.cacheCreationTokens).toBe(10);
    expect(skips[0].opts?.modelBreakdown).toEqual([
      {
        model: "claude-sonnet-4-5",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheCreationTokens: 10,
        costUsd: 0.01,
      },
    ]);
  });

  test("a runner throw during dispatch reports a failed run, is isolated per-item, and still releases the busy flag", async () => {
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
      claimTask: consumingClaimTask(consumed),
    });
    const loop = createLoopOrchestrator(deps);

    // CBD-2.3: a thrown dispatch is now caught and isolated per-item — the
    // tick resolves normally (the drain loop continues/completes) instead of
    // the throw propagating out of the whole tick.
    await loop([job("shipwright-dev-task", true)]);

    // The run was created and then completed with outcome "failed" — never
    // silently dropped.
    expect(creates.map((c) => c.phaseId)).toEqual(["shipwright-dev-task"]);
    expect(completes).toEqual([
      {
        cronId: "shipwright-loop",
        runId: "run-1",
        outcome: "failed",
        phaseId: "shipwright-dev-task",
        itemType: "task",
        itemId: "SWC-1.1",
      },
    ]);
    expect(skips).toEqual([]);

    // The SAME closure's busy flag is released — a subsequent tick on it is
    // not blocked (all phases disabled here, so it just no-ops on candidates).
    await loop([job("shipwright-dev-task", false)]);
    expect(creates.map((c) => c.phaseId)).toEqual(["shipwright-dev-task"]);
  });

  test("a streamIncomplete:true result during dispatch reports a failed run and is isolated per-item (CSU-1.1 regression)", async () => {
    const consumed = new Set<string>();
    const { reporter, creates, completes, skips } = makeRecordingReporter();
    const devTaskCandidates = [task("SWC-1.1", "2026-01-01T00:00:00Z")];
    const runner = async (): Promise<ClaudeRunResult> => ({
      result: "",
      streamIncomplete: true,
    });
    const deps = makeDeps({
      devTaskCandidates,
      runner,
      reporter,
      consumed,
      claimTask: consumingClaimTask(consumed),
    });
    const loop = createLoopOrchestrator(deps);

    // CBD-2.3: dispatch()'s throw (streamIncomplete surfaces as a thrown
    // error inside dispatch()) is now caught and isolated per-item — the
    // tick resolves normally instead of the throw propagating out of it.
    await loop([job("shipwright-dev-task", true)]);

    // A clean-exit-but-truncated stream must NOT be recorded as a completed
    // dispatch — it should surface as a failed run, same as a thrown error.
    expect(creates.map((c) => c.phaseId)).toEqual(["shipwright-dev-task"]);
    expect(completes).toEqual([
      {
        cronId: "shipwright-loop",
        runId: "run-1",
        outcome: "failed",
        phaseId: "shipwright-dev-task",
        itemType: "task",
        itemId: "SWC-1.1",
      },
    ]);
    expect(skips).toEqual([]);
  });

  test("releases the busy flag even when a dispatch throws", async () => {
    // CBD-2.3: a thrown dispatch is caught and isolated per-item — the tick
    // that hits it resolves normally rather than rejecting. This test's
    // purpose is narrowed to confirm the busy flag still comes back false
    // afterward (it always did, via the finally block), now via the
    // isolate-and-continue path rather than a propagated rejection.
    //
    // `consumed` models "no longer qualifies" — claimTask adds the id on a
    // successful claim, since in production a claimed task stops appearing
    // in the next getDevTaskCandidates() ready-query even though the
    // subsequent dispatch() call went on to throw.
    const consumed = new Set<string>();
    let firstCall = true;
    const deps = makeDeps({
      devTaskCandidates: [task("SWC-1.1", "2026-01-01T00:00:00Z")],
      consumed,
      claimTask: consumingClaimTask(consumed),
      runner: async () => {
        if (firstCall) {
          firstCall = false;
          throw new Error("boom");
        }
        return { result: "done" };
      },
    });
    const loop = createLoopOrchestrator(deps);

    // First tick hits the throwing dispatch mid-drain but resolves normally.
    await loop([job("shipwright-dev-task", true)]);
    expect(firstCall).toBe(false);

    // A subsequent tick must NOT be blocked by a stuck busy flag.
    await loop([job("shipwright-dev-task", true)]);
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

  test("tags dispatched messages with [Cron job: <loopCronId>] Current time: ... so they're excluded from session-merging", async () => {
    const consumed = new Set<string>();
    const devTaskCandidates = [task("T-123", "2026-01-01T00:00:00Z")];
    const { runner, messages } = makeDrainingRunner(
      { devTask: devTaskCandidates },
      consumed,
    );
    const deps = makeDeps({
      devTaskCandidates,
      runner,
      consumed,
      loopCronId: "shipwright-loop",
    });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-dev-task", true)]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toStartWith(
      "[Cron job: shipwright-loop] Current time:",
    );
    expect(messages[0]).toContain("/shipwright:dev-task T-123");
  });

  // ─── Spin detection tests ───────────────────────────────────────────────────────

  test("spin detection: console.warn fires on 3rd consecutive dispatch of same itemId", async () => {
    // Sequence: return T-SPIN three times, then nothing (to end drain)
    let callCount = 0;
    const deps = makeDeps({
      getDevTaskCandidates: async () => {
        callCount += 1;
        if (callCount <= 3) {
          return [task("T-SPIN", "2026-01-01T00:00:00Z")];
        }
        return [];
      },
    });
    const loop = createLoopOrchestrator(deps);

    const warnMessages = await withCapturedWarnings(async () => {
      await loop([job("shipwright-dev-task", true)]);
    });

    // Should have at least one spin detection warning
    const spinWarnings = warnMessages.filter(
      (msg) => msg.includes("repeated dispatch") || msg.includes("spin"),
    );
    expect(spinWarnings.length).toBeGreaterThan(0);
    // Verify it mentions the item id
    expect(spinWarnings[0]).toContain("T-SPIN");
  });

  test("spin detection: no warn on 1st or 2nd consecutive dispatch of same itemId", async () => {
    // Sequence: return T-SPIN-2 only twice, then nothing
    let callCount = 0;
    const deps = makeDeps({
      getDevTaskCandidates: async () => {
        callCount += 1;
        if (callCount <= 2) {
          return [task("T-SPIN-2", "2026-01-01T00:00:00Z")];
        }
        return [];
      },
    });
    const loop = createLoopOrchestrator(deps);

    const warnMessages = await withCapturedWarnings(async () => {
      await loop([job("shipwright-dev-task", true)]);
    });

    // Should have no spin detection warning (only 2 dispatches, threshold is 3)
    const spinWarnings = warnMessages.filter(
      (msg) => msg.includes("repeated dispatch") || msg.includes("spin"),
    );
    expect(spinWarnings).toHaveLength(0);
  });

  test("spin detection: counter resets when different itemId dispatched", async () => {
    // Sequence: T-A, T-A, T-B, T-A, T-A, nothing (stops drain)
    // After reset at T-B, we only have 2 more T-A's, so no spin warning
    let callCount = 0;
    const deps = makeDeps({
      getDevTaskCandidates: async () => {
        callCount += 1;
        if (callCount === 1 || callCount === 2) {
          return [task("T-A", "2026-01-01T00:00:00Z")];
        }
        if (callCount === 3) {
          return [task("T-B", "2026-01-02T00:00:00Z")];
        }
        if (callCount === 4 || callCount === 5) {
          return [task("T-A", "2026-01-01T00:00:00Z")];
        }
        return [];
      },
    });
    const loop = createLoopOrchestrator(deps);

    const warnMessages = await withCapturedWarnings(async () => {
      await loop([job("shipwright-dev-task", true)]);
    });

    // Pattern: T-A (1), T-A (2), T-B (reset to 1), T-A (1), T-A (2), end
    // No warning should fire (never reach 3 consecutively after reset)
    const spinWarnings = warnMessages.filter(
      (msg) => msg.includes("repeated dispatch") || msg.includes("spin"),
    );
    expect(spinWarnings).toHaveLength(0);
  });

  // ─── Empty-queue backoff tests (SKT-2.2) ────────────────────────────────────

  /** A Clock whose now() can be advanced between calls, for backoff tests. */
  function makeMutableClockForBackoff(initialIso: string): {
    clock: import("./clock.ts").Clock;
    advanceMs: (ms: number) => void;
  } {
    let current = new Date(initialIso);
    return {
      clock: { now: () => current },
      advanceMs: (ms: number) => {
        current = new Date(current.getTime() + ms);
      },
    };
  }

  /**
   * Sets the given env vars for the duration of `fn`, restoring each to its
   * prior value (or deleting it, if previously unset) afterward — even if
   * `fn` throws.
   */
  async function withEnvOverrides(
    overrides: Record<string, string>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const originals = Object.fromEntries(
      Object.keys(overrides).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, overrides);
    try {
      await fn();
    } finally {
      for (const [name, original] of Object.entries(originals)) {
        if (original === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = original;
        }
      }
    }
  }

  test("after SHIPWRIGHT_LOOP_EMPTY_BACKOFF_ATTEMPTS consecutive empty ticks, a subsequent tick within the backoff window performs zero candidate-collection calls", async () => {
    await withEnvOverrides(
      {
        SHIPWRIGHT_LOOP_EMPTY_BACKOFF_ATTEMPTS: "3",
        SHIPWRIGHT_LOOP_EMPTY_BACKOFF_MS: "300000",
      },
      async () => {
        const { clock } = makeMutableClockForBackoff("2026-01-01T00:00:00Z");
        const calls: string[] = [];
        const deps = { ...makeDeps({ calls }), clock };
        const loop = createLoopOrchestrator(deps);

        // 3 consecutive empty ticks — each collects candidates (empty pools).
        await loop(ALL_PHASES_ON);
        await loop(ALL_PHASES_ON);
        await loop(ALL_PHASES_ON);
        expect(calls.length).toBeGreaterThan(0);

        // Backoff should now be active — a 4th tick within the window must
        // perform zero candidate-collection calls.
        calls.length = 0;
        await loop(ALL_PHASES_ON);
        expect(calls).toHaveLength(0);
      },
    );
  });

  test("LTO-1.1: each genuinely-empty tick logs a distinguishable message including the consecutiveEmptyTicks count", async () => {
    await withEnvOverrides(
      {
        SHIPWRIGHT_LOOP_EMPTY_BACKOFF_ATTEMPTS: "3",
        SHIPWRIGHT_LOOP_EMPTY_BACKOFF_MS: "300000",
      },
      async () => {
        const { clock } = makeMutableClockForBackoff("2026-01-01T00:00:00Z");
        const deps = { ...makeDeps({}), clock };
        const loop = createLoopOrchestrator(deps);

        const logMessages = await withCapturedLogs(async () => {
          await loop(ALL_PHASES_ON);
        });

        const emptyLogs = logMessages.filter((msg) =>
          msg.toLowerCase().includes("empty"),
        );
        expect(emptyLogs.length).toBeGreaterThan(0);
        // Must surface the resulting consecutiveEmptyTicks count (1 after
        // the first genuinely-empty tick).
        expect(emptyLogs.some((msg) => msg.includes("1"))).toBe(true);
      },
    );
  });

  test("LTO-1.1: the backoff-active skip logs a distinguishable message including remaining time or the backoffUntil timestamp", async () => {
    await withEnvOverrides(
      {
        SHIPWRIGHT_LOOP_EMPTY_BACKOFF_ATTEMPTS: "3",
        SHIPWRIGHT_LOOP_EMPTY_BACKOFF_MS: "300000",
      },
      async () => {
        const { clock } = makeMutableClockForBackoff("2026-01-01T00:00:00Z");
        const deps = { ...makeDeps({}), clock };
        const loop = createLoopOrchestrator(deps);

        // 3 consecutive empty ticks arm backoff.
        await loop(ALL_PHASES_ON);
        await loop(ALL_PHASES_ON);
        await loop(ALL_PHASES_ON);

        // A 4th tick within the backoff window must log a distinguishable
        // "backoff active" message before returning, distinct from the
        // busy-flag and genuinely-empty messages.
        const logMessages = await withCapturedLogs(async () => {
          await loop(ALL_PHASES_ON);
        });

        expect(logMessages.length).toBeGreaterThan(0);
        const backoffLogs = logMessages.filter((msg) =>
          msg.toLowerCase().includes("backoff"),
        );
        expect(backoffLogs.length).toBeGreaterThan(0);
        // Must not be confusable with the busy-flag message.
        expect(
          backoffLogs.some((msg) => msg.toLowerCase().includes("busy")),
        ).toBe(false);
        // LPF-7.1: must include the active backoffUntil timestamp so an
        // operator can tell exactly when the window ends, not just that
        // backoff is active.
        const expectedBackoffUntil = new Date(
          clock.now().getTime() + 300000,
        ).toISOString();
        expect(
          backoffLogs.some((msg) => msg.includes(expectedBackoffUntil)),
        ).toBe(true);
      },
    );
  });

  test("LTO-1.1: backoff newly engaging logs a distinguishable message noting until when, only on the crossing tick", async () => {
    await withEnvOverrides(
      {
        SHIPWRIGHT_LOOP_EMPTY_BACKOFF_ATTEMPTS: "3",
        SHIPWRIGHT_LOOP_EMPTY_BACKOFF_MS: "300000",
      },
      async () => {
        const { clock } = makeMutableClockForBackoff("2026-01-01T00:00:00Z");
        const deps = { ...makeDeps({}), clock };
        const loop = createLoopOrchestrator(deps);

        // First two empty ticks: below threshold, backoff must not engage.
        const earlyLogs = await withCapturedLogs(async () => {
          await loop(ALL_PHASES_ON);
          await loop(ALL_PHASES_ON);
        });
        const earlyEngageLogs = earlyLogs.filter((msg) =>
          msg.toLowerCase().includes("engag"),
        );
        expect(earlyEngageLogs).toHaveLength(0);

        // Third empty tick crosses the threshold — backoff newly engages.
        const crossingLogs = await withCapturedLogs(async () => {
          await loop(ALL_PHASES_ON);
        });
        const engageLogs = crossingLogs.filter((msg) =>
          msg.toLowerCase().includes("engag"),
        );
        expect(engageLogs.length).toBeGreaterThan(0);

        // A subsequent tick inside the backoff window (the backoff-active
        // skip) must NOT repeat the "newly engaging" message — only the
        // crossing tick logs it.
        const subsequentLogs = await withCapturedLogs(async () => {
          await loop(ALL_PHASES_ON);
        });
        const repeatedEngageLogs = subsequentLogs.filter((msg) =>
          msg.toLowerCase().includes("engag"),
        );
        expect(repeatedEngageLogs).toHaveLength(0);
      },
    );
  });

  test("a tick that dispatches at least one item resets the empty-tick counter — a further empty tick alone does not trigger backoff", async () => {
    await withEnvOverrides(
      { SHIPWRIGHT_LOOP_EMPTY_BACKOFF_ATTEMPTS: "3" },
      async () => {
        const { clock } = makeMutableClockForBackoff("2026-01-01T00:00:00Z");
        const consumed = new Set<string>();
        const devTaskCandidates = [task("T-RESET", "2026-01-01T00:00:00Z")];
        const calls: string[] = [];
        const runner = async (
          _message: string,
          _onProgress?: ProgressCallback,
        ): Promise<ClaudeRunResult> => {
          consumed.add("T-RESET");
          return { result: "done" };
        };
        const deps = {
          ...makeDeps({ calls, devTaskCandidates, consumed, runner }),
          clock,
        };
        const loop = createLoopOrchestrator(deps);

        // Two empty ticks (fewer than the threshold of 3).
        await loop([job("shipwright-review", true)]);
        await loop([job("shipwright-review", true)]);

        // A tick with real work — dispatches T-RESET, resets the counter.
        await loop([job("shipwright-dev-task", true)]);

        // A further empty tick must still perform normal candidate collection
        // (i.e. backoff must NOT have triggered) — the counter was reset, not
        // just short of the threshold by coincidence.
        calls.length = 0;
        await loop([job("shipwright-review", true)]);
        expect(calls.length).toBeGreaterThan(0);
      },
    );
  });

  test("advancing the clock past backoffDurationMs resumes normal candidate collection", async () => {
    await withEnvOverrides(
      {
        SHIPWRIGHT_LOOP_EMPTY_BACKOFF_ATTEMPTS: "2",
        SHIPWRIGHT_LOOP_EMPTY_BACKOFF_MS: "60000", // 1 minute
      },
      async () => {
        const { clock, advanceMs } = makeMutableClockForBackoff(
          "2026-01-01T00:00:00Z",
        );
        const calls: string[] = [];
        const deps = { ...makeDeps({ calls }), clock };
        const loop = createLoopOrchestrator(deps);

        // 2 consecutive empty ticks trigger backoff (threshold = 2).
        await loop(ALL_PHASES_ON);
        await loop(ALL_PHASES_ON);

        // A tick within the window performs zero candidate-collection calls.
        calls.length = 0;
        await loop(ALL_PHASES_ON);
        expect(calls).toHaveLength(0);

        // Advance the clock past the backoff duration.
        advanceMs(60_001);

        // A tick after the window has elapsed resumes normal collection.
        calls.length = 0;
        await loop(ALL_PHASES_ON);
        expect(calls.length).toBeGreaterThan(0);
      },
    );
  });

  test("a tick where candidates exist but every claim loses to a sibling replica (409) does not count as an empty tick", async () => {
    // Models a busy, contended queue: real candidates are collected every
    // tick, but claimTask always 409s (returns false) — nothing ever
    // dispatches. Without tracking candidate presence separately from
    // dispatch success, 3 such ticks at threshold=3 would misfire the
    // empty-queue backoff even though the queue was never actually empty.
    await withEnvOverrides(
      { SHIPWRIGHT_LOOP_EMPTY_BACKOFF_ATTEMPTS: "3" },
      async () => {
        const { clock } = makeMutableClockForBackoff("2026-01-01T00:00:00Z");
        const calls: string[] = [];

        // getDevTaskCandidates() alternates: odd calls (the drain loop's
        // first iteration each tick) return one contended candidate; even
        // calls (the drain loop's second iteration, after the 409) return
        // an empty list — modeling "claimed by a sibling replica and gone
        // from the next ready-query", same finite-loop convention as the
        // existing 409 test above. Each tick makes exactly 2 calls, so the
        // parity stays aligned across tick boundaries.
        let devTaskCalls = 0;
        const getDevTaskCandidates = async () => {
          calls.push("devTask");
          devTaskCalls += 1;
          return devTaskCalls % 2 === 1
            ? [task("SWC-CONTENDED", "2026-01-01T00:00:00Z")]
            : [];
        };

        const deps = {
          ...makeDeps({
            calls,
            getDevTaskCandidates,
            claimTask: async () => false,
          }),
          clock,
        };
        const loop = createLoopOrchestrator(deps);

        // 3 consecutive contended ticks — each sees a real candidate (409s
        // on claim, nothing dispatched).
        await loop([job("shipwright-dev-task", true)]);
        await loop([job("shipwright-dev-task", true)]);
        await loop([job("shipwright-dev-task", true)]);

        // A 4th tick must still perform normal candidate collection —
        // backoff must NOT have armed, since none of the 3 prior ticks
        // actually collected zero candidates.
        calls.length = 0;
        await loop([job("shipwright-dev-task", true)]);
        expect(calls.length).toBeGreaterThan(0);
      },
    );
  });

  test("a tick where candidates exist but every claim throws (e.g. task-store 5xx) does not count as an empty tick", async () => {
    // Same scenario as the 409 case above, but via the throw path (CBD-2.1)
    // instead of a false return — the drain loop's per-tick
    // failedPreClaimTaskIds filter is what keeps this finite instead of the
    // candidate-list alternation used for the 409 variant.
    await withEnvOverrides(
      { SHIPWRIGHT_LOOP_EMPTY_BACKOFF_ATTEMPTS: "3" },
      async () => {
        const { clock } = makeMutableClockForBackoff("2026-01-01T00:00:00Z");
        const calls: string[] = [];
        const devTaskCandidates = [
          task("SWC-BOOM", "2026-01-01T00:00:00Z"),
        ];

        const deps = {
          ...makeDeps({
            calls,
            devTaskCandidates,
            claimTask: async () => {
              throw new Error("task-store 500");
            },
          }),
          clock,
        };
        const loop = createLoopOrchestrator(deps);

        await loop([job("shipwright-dev-task", true)]);
        await loop([job("shipwright-dev-task", true)]);
        await loop([job("shipwright-dev-task", true)]);

        calls.length = 0;
        await loop([job("shipwright-dev-task", true)]);
        expect(calls.length).toBeGreaterThan(0);
      },
    );
  });

  // ─── Unreconciled-agent warn tests (LPC-2.1 follow-up) ──────────────────────

  test("unreconciled-agent warn fires when shipwright-loop is present but no child phase rows exist", async () => {
    const deps = makeDeps();
    const loop = createLoopOrchestrator(deps);

    // shipwright-loop itself has no parentCronId, and there are no other rows
    // at all — the "never reconciled" case.
    const loopOnly: CronJobLike = {
      id: "shipwright-loop",
      name: "shipwright-loop",
      enabled: true,
      parentCronId: null,
    };

    const warnMessages = await withCapturedWarnings(async () => {
      await loop([loopOnly]);
    });

    const unreconciledWarnings = warnMessages.filter((msg) =>
      msg.includes("no child phase rows"),
    );
    expect(unreconciledWarnings).toHaveLength(1);
    expect(unreconciledWarnings[0]).toContain("shipwright-loop");
  });

  test("unreconciled-agent warn does not fire on a normal idle tick with reconciled child rows all disabled", async () => {
    const deps = makeDeps();
    const loop = createLoopOrchestrator(deps);

    const warnMessages = await withCapturedWarnings(async () => {
      await loop([
        job("shipwright-dev-task", false),
        job("shipwright-review", false),
        job("shipwright-patch", false),
        job("shipwright-deploy", false),
      ]);
    });

    const unreconciledWarnings = warnMessages.filter((msg) =>
      msg.includes("no child phase rows"),
    );
    expect(unreconciledWarnings).toHaveLength(0);
  });

  test("unreconciled-agent warn does not fire when at least one phase is legitimately enabled", async () => {
    const consumed = new Set<string>();
    const deps = makeDeps({
      devTaskCandidates: [],
      consumed,
    });
    const loop = createLoopOrchestrator(deps);

    const warnMessages = await withCapturedWarnings(async () => {
      await loop(ALL_PHASES_ON);
    });

    const unreconciledWarnings = warnMessages.filter((msg) =>
      msg.includes("no child phase rows"),
    );
    expect(unreconciledWarnings).toHaveLength(0);
  });

  test("unreconciled-agent warn does not fire when no shipwright-loop row is present at all (unmigrated agent)", async () => {
    const deps = makeDeps();
    const loop = createLoopOrchestrator(deps);

    const warnMessages = await withCapturedWarnings(async () => {
      await loop([]);
    });

    const unreconciledWarnings = warnMessages.filter((msg) =>
      msg.includes("no child phase rows"),
    );
    expect(unreconciledWarnings).toHaveLength(0);
  });

  test("unreconciled-agent warn fires on partial reconciliation — one of four phase names has a same-parent child row, the rest don't", async () => {
    const deps = makeDeps();
    const loop = createLoopOrchestrator(deps);

    // shipwright-loop present; only shipwright-dev-task has been backfilled
    // with parentCronId === loopCronId so far. review/patch/deploy are still
    // top-level (unreconciled) rows, so they're ignored by
    // resolveLoopPhaseToggles and every toggle resolves false — but
    // `jobs.some((job) => job.parentCronId === loopCronId)` is true because
    // of the dev-task row alone. This is exactly the partial-reconciliation
    // gap the warn must catch.
    const loopJob: CronJobLike = {
      id: "shipwright-loop",
      name: "shipwright-loop",
      enabled: true,
      parentCronId: null,
    };
    const partiallyReconciled: CronJobLike[] = [
      loopJob,
      job("shipwright-dev-task", false),
      {
        id: "shipwright-review",
        name: "shipwright-review",
        enabled: true,
        parentCronId: null,
      },
      {
        id: "shipwright-patch",
        name: "shipwright-patch",
        enabled: true,
        parentCronId: null,
      },
      {
        id: "shipwright-deploy",
        name: "shipwright-deploy",
        enabled: true,
        parentCronId: null,
      },
    ];

    const warnMessages = await withCapturedWarnings(async () => {
      await loop(partiallyReconciled);
    });

    const unreconciledWarnings = warnMessages.filter((msg) =>
      msg.includes("no child phase rows"),
    );
    expect(unreconciledWarnings).toHaveLength(1);
    expect(unreconciledWarnings[0]).toContain("shipwright-loop");
  });

  // ─── Pre-claim tests (CBD-1.2) ──────────────────────────────────────────────

  test("a successful pre-claim (claimTask resolves true) proceeds to dispatch as before", async () => {
    const consumed = new Set<string>();
    const devTaskCandidates = [task("SWC-1.1", "2026-01-01T00:00:00Z")];
    const { runner, messages } = makeDrainingRunner(
      { devTask: devTaskCandidates },
      consumed,
    );
    const claimedIds: string[] = [];
    const deps = makeDeps({
      devTaskCandidates,
      runner,
      consumed,
      claimTask: async (taskId: string) => {
        claimedIds.push(taskId);
        return true;
      },
    });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-dev-task", true)]);

    expect(claimedIds).toEqual(["SWC-1.1"]);
    expectDispatchedCommands(messages, ["/shipwright:dev-task SWC-1.1"]);
  });

  test("a 409 pre-claim conflict skips dispatch entirely — no runner call, no cron-run row", async () => {
    const { reporter, creates, completes, skips } = makeRecordingReporter();
    const { runner, messages } = makeRunner();
    const devTaskCandidates = [task("SWC-1.1", "2026-01-01T00:00:00Z")];
    // The candidate never gets consumed since we never dispatch — so without
    // some other termination condition the loop would spin forever. To keep
    // the test finite, the qualification stub returns the candidate exactly
    // once, then an empty list — modeling "the task got claimed by another
    // agent in production and no longer appears in the next collection pass".
    let calls = 0;
    const deps = makeDeps({
      getDevTaskCandidates: async () => {
        calls += 1;
        return calls === 1 ? devTaskCandidates : [];
      },
      runner,
      reporter,
      claimTask: async () => false,
    });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-dev-task", true)]);

    expect(messages).toEqual([]);
    expect(creates).toEqual([]);
    expect(completes).toEqual([]);
    expect(skips).toEqual([]);
  });

  test("the drain loop continues past a skipped (409) item to the next candidate in the same tick", async () => {
    // Two dev-task candidates: SWC-CONFLICT (older, wins selection first) and
    // SWC-OK (younger). SWC-CONFLICT's claim always 409s, so it must never be
    // dispatched, but the drain must continue on to dispatch SWC-OK in the
    // SAME tick (no new cron tick needed). `consumed` models "no longer
    // qualifies" — the 409 claim itself adds the conflicting id to it, since
    // in production a task claimed by another agent stops appearing in the
    // next getDevTaskCandidates() ready-query.
    const consumed = new Set<string>();
    const { reporter, creates } = makeRecordingReporter();
    const devTaskCandidates = [
      task("SWC-CONFLICT", "2026-01-01T00:00:00Z"),
      task("SWC-OK", "2026-01-02T00:00:00Z"),
    ];
    const { runner, messages } = makeDrainingRunner(
      { devTask: devTaskCandidates },
      consumed,
    );
    let devTaskCalls = 0;
    const deps = makeDeps({
      getDevTaskCandidates: async () => {
        devTaskCalls += 1;
        return devTaskCandidates.filter((c) => !consumed.has(c.id));
      },
      runner,
      consumed,
      reporter,
      claimTask: async (taskId: string) => {
        if (taskId === "SWC-CONFLICT") {
          consumed.add(taskId);
          return false;
        }
        return true;
      },
    });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-dev-task", true)]);

    expect(devTaskCalls).toBeGreaterThan(1);
    expectDispatchedCommands(messages, ["/shipwright:dev-task SWC-OK"]);
    expect(creates.map((c) => c.itemId)).toEqual(["SWC-OK"]);
  });

  // ─── Pre-claim throw isolation (CBD-2.1) ───────────────────────────────────

  test("a thrown pre-claim (e.g. task-store 5xx) is caught per-item, skips only the offending task, and the drain still dispatches a younger candidate of a different type/phase in the same tick", async () => {
    // SWC-BOOM (older dev-task) always throws on claimTask — unlike a 409,
    // the throw means the claim never actually succeeded, so the task-store
    // record stays pending and would keep reappearing from
    // getDevTaskCandidates() forever without the fix's per-tick filter.
    // acme/x#7 (younger PR review candidate — a different item type AND
    // phase) must still dispatch in the same tick.
    const consumed = new Set<string>();
    const { reporter, creates, completes, skips } = makeRecordingReporter();
    const devTaskCandidates = [task("SWC-BOOM", "2026-01-01T00:00:00Z")];
    const reviewCandidates = [pr("acme/x#7", "2026-01-02T00:00:00Z", "review")];
    const { runner, messages } = makeDrainingRunner(
      { devTask: devTaskCandidates, review: reviewCandidates },
      consumed,
    );
    const deps = makeDeps({
      devTaskCandidates,
      reviewCandidates,
      runner,
      consumed,
      reporter,
      claimTask: async () => {
        throw new Error("task-store POST /tasks/SWC-BOOM/claim → 500");
      },
    });
    const loop = createLoopOrchestrator(deps);

    const warnings = await withCapturedWarnings(async () => {
      await loop(ALL_PHASES_ON);
    });

    // The whole tick did NOT abort — the PR candidate still dispatched
    // (with its pre-claim marker, per the default claimPr stub).
    expectDispatchedCommands(messages, [
      "/shipwright:review acme/x#7 [preclaim:acme/x#7:acme/x#7-sha]",
    ]);
    expect(creates.map((c) => c.itemId)).toEqual(["acme/x#7"]);
    expect(completes.map((c) => c.itemId)).toEqual(["acme/x#7"]);
    expect(skips).toEqual([]);

    // The failure is logged, observable, and identifies the offending item.
    expect(
      warnings.some((w) => w.includes("SWC-BOOM") && w.includes("500")),
    ).toBe(true);
  });

  test("repeated claimTask throws for the same item do not spin-loop it within one tick", async () => {
    // Only one candidate exists and its claim always throws. Without the
    // per-tick failedPreClaimTaskIds filter, the drain would re-select and
    // re-throw on it forever (getDevTaskCandidates keeps returning it since
    // it was never actually claimed) — this test bounds that: the loop must
    // terminate after exactly one claim attempt.
    const devTaskCandidates = [task("SWC-BOOM", "2026-01-01T00:00:00Z")];
    let claimAttempts = 0;
    let getCandidatesCalls = 0;
    const deps = makeDeps({
      getDevTaskCandidates: async () => {
        getCandidatesCalls += 1;
        return devTaskCandidates;
      },
      claimTask: async () => {
        claimAttempts += 1;
        throw new Error("task-store POST /tasks/SWC-BOOM/claim → 500");
      },
    });
    const loop = createLoopOrchestrator(deps);

    await withCapturedWarnings(async () => {
      await loop([job("shipwright-dev-task", true)]);
    });

    expect(claimAttempts).toBe(1);
    // Candidates are re-collected once more after the failed claim (to
    // confirm the drain is dry) but the same item is never re-claimed.
    expect(getCandidatesCalls).toBe(2);
  });

  test("a thrown PR pre-claim (e.g. task-store 5xx) is caught per-item, skips only the offending PR, and the drain still dispatches a younger candidate of a different type in the same tick", async () => {
    // acme/x#9 (older review candidate) always throws on claimPr — unlike a
    // 409, the throw means the claim never actually succeeded, so the
    // task-store record stays unclaimed and would keep reappearing from
    // getReviewCandidates() forever without the fix's per-tick filter.
    // SWC-YOUNG (younger dev-task — a different item type) must still
    // dispatch in the same tick.
    const consumed = new Set<string>();
    const { reporter, creates, completes, skips } = makeRecordingReporter();
    const devTaskCandidates = [task("SWC-YOUNG", "2026-01-02T00:00:00Z")];
    const reviewCandidates = [pr("acme/x#9", "2026-01-01T00:00:00Z", "review")];
    const { runner, messages } = makeDrainingRunner(
      { devTask: devTaskCandidates, review: reviewCandidates },
      consumed,
    );
    const deps = makeDeps({
      devTaskCandidates,
      reviewCandidates,
      runner,
      consumed,
      reporter,
      claimPr: async () => {
        throw new Error("task-store POST /prs/claim → 500");
      },
    });
    const loop = createLoopOrchestrator(deps);

    const warnings = await withCapturedWarnings(async () => {
      await loop(ALL_PHASES_ON);
    });

    // The whole tick did NOT abort — the dev-task candidate still dispatched
    // (with claimTask's default stub, which resolves true).
    expectDispatchedCommands(messages, ["/shipwright:dev-task SWC-YOUNG"]);
    expect(creates.map((c) => c.itemId)).toEqual(["SWC-YOUNG"]);
    expect(completes.map((c) => c.itemId)).toEqual(["SWC-YOUNG"]);
    expect(skips).toEqual([]);

    // The failure is logged, observable, and identifies the offending item.
    expect(
      warnings.some((w) => w.includes("acme/x#9") && w.includes("500")),
    ).toBe(true);
  });

  test("repeated claimPr throws for the same item do not spin-loop it within one tick", async () => {
    // Only one PR candidate exists and its claim always throws. Without the
    // per-tick failedPreClaimPrIds filter, the drain would re-select and
    // re-throw on it forever (getReviewCandidates keeps returning it since
    // it was never actually claimed) — this test bounds that: the loop must
    // terminate after exactly one claim attempt.
    const reviewCandidates = [pr("acme/x#9", "2026-01-01T00:00:00Z", "review")];
    let claimAttempts = 0;
    let getCandidatesCalls = 0;
    const deps = makeDeps({
      reviewCandidates: async () => {
        getCandidatesCalls += 1;
        return reviewCandidates;
      },
      claimPr: async () => {
        claimAttempts += 1;
        throw new Error("task-store POST /prs/claim → 500");
      },
    });
    const loop = createLoopOrchestrator(deps);

    await withCapturedWarnings(async () => {
      await loop([job("shipwright-review", true)]);
    });

    expect(claimAttempts).toBe(1);
    // Candidates are re-collected once more after the failed claim (to
    // confirm the drain is dry) but the same item is never re-claimed.
    expect(getCandidatesCalls).toBe(2);
  });

  test("a thrown dispatch (e.g. runner timeout) is caught per-item, skips only the offending item, and the drain still dispatches a younger candidate of a different type/phase in the same tick (CBD-2.3)", async () => {
    // SWC-BOOM (older dev-task) claims successfully but its runner() call
    // always throws — unlike a pre-claim throw (CBD-2.1, isolated at the
    // claimTask/claimPr call sites), this proves the drain loop's dispatch()
    // call site itself isolates a thrown error per-item, not just the
    // pre-claim call sites. acme/x#7 (younger PR review candidate — a
    // different item type AND phase) must still dispatch in the same tick.
    const consumed = new Set<string>();
    const { reporter, creates, completes, skips } = makeRecordingReporter();
    const devTaskCandidates = [task("SWC-BOOM", "2026-01-01T00:00:00Z")];
    const reviewCandidates = [pr("acme/x#7", "2026-01-02T00:00:00Z", "review")];
    const { runner: drainingRunner, messages } = makeDrainingRunner(
      { devTask: devTaskCandidates, review: reviewCandidates },
      consumed,
    );
    // SWC-BOOM's claim succeeds (consumed on claim, matching real claim
    // semantics — see the drain-loop-continues-past-a-409 test above), but
    // dispatching it always throws from the runner. acme/x#7 dispatches
    // normally via the draining runner.
    const runner = async (
      message: string,
      onProgress?: ProgressCallback,
    ): Promise<ClaudeRunResult> => {
      if (message.includes("/shipwright:dev-task SWC-BOOM")) {
        throw new Error("claude run timed out for SWC-BOOM");
      }
      return drainingRunner(message, onProgress);
    };
    const deps = makeDeps({
      devTaskCandidates,
      reviewCandidates,
      runner,
      consumed,
      reporter,
      claimTask: consumingClaimTask(consumed),
    });
    const loop = createLoopOrchestrator(deps);

    const warnings = await withCapturedWarnings(async () => {
      await loop(ALL_PHASES_ON);
    });

    // The whole tick did NOT abort — the PR candidate still dispatched
    // (with its pre-claim marker, per the default claimPr stub).
    expectDispatchedCommands(messages, [
      "/shipwright:review acme/x#7 [preclaim:acme/x#7:acme/x#7-sha]",
    ]);

    // The failed dev-task dispatch still reported a failed run (dispatch()'s
    // own reporting is unchanged by the fix) — it just didn't abort the tick.
    expect(creates.map((c) => c.itemId)).toEqual(["SWC-BOOM", "acme/x#7"]);
    expect(completes).toEqual([
      {
        cronId: "shipwright-loop",
        runId: "run-1",
        outcome: "failed",
        phaseId: "shipwright-dev-task",
        itemType: "task",
        itemId: "SWC-BOOM",
      },
      {
        cronId: "shipwright-loop",
        runId: "run-2",
        outcome: "completed",
        phaseId: "shipwright-review",
        itemType: "pr",
        itemId: "acme/x#7",
      },
    ]);
    expect(skips).toEqual([]);

    // The failure is logged, observable, and identifies the offending item.
    expect(
      warnings.some((w) => w.includes("SWC-BOOM")),
    ).toBe(true);
  });

  // ─── Pre-claim tests (CBD-1.3 — PR items) ──────────────────────────────────

  for (const phase of ["review", "patch", "deploy"] as const) {
    const optKey = `${phase}Candidates` as const;
    const command = `/shipwright:${phase}`;

    test(`a successful ${phase} pre-claim proceeds to dispatch with a marker appended`, async () => {
      const consumed = new Set<string>();
      const prCandidate = pr(
        "app-vitals/shipwright#1",
        "2026-01-01T00:00:00Z",
        phase,
      );
      const { runner, messages } = makeDrainingRunner(
        { [phase]: [prCandidate] },
        consumed,
      );
      const claimedPrs: WorkPrCandidate[] = [];
      const deps = makeDeps({
        [optKey]: [prCandidate],
        runner,
        consumed,
        claimPr: async (pr: WorkPrCandidate) => {
          claimedPrs.push(pr);
          return { id: "clx-record-id", commitSha: pr.commitSha };
        },
      });
      const loop = createLoopOrchestrator(deps);

      await loop([job(`shipwright-${phase}`, true)]);

      expect(claimedPrs).toHaveLength(1);
      expect(claimedPrs[0]?.id).toBe("app-vitals/shipwright#1");
      expectDispatchedCommands(messages, [
        `${command} app-vitals/shipwright#1 [preclaim:clx-record-id:app-vitals/shipwright#1-sha]`,
      ]);
    });

    test(`a 409 ${phase} pre-claim conflict skips dispatch entirely — no runner call, no cron-run row`, async () => {
      const { reporter, creates, completes, skips } = makeRecordingReporter();
      const { runner, messages } = makeRunner();
      const prCandidate = pr(
        "app-vitals/shipwright#1",
        "2026-01-01T00:00:00Z",
        phase,
      );
      // Return the candidate once, then empty — modeling "claimed by another
      // agent and no longer qualifying" so the drain terminates.
      let calls = 0;
      const deps = makeDeps({
        [optKey]: async () => {
          calls += 1;
          return calls === 1 ? [prCandidate] : [];
        },
        runner,
        reporter,
        claimPr: async () => null,
      });
      const loop = createLoopOrchestrator(deps);

      await loop([job(`shipwright-${phase}`, true)]);

      expect(messages).toEqual([]);
      expect(creates).toEqual([]);
      expect(completes).toEqual([]);
      expect(skips).toEqual([]);
    });

    test(`the drain loop continues past a skipped (409) ${phase} item to the next candidate`, async () => {
      const consumed = new Set<string>();
      const { reporter, creates } = makeRecordingReporter();
      const prCandidates = [
        pr("app-vitals/shipwright#1", "2026-01-01T00:00:00Z", phase),
        pr("app-vitals/shipwright#2", "2026-01-02T00:00:00Z", phase),
      ];
      const { runner, messages } = makeDrainingRunner(
        { [phase]: prCandidates },
        consumed,
      );
      const deps = makeDeps({
        [optKey]: async () => prCandidates.filter((c) => !consumed.has(c.id)),
        runner,
        consumed,
        reporter,
        claimPr: async (pr: WorkPrCandidate) => {
          if (pr.id === "app-vitals/shipwright#1") {
            consumed.add(pr.id);
            return null;
          }
          return { id: "clx-record-id", commitSha: pr.commitSha };
        },
      });
      const loop = createLoopOrchestrator(deps);

      await loop([job(`shipwright-${phase}`, true)]);

      expectDispatchedCommands(messages, [
        `${command} app-vitals/shipwright#2 [preclaim:clx-record-id:app-vitals/shipwright#2-sha]`,
      ]);
      expect(creates.map((c) => c.itemId)).toEqual(["app-vitals/shipwright#2"]);
    });
  }

  // ─── Redispatch-cooldown tests (CBD-2.2) ────────────────────────────────────
  //
  // hitl:true exclusion is NOT tested here — that gate lives at the candidate
  // collector level (check-patch.ts, check-review.ts skip a hitl'd PR before
  // it's ever returned as a WorkPrCandidate), not in the orchestrator. See
  // check-patch.unit.test.ts / check-review.unit.test.ts for that coverage.

  /** A Clock whose now() can be advanced between calls, for cooldown tests. */
  function makeMutableClock(initialIso: string): {
    clock: import("./clock.ts").Clock;
    advanceMs: (ms: number) => void;
  } {
    let current = new Date(initialIso);
    return {
      clock: { now: () => current },
      advanceMs: (ms: number) => {
        current = new Date(current.getTime() + ms);
      },
    };
  }

  test("a PR redispatched at the same commitSha within the cooldown window is suppressed on the next tick", async () => {
    const { clock } = makeMutableClock("2026-01-01T00:00:00Z");
    const { reporter, creates } = makeRecordingReporter();
    const patchCandidate = pr("acme/x#5", "2026-01-01T00:00:00Z", "patch");
    // Same unresolved candidate returned every tick — mirrors the real bug:
    // the PR still needs patch attention at the same commit every time it's
    // re-collected (e.g. CI still failing, findings still unaddressed).
    const deps = {
      ...makeDeps({ patchCandidates: [patchCandidate], reporter }),
      clock,
    };
    const loop = createLoopOrchestrator(deps);

    // First tick: dispatches normally.
    await loop([job("shipwright-patch", true)]);
    expect(creates).toHaveLength(1);

    // Second tick, no time elapsed (well within the cooldown): suppressed.
    await loop([job("shipwright-patch", true)]);
    expect(creates).toHaveLength(1);
  });

  test("a PR redispatch is allowed again once the cooldown window elapses", async () => {
    const { clock, advanceMs } = makeMutableClock("2026-01-01T00:00:00Z");
    const { reporter, creates } = makeRecordingReporter();
    const patchCandidate = pr("acme/x#5", "2026-01-01T00:00:00Z", "patch");
    const deps = {
      ...makeDeps({ patchCandidates: [patchCandidate], reporter }),
      clock,
    };
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-patch", true)]);
    expect(creates).toHaveLength(1);

    // Past the 25-minute cooldown — a genuinely new cron tick's worth of time.
    advanceMs(26 * 60 * 1000);
    await loop([job("shipwright-patch", true)]);
    expect(creates).toHaveLength(2);
  });

  test("a PR redispatch is allowed immediately once its commitSha changes, even within the cooldown window", async () => {
    const { clock } = makeMutableClock("2026-01-01T00:00:00Z");
    const { reporter, creates } = makeRecordingReporter();
    let patchCandidate = pr("acme/x#5", "2026-01-01T00:00:00Z", "patch", {
      commitSha: "sha-v1",
    });
    const deps = {
      ...makeDeps({
        patchCandidates: () => Promise.resolve([patchCandidate]),
        reporter,
      }),
      clock,
    };
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-patch", true)]);
    expect(creates).toHaveLength(1);

    // A new commit landed (e.g. the author pushed a fix) — no time elapsed,
    // but the commitSha differs, so it must dispatch again right away.
    patchCandidate = { ...patchCandidate, commitSha: "sha-v2" };
    await loop([job("shipwright-patch", true)]);
    expect(creates).toHaveLength(2);
  });

  test("the pre-claim marker is appended in the exact [preclaim:id:sha] format", async () => {
    const consumed = new Set<string>();
    const prCandidate = pr(
      "app-vitals/shipwright#1",
      "2026-01-01T00:00:00Z",
      "review",
    );
    const { runner, messages } = makeDrainingRunner(
      { review: [prCandidate] },
      consumed,
    );
    const deps = makeDeps({
      reviewCandidates: [prCandidate],
      runner,
      consumed,
      claimPr: async (pr: WorkPrCandidate) => ({
        id: "clxRECORD",
        commitSha: "deadbeef1234",
      }),
    });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-review", true)]);

    expect(messages[0]).toEndWith(
      "/shipwright:review app-vitals/shipwright#1 [preclaim:clxRECORD:deadbeef1234]",
    );
  });

  // ─── Progress push + partial-usage-on-failure tests (CSU-3.1) ─────────────

  function usage(inputTokens = 100): ModelUsage {
    return {
      "claude-opus-4": {
        inputTokens,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.1,
      },
    };
  }

  /** A mutable clock whose now() can be advanced between calls. */
  function makeMutableClockForProgress(initialIso: string): {
    clock: import("./clock.ts").Clock;
    advanceMs: (ms: number) => void;
  } {
    let current = new Date(initialIso);
    return {
      clock: { now: () => current },
      advanceMs: (ms: number) => {
        current = new Date(current.getTime() + ms);
      },
    };
  }

  test("onProgress is wired to recordProgress — a single progress emission during dispatch triggers exactly one recordProgress call", async () => {
    const consumed = new Set<string>();
    const devTaskCandidates = [task("SWC-P1", "2026-01-01T00:00:00Z")];
    const { reporter, progressCalls } = makeRecordingReporter();
    const runner = async (
      _message: string,
      onProgress?: ProgressCallback,
    ): Promise<ClaudeRunResult> => {
      onProgress?.(usage());
      consumed.add("SWC-P1");
      return { result: "done" };
    };
    const deps = makeDeps({ devTaskCandidates, runner, reporter, consumed });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-dev-task", true)]);

    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0]?.modelBreakdown).toEqual([
      {
        model: "claude-opus-4",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.1,
      },
    ]);
    expect(progressCalls[0]?.runId).toBe("run-1");
  });

  test("debounce: two progress emissions less than 5s apart (per clock) result in only one recordProgress call", async () => {
    const consumed = new Set<string>();
    const devTaskCandidates = [task("SWC-P2", "2026-01-01T00:00:00Z")];
    const { reporter, progressCalls } = makeRecordingReporter();
    const { clock, advanceMs } = makeMutableClockForProgress(
      "2026-01-01T00:00:00Z",
    );
    const runner = async (
      _message: string,
      onProgress?: ProgressCallback,
    ): Promise<ClaudeRunResult> => {
      onProgress?.(usage(100));
      advanceMs(2000); // < 5s later
      onProgress?.(usage(200));
      consumed.add("SWC-P2");
      return { result: "done" };
    };
    const deps = {
      ...makeDeps({ devTaskCandidates, runner, reporter, consumed }),
      clock,
    };
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-dev-task", true)]);

    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0]?.modelBreakdown?.[0]?.inputTokens).toBe(100);
  });

  test("debounce: a third progress emission past the 5s window triggers a second recordProgress call", async () => {
    const consumed = new Set<string>();
    const devTaskCandidates = [task("SWC-P3", "2026-01-01T00:00:00Z")];
    const { reporter, progressCalls } = makeRecordingReporter();
    const { clock, advanceMs } = makeMutableClockForProgress(
      "2026-01-01T00:00:00Z",
    );
    const runner = async (
      _message: string,
      onProgress?: ProgressCallback,
    ): Promise<ClaudeRunResult> => {
      onProgress?.(usage(100)); // fires — first ever call
      advanceMs(2000); // +2s — still within 5s window
      onProgress?.(usage(200)); // skipped
      advanceMs(4000); // +6s total from first — past the 5s window
      onProgress?.(usage(300)); // fires
      consumed.add("SWC-P3");
      return { result: "done" };
    };
    const deps = {
      ...makeDeps({ devTaskCandidates, runner, reporter, consumed }),
      clock,
    };
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-dev-task", true)]);

    expect(progressCalls).toHaveLength(2);
    expect(progressCalls[0]?.modelBreakdown?.[0]?.inputTokens).toBe(100);
    expect(progressCalls[1]?.modelBreakdown?.[0]?.inputTokens).toBe(300);
  });

  test("an empty/undefined modelUsage from onProgress does not produce an empty recordProgress call", async () => {
    const consumed = new Set<string>();
    const devTaskCandidates = [task("SWC-P4", "2026-01-01T00:00:00Z")];
    const { reporter, progressCalls } = makeRecordingReporter();
    const runner = async (
      _message: string,
      onProgress?: ProgressCallback,
    ): Promise<ClaudeRunResult> => {
      onProgress?.({});
      consumed.add("SWC-P4");
      return { result: "done" };
    };
    const deps = makeDeps({ devTaskCandidates, runner, reporter, consumed });
    const loop = createLoopOrchestrator(deps);

    await loop([job("shipwright-dev-task", true)]);

    expect(progressCalls).toHaveLength(0);
  });

  test("a runner throw carrying err.partialModelUsage (ClaudeTimeoutError) attaches modelBreakdown to the failed completeRun call", async () => {
    const consumed = new Set<string>();
    const devTaskCandidates = [task("SWC-P5", "2026-01-01T00:00:00Z")];
    const { reporter, completes } = makeRecordingReporter();
    const runner = async (): Promise<ClaudeRunResult> => {
      throw new ClaudeTimeoutError(600_000, "ceiling", usage(42));
    };
    const deps = makeDeps({
      devTaskCandidates,
      runner,
      reporter,
      consumed,
      claimTask: consumingClaimTask(consumed),
    });
    const loop = createLoopOrchestrator(deps);

    // CBD-2.3: a thrown dispatch is now caught and isolated per-item — the
    // tick resolves normally instead of the throw propagating out of it.
    await loop([job("shipwright-dev-task", true)]);

    expect(completes).toHaveLength(1);
    expect(completes[0]?.outcome).toBe("failed");
  });

  test("a runner throw without partialModelUsage (plain Error) falls back to { error } only", async () => {
    const consumed = new Set<string>();
    const devTaskCandidates = [task("SWC-P6", "2026-01-01T00:00:00Z")];
    const { reporter } = makeRecordingReporter();
    const opts: Array<{ error?: string; modelBreakdown?: unknown }> = [];
    const trackedReporter: CronRunReporter = {
      ...reporter,
      async completeRun(
        cronId,
        runId,
        completedAt,
        outcome,
        completeOpts,
        phaseId,
        itemType,
        itemId,
      ) {
        opts.push({
          error: completeOpts?.error,
          modelBreakdown: completeOpts?.modelBreakdown,
        });
        await reporter.completeRun(
          cronId,
          runId,
          completedAt,
          outcome,
          completeOpts,
          phaseId,
          itemType,
          itemId,
        );
      },
    };
    const runner = async (): Promise<ClaudeRunResult> => {
      throw new Error("plain failure, no partial usage");
    };
    const deps = makeDeps({
      devTaskCandidates,
      runner,
      reporter: trackedReporter,
      consumed,
      claimTask: consumingClaimTask(consumed),
    });
    const loop = createLoopOrchestrator(deps);

    // CBD-2.3: a thrown dispatch is now caught and isolated per-item — the
    // tick resolves normally instead of the throw propagating out of it.
    await loop([job("shipwright-dev-task", true)]);

    expect(opts).toHaveLength(1);
    expect(opts[0]?.error).toBe("plain failure, no partial usage");
    expect(opts[0]?.modelBreakdown).toBeUndefined();
  });

  test("a runner throw with a ClaudeRunError (modelUsage, not partialModelUsage) falls back to { error } only", async () => {
    const consumed = new Set<string>();
    const devTaskCandidates = [task("SWC-P7", "2026-01-01T00:00:00Z")];
    const { reporter } = makeRecordingReporter();
    const opts: Array<{ error?: string; modelBreakdown?: unknown }> = [];
    const trackedReporter: CronRunReporter = {
      ...reporter,
      async completeRun(
        cronId,
        runId,
        completedAt,
        outcome,
        completeOpts,
        phaseId,
        itemType,
        itemId,
      ) {
        opts.push({
          error: completeOpts?.error,
          modelBreakdown: completeOpts?.modelBreakdown,
        });
        await reporter.completeRun(
          cronId,
          runId,
          completedAt,
          outcome,
          completeOpts,
          phaseId,
          itemType,
          itemId,
        );
      },
    };
    const runner = async (): Promise<ClaudeRunResult> => {
      throw new ClaudeRunError(
        "claude run failed",
        500,
        "boom",
        "session-1",
        usage(42),
      );
    };
    const deps = makeDeps({
      devTaskCandidates,
      runner,
      reporter: trackedReporter,
      consumed,
      claimTask: consumingClaimTask(consumed),
    });
    const loop = createLoopOrchestrator(deps);

    // CBD-2.3: a thrown dispatch is now caught and isolated per-item — the
    // tick resolves normally instead of the throw propagating out of it.
    await loop([job("shipwright-dev-task", true)]);

    expect(opts).toHaveLength(1);
    expect(opts[0]?.error).toBe("claude run failed");
    expect(opts[0]?.modelBreakdown).toBeUndefined();
  });

  test("a recordProgress rejection does not crash dispatch — the dispatch still completes normally", async () => {
    const consumed = new Set<string>();
    const devTaskCandidates = [task("SWC-P8", "2026-01-01T00:00:00Z")];
    const failingReporter: CronRunReporter = {
      async createRun() {
        return "run-1";
      },
      async completeRun() {},
      async skipRun() {},
      async recordProgress() {
        throw new Error("admin API unreachable");
      },
    };
    const runner = async (
      _message: string,
      onProgress?: ProgressCallback,
    ): Promise<ClaudeRunResult> => {
      onProgress?.(usage());
      consumed.add("SWC-P8");
      return { result: "done" };
    };
    const deps = makeDeps({
      devTaskCandidates,
      runner,
      reporter: failingReporter,
      consumed,
    });
    const loop = createLoopOrchestrator(deps);

    // Must resolve without throwing despite recordProgress rejecting.
    await expect(
      loop([job("shipwright-dev-task", true)]),
    ).resolves.toBeUndefined();
  });
});

// ─── formatPreClaimMarker ────────────────────────────────────────────────────

describe("formatPreClaimMarker", () => {
  test("formats a bracket-delimited [preclaim:id:sha] marker", () => {
    expect(formatPreClaimMarker("clxRECORD", "deadbeef1234")).toBe(
      "[preclaim:clxRECORD:deadbeef1234]",
    );
  });
});
