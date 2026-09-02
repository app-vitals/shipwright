/**
 * agent/src/slack-progress.unit.test.ts
 *
 * Unit tests for SlackProgress — the status-only progress driver for Slack
 * thread replies. Covers start()/finish() calling `agents.sessions.setStatus`
 * with the fixed lifecycle values ("processing" / "active"), that onProgress()
 * no longer drives any Slack API call (the new API has no per-phase text
 * slot), and that every Slack API failure is swallowed rather than thrown
 * (and logged via console.warn instead — swapped in per-test via a local
 * save/restore, same pattern as check-helpers.unit.test.ts's
 * mapReposTolerant suite, since Bun shares the test process globally).
 *
 * Also covers the opt-in Thinking Steps stream (`thinkingStepsEnabled`):
 * chat.startStream on start(), one chat.appendStream per distinct
 * ProgressPhase transition (repeats collapse), chat.stopStream on finish() —
 * all gated behind the flag and all fail-open like setStatus().
 *
 * The mock Slack client is a plain object of mock fns — no mock.module(), no
 * global overrides. No Clock injection is needed: SlackProgress does no
 * time-based scheduling.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { PROGRESS_LABELS } from "@shipwright/lib/progress-phases";
import { SlackProgress } from "./slack-progress.ts";

// ─── Mock Slack client ────────────────────────────────────────────────────────

function makeMockClient() {
  return {
    agents: {
      sessions: {
        setStatus: mock(async (_args: unknown) => {}),
      },
    },
    chat: {
      startStream: mock(async (_args: unknown) => ({ ts: "stream.ts.1" })),
      appendStream: mock(async (_args: unknown) => {}),
      stopStream: mock(async (_args: unknown) => {}),
    },
  };
}

const CHANNEL = "D123";
const THREAD_TS = "111.222";

function makeProgress(
  overrides: {
    client?: ReturnType<typeof makeMockClient>;
    thinkingStepsEnabled?: boolean;
  } = {},
) {
  const client = overrides.client ?? makeMockClient();
  const progress = new SlackProgress({
    client,
    channel: CHANNEL,
    threadTs: THREAD_TS,
    thinkingStepsEnabled: overrides.thinkingStepsEnabled,
  });
  return { progress, client };
}

// ─── status-on-start ───────────────────────────────────────────────────────────

describe("SlackProgress — start()", () => {
  test("sets status to processing", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    expect(client.agents.sessions.setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "processing",
    });
  });

  test("does not open a Thinking Steps stream when the flag is off", async () => {
    const { progress, client } = makeProgress({ thinkingStepsEnabled: false });
    await progress.start();
    expect(client.chat.startStream).not.toHaveBeenCalled();
  });

  test("does not open a Thinking Steps stream when the flag is omitted", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    expect(client.chat.startStream).not.toHaveBeenCalled();
  });
});

// ─── onProgress is a no-op for phase transitions when the flag is off ─────────

describe("SlackProgress.onProgress — phase transitions (flag off)", () => {
  test("does not call setStatus when a real phase is present", () => {
    const { progress, client } = makeProgress();
    progress.onProgress({}, "reading");
    expect(client.agents.sessions.setStatus).not.toHaveBeenCalled();
  });

  test("does not call setStatus for a usage-only tick (phase undefined)", () => {
    const { progress, client } = makeProgress();
    progress.onProgress({}, undefined);
    expect(client.agents.sessions.setStatus).not.toHaveBeenCalled();
  });

  test("does not throw regardless of phase", () => {
    const { progress } = makeProgress();
    expect(() => progress.onProgress({}, "editing")).not.toThrow();
    expect(() => progress.onProgress({}, undefined)).not.toThrow();
  });

  test("does not call chat.appendStream when the flag is off", () => {
    const { progress, client } = makeProgress({ thinkingStepsEnabled: false });
    progress.onProgress({}, "reading");
    expect(client.chat.appendStream).not.toHaveBeenCalled();
  });
});

// ─── Thinking Steps stream (flag on) ───────────────────────────────────────────

describe("SlackProgress — Thinking Steps stream (flag on)", () => {
  test("start() opens a chat.startStream with task_display_mode timeline", async () => {
    const { progress, client } = makeProgress({ thinkingStepsEnabled: true });
    await progress.start();
    expect(client.chat.startStream).toHaveBeenCalledWith({
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      task_display_mode: "timeline",
    });
  });

  test("start() still sets status to processing when the flag is on", async () => {
    const { progress, client } = makeProgress({ thinkingStepsEnabled: true });
    await progress.start();
    expect(client.agents.sessions.setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "processing",
    });
  });

  test("onProgress appends one chat.appendStream chunk per distinct phase", async () => {
    const { progress, client } = makeProgress({ thinkingStepsEnabled: true });
    await progress.start();
    progress.onProgress({}, "reading");
    expect(client.chat.appendStream).toHaveBeenCalledTimes(1);
    expect(client.chat.appendStream).toHaveBeenCalledWith({
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      ts: "stream.ts.1",
      chunks: [{ type: "task_update", text: PROGRESS_LABELS.reading }],
    });
  });

  test("onProgress collapses repeated identical phases into a single appendStream call", async () => {
    const { progress, client } = makeProgress({ thinkingStepsEnabled: true });
    await progress.start();
    progress.onProgress({}, "reading");
    progress.onProgress({}, "reading");
    progress.onProgress({}, "reading");
    expect(client.chat.appendStream).toHaveBeenCalledTimes(1);
  });

  test("onProgress fires again once the phase transitions to a new distinct value", async () => {
    const { progress, client } = makeProgress({ thinkingStepsEnabled: true });
    await progress.start();
    progress.onProgress({}, "reading");
    progress.onProgress({}, "reading");
    progress.onProgress({}, "editing");
    expect(client.chat.appendStream).toHaveBeenCalledTimes(2);
    expect(client.chat.appendStream).toHaveBeenNthCalledWith(2, {
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      ts: "stream.ts.1",
      chunks: [{ type: "task_update", text: PROGRESS_LABELS.editing }],
    });
  });

  test("onProgress with an undefined phase does not append a chunk", async () => {
    const { progress, client } = makeProgress({ thinkingStepsEnabled: true });
    await progress.start();
    progress.onProgress({}, undefined);
    expect(client.chat.appendStream).not.toHaveBeenCalled();
  });

  test("onProgress does not throw synchronously (fire-and-forget)", async () => {
    const { progress } = makeProgress({ thinkingStepsEnabled: true });
    await progress.start();
    expect(() => progress.onProgress({}, "reading")).not.toThrow();
  });

  test("finish() closes the stream via chat.stopStream", async () => {
    const { progress, client } = makeProgress({ thinkingStepsEnabled: true });
    await progress.start();
    await progress.finish();
    expect(client.chat.stopStream).toHaveBeenCalledWith({
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      ts: "stream.ts.1",
    });
  });

  test("finish() still sets status to active when the flag is on", async () => {
    const { progress, client } = makeProgress({ thinkingStepsEnabled: true });
    await progress.start();
    await progress.finish();
    expect(client.agents.sessions.setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "active",
    });
  });

  test("finish() does not call chat.stopStream when the flag is off", async () => {
    const { progress, client } = makeProgress({ thinkingStepsEnabled: false });
    await progress.start();
    await progress.finish();
    expect(client.chat.stopStream).not.toHaveBeenCalled();
  });
});

// ─── status-set-to-active-on-finish ─────────────────────────────────────────────

describe("SlackProgress — finish()", () => {
  test("sets status to active (idle/ready — thread stays open for follow-ups)", async () => {
    const { progress, client } = makeProgress();
    await progress.finish();
    expect(client.agents.sessions.setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "active",
    });
  });
});

// ─── errors-swallowed ────────────────────────────────────────────────────────────

describe("SlackProgress — errors swallowed", () => {
  let savedWarn: typeof console.warn;
  let warnCalls: unknown[][];

  beforeEach(() => {
    savedWarn = console.warn;
    warnCalls = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
  });

  afterEach(() => {
    console.warn = savedWarn;
  });

  test("start() does not throw when setStatus rejects, and warns", async () => {
    const client = makeMockClient();
    client.agents.sessions.setStatus.mockRejectedValueOnce(
      new Error("api down"),
    );
    const { progress } = makeProgress({ client });
    await expect(progress.start()).resolves.toBeUndefined();
    expect(warnCalls).toEqual([
      ["[slack-progress] setStatus(processing) failed:", "api down"],
    ]);
  });

  test("finish() does not throw when setStatus rejects, and warns", async () => {
    const client = makeMockClient();
    client.agents.sessions.setStatus.mockRejectedValueOnce(
      new Error("api down"),
    );
    const { progress } = makeProgress({ client });
    await expect(progress.finish()).resolves.toBeUndefined();
    expect(warnCalls).toEqual([
      ["[slack-progress] setStatus(active) failed:", "api down"],
    ]);
  });

  // Regression: a Bolt-supplied client built from a @slack/web-api version
  // that predates the Agent Sessions API has no `agents` namespace at all —
  // accessing `.agents.sessions` throws synchronously, before setStatus()
  // is ever called, so a trailing `.catch()` never attaches.
  test("start() does not throw when the client has no agents namespace, and warns", async () => {
    const progress = new SlackProgress({
      client: {},
      channel: CHANNEL,
      threadTs: THREAD_TS,
    });
    await expect(progress.start()).resolves.toBeUndefined();
    expect(warnCalls).toEqual([
      [
        "[slack-progress] setStatus(processing) failed:",
        "undefined is not an object (evaluating 'this.client.agents.sessions')",
      ],
    ]);
  });

  test("finish() does not throw when the client has no agents namespace, and warns", async () => {
    const progress = new SlackProgress({
      client: {},
      channel: CHANNEL,
      threadTs: THREAD_TS,
    });
    await expect(progress.finish()).resolves.toBeUndefined();
    expect(warnCalls).toEqual([
      [
        "[slack-progress] setStatus(active) failed:",
        "undefined is not an object (evaluating 'this.client.agents.sessions')",
      ],
    ]);
  });

  // ─── Thinking Steps stream — fail-open ─────────────────────────────────────

  test("start() does not throw when the client has no chat namespace (flag on), and warns", async () => {
    const progress = new SlackProgress({
      client: { agents: { sessions: { setStatus: mock(async () => {}) } } },
      channel: CHANNEL,
      threadTs: THREAD_TS,
      thinkingStepsEnabled: true,
    });
    await expect(progress.start()).resolves.toBeUndefined();
    expect(warnCalls).toEqual([
      [
        "[slack-progress] startStream failed:",
        "undefined is not an object (evaluating 'this.client.chat.startStream')",
      ],
    ]);
  });

  test("start() does not throw when chat.startStream rejects (flag on), and warns", async () => {
    const client = makeMockClient();
    client.chat.startStream.mockRejectedValueOnce(new Error("stream down"));
    const { progress } = makeProgress({ client, thinkingStepsEnabled: true });
    await expect(progress.start()).resolves.toBeUndefined();
    expect(warnCalls).toEqual([
      ["[slack-progress] startStream failed:", "stream down"],
    ]);
  });

  test("onProgress does not throw when the client has no chat namespace (flag on), and warns", async () => {
    const progress = new SlackProgress({
      client: { agents: { sessions: { setStatus: mock(async () => {}) } } },
      channel: CHANNEL,
      threadTs: THREAD_TS,
      thinkingStepsEnabled: true,
    });
    expect(() => progress.onProgress({}, "reading")).not.toThrow();
    expect(warnCalls).toEqual([
      [
        "[slack-progress] appendStream(reading) failed:",
        "undefined is not an object (evaluating 'this.client.chat.appendStream')",
      ],
    ]);
  });

  test("onProgress warns (async) when chat.appendStream rejects (flag on)", async () => {
    const client = makeMockClient();
    client.chat.appendStream.mockRejectedValueOnce(new Error("append down"));
    const { progress } = makeProgress({ client, thinkingStepsEnabled: true });
    await progress.start();
    expect(() => progress.onProgress({}, "reading")).not.toThrow();
    // appendStream is fire-and-forget (sync callback) — let the rejection's
    // .catch() microtask run before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(warnCalls).toContainEqual([
      "[slack-progress] appendStream(reading) failed:",
      "append down",
    ]);
  });

  test("finish() does not throw when the client has no chat namespace (flag on), and warns", async () => {
    const progress = new SlackProgress({
      client: { agents: { sessions: { setStatus: mock(async () => {}) } } },
      channel: CHANNEL,
      threadTs: THREAD_TS,
      thinkingStepsEnabled: true,
    });
    await expect(progress.finish()).resolves.toBeUndefined();
    expect(warnCalls).toContainEqual([
      "[slack-progress] stopStream failed:",
      "undefined is not an object (evaluating 'this.client.chat.stopStream')",
    ]);
  });

  test("finish() does not throw when chat.stopStream rejects (flag on), and warns", async () => {
    const client = makeMockClient();
    client.chat.stopStream.mockRejectedValueOnce(new Error("stop down"));
    const { progress } = makeProgress({ client, thinkingStepsEnabled: true });
    await progress.start();
    await expect(progress.finish()).resolves.toBeUndefined();
    expect(warnCalls).toContainEqual([
      "[slack-progress] stopStream failed:",
      "stop down",
    ]);
  });
});
