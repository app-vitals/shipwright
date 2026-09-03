/**
 * agent/src/slack-progress.unit.test.ts
 *
 * Unit tests for SlackProgress — the live Thinking Steps stream driver for
 * Slack thread replies (STS2-1.1, fixed for STS-1.1/PR #3034's broken first
 * cut, whose `{type: "task_update", text}` chunk shape was rejected by
 * Slack's real API on every call — see the module doc comment in
 * slack-progress.ts for the full root-cause writeup; TSD-1.1 then removed
 * the feature flag that gated it, making streaming the only mode):
 *   - start() does NOT call agents.sessions.setStatus at all — chat.startStream
 *     already flips the session status itself.
 *   - start() seeds the stream with an immediate task_update card (no blank
 *     gap before the first real phase transition).
 *   - every task_update chunk uses {type, id, title, status}, reusing one
 *     stable id across every update in the run (never the old {type, text}
 *     shape, and never a fresh id per update).
 *   - deliverContent() sends the final answer as its own markdown_text
 *     chunk plus a status:"complete" task_update, and returns undefined
 *     whenever delivery fails or streaming is unavailable so the caller
 *     falls back to say()/blocksConverter.
 *   - finish() closes any still-in_progress card with status:"complete",
 *     and passes session_status through to stopStream.
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
  } = {},
) {
  const client = overrides.client ?? makeMockClient();
  const progress = new SlackProgress({
    client,
    channel: CHANNEL,
    threadTs: THREAD_TS,
  });
  return { progress, client };
}

/** Pulls the single task_update chunk out of an appendStream/startStream call. */
function taskUpdateChunk(call: { chunks: Array<Record<string, unknown>> }) {
  return call.chunks.find((c) => c.type === "task_update");
}

// ─── Thinking Steps stream ──────────────────────────────────────────────────

describe("SlackProgress — Thinking Steps stream", () => {
  test("start() opens a chat.startStream with task_display_mode timeline", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    expect(client.chat.startStream).toHaveBeenCalledWith({
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      task_display_mode: "timeline",
    });
  });

  // AC #3: agents.sessions.setStatus is never called — chat.startStream
  // already sets the session status to "processing" itself, so calling both
  // would produce two overlapping "is working" indicators.
  test("start() does NOT call setStatus (AC #3)", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    expect(client.agents.sessions.setStatus).not.toHaveBeenCalled();
  });

  // AC #4: the stream is seeded with an immediate card on open — no blank
  // gap before the first real phase transition.
  test("start() seeds the stream with an immediate in_progress task_update card (AC #4)", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    expect(client.chat.appendStream).toHaveBeenCalledTimes(1);
    const call = client.chat.appendStream.mock.calls[0]?.[0] as {
      chunks: Array<Record<string, unknown>>;
    };
    const chunk = taskUpdateChunk(call);
    expect(chunk).toMatchObject({ type: "task_update", status: "in_progress" });
    expect(chunk?.id).toBeDefined();
    expect(typeof chunk?.title).toBe("string");
  });

  // AC #5: seed text reflects whether another message is already in flight
  // ("Queued…" when the caller signals a burst) vs "Thinking…" otherwise.
  test("start() seeds with 'Thinking…' by default", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    const call = client.chat.appendStream.mock.calls[0]?.[0] as {
      chunks: Array<Record<string, unknown>>;
    };
    expect(taskUpdateChunk(call)?.title).toBe("Thinking…");
  });

  test("start() seeds with 'Queued…' when told another message is already in flight", async () => {
    const { progress, client } = makeProgress();
    await progress.start({ queued: true });
    const call = client.chat.appendStream.mock.calls[0]?.[0] as {
      chunks: Array<Record<string, unknown>>;
    };
    expect(taskUpdateChunk(call)?.title).toBe("Queued…");
  });

  // AC #1: task_update chunks use type/id/title/status, with a single stable
  // id reused across every update in the run — not the old {type, text}
  // shape, and never a fresh id per update (which stacks a separate card).
  test("onProgress appends a task_update chunk with the new type/id/title/status shape", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    client.chat.appendStream.mockClear();
    progress.onProgress({}, "reading");
    expect(client.chat.appendStream).toHaveBeenCalledTimes(1);
    const call = client.chat.appendStream.mock.calls[0]?.[0] as {
      chunks: Array<Record<string, unknown>>;
    };
    const chunk = taskUpdateChunk(call);
    expect(chunk).toMatchObject({
      type: "task_update",
      title: PROGRESS_LABELS.reading,
      status: "in_progress",
    });
    expect(chunk?.id).toBeDefined();
    // Explicitly not the old rejected shape.
    expect(chunk).not.toHaveProperty("text");
  });

  test("onProgress reuses the same stable id as the seed card across every update", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    const seedCall = client.chat.appendStream.mock.calls[0]?.[0] as {
      chunks: Array<Record<string, unknown>>;
    };
    const seedId = taskUpdateChunk(seedCall)?.id;

    progress.onProgress({}, "reading");
    progress.onProgress({}, "editing");

    const calls = client.chat.appendStream.mock.calls as unknown as Array<
      [{ chunks: Array<Record<string, unknown>> }]
    >;
    for (const [call] of calls) {
      expect(taskUpdateChunk(call)?.id).toBe(seedId as string);
    }
  });

  test("onProgress collapses repeated identical phases into a single appendStream call", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    client.chat.appendStream.mockClear();
    progress.onProgress({}, "reading");
    progress.onProgress({}, "reading");
    progress.onProgress({}, "reading");
    expect(client.chat.appendStream).toHaveBeenCalledTimes(1);
  });

  test("onProgress fires again once the phase transitions to a new distinct value", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    client.chat.appendStream.mockClear();
    progress.onProgress({}, "reading");
    progress.onProgress({}, "reading");
    progress.onProgress({}, "editing");
    expect(client.chat.appendStream).toHaveBeenCalledTimes(2);
    const call = client.chat.appendStream.mock.calls[1]?.[0] as {
      chunks: Array<Record<string, unknown>>;
    };
    expect(taskUpdateChunk(call)?.title).toBe(PROGRESS_LABELS.editing);
  });

  test("onProgress with an undefined phase does not append a chunk", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    client.chat.appendStream.mockClear();
    progress.onProgress({}, undefined);
    expect(client.chat.appendStream).not.toHaveBeenCalled();
  });

  test("onProgress does not throw synchronously (fire-and-forget)", async () => {
    const { progress } = makeProgress();
    await progress.start();
    expect(() => progress.onProgress({}, "reading")).not.toThrow();
  });

  // AC #2: the final answer is delivered as its own markdown_text chunk via
  // chat.appendStream, alongside a status:"complete" task_update — NOT via
  // chat.stopStream's top-level markdown_text param.
  test("deliverContent() sends the text as a markdown_text chunk via chat.appendStream", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    client.chat.appendStream.mockClear();
    const delivered = await progress.deliverContent("Here is the answer.");
    expect(delivered).toBe(true);
    expect(client.chat.appendStream).toHaveBeenCalledTimes(1);
    const call = client.chat.appendStream.mock.calls[0]?.[0] as {
      chunks: Array<Record<string, unknown>>;
    };
    expect(call.chunks).toContainEqual({
      type: "markdown_text",
      text: "Here is the answer.",
    });
  });

  test("deliverContent() also sends a status:complete task_update alongside the markdown_text chunk (AC #2)", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    client.chat.appendStream.mockClear();
    await progress.deliverContent("Here is the answer.");
    const call = client.chat.appendStream.mock.calls[0]?.[0] as {
      chunks: Array<Record<string, unknown>>;
    };
    const chunk = taskUpdateChunk(call);
    expect(chunk?.status).toBe("complete");
    // Completion text never ends in an ellipsis (AC #4).
    expect((chunk?.title as string).endsWith("…")).toBe(false);
  });

  test("deliverContent() does not call chat.stopStream with a top-level markdown_text param", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    await progress.deliverContent("Here is the answer.");
    await progress.finish();
    for (const [args] of client.chat.stopStream.mock.calls) {
      expect(args).not.toHaveProperty("markdown_text");
    }
  });

  test("deliverContent() returns undefined when no stream is open (startStream never returned a ts)", async () => {
    const client = makeMockClient();
    client.chat.startStream.mockResolvedValueOnce(undefined as never);
    const { progress } = makeProgress({ client });
    await progress.start();
    const delivered = await progress.deliverContent("Here is the answer.");
    expect(delivered).toBeUndefined();
  });

  test("deliverContent() returns undefined when chat.appendStream rejects (delivery failure)", async () => {
    const client = makeMockClient();
    const { progress } = makeProgress({ client });
    await progress.start();
    client.chat.appendStream.mockRejectedValueOnce(new Error("append down"));
    const delivered = await progress.deliverContent("Here is the answer.");
    expect(delivered).toBeUndefined();
  });

  // AC #4: the completed card is explicitly sent status:"complete" — leaving
  // it "in_progress" when the stream closes renders as an error/warning
  // triangle even on success.
  test("finish() sends a status:complete task_update when no deliverContent() call already closed the card (AC #4)", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    client.chat.appendStream.mockClear();
    await progress.finish();
    expect(client.chat.appendStream).toHaveBeenCalledTimes(1);
    const call = client.chat.appendStream.mock.calls[0]?.[0] as {
      chunks: Array<Record<string, unknown>>;
    };
    expect(taskUpdateChunk(call)?.status).toBe("complete");
  });

  // STS2-3.1: a silent/suppressed response still needs its dangling
  // in_progress card closed, but "Done" would misleadingly imply a real
  // reply was posted — finish({ silent: true }) uses "Ack" instead.
  test("finish({ silent: true }) sends a status:complete task_update titled 'Ack' (STS2-3.1)", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    client.chat.appendStream.mockClear();
    await progress.finish({ silent: true });
    expect(client.chat.appendStream).toHaveBeenCalledTimes(1);
    const call = client.chat.appendStream.mock.calls[0]?.[0] as {
      chunks: Array<Record<string, unknown>>;
    };
    const chunk = taskUpdateChunk(call);
    expect(chunk?.title).toBe("Ack");
    expect(chunk?.status).toBe("complete");
  });

  test("finish() and finish({ silent: false }) still send the 'Done' title (regression)", async () => {
    for (const opts of [undefined, { silent: false }] as const) {
      const { progress, client } = makeProgress();
      await progress.start();
      client.chat.appendStream.mockClear();
      await progress.finish(opts);
      const call = client.chat.appendStream.mock.calls[0]?.[0] as {
        chunks: Array<Record<string, unknown>>;
      };
      const chunk = taskUpdateChunk(call);
      expect(chunk?.title).toBe("Done");
    }
  });

  test("finish() does not send a duplicate status:complete update when deliverContent() already closed the card", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    await progress.deliverContent("Here is the answer.");
    client.chat.appendStream.mockClear();
    await progress.finish();
    expect(client.chat.appendStream).not.toHaveBeenCalled();
  });

  test("finish() closes the stream via chat.stopStream", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    await progress.finish();
    expect(client.chat.stopStream).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: CHANNEL,
        thread_ts: THREAD_TS,
        ts: "stream.ts.1",
      }),
    );
  });

  // AC #5: session_status defaults to "active" (the genuine last-to-finish
  // message of a burst), but "processing" when the caller signals other
  // messages are still in flight — chat.stopStream's session_status is
  // per-thread, not per-message.
  test("finish() closes with session_status 'active' by default", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    await progress.finish({ stillInFlight: false });
    expect(client.chat.stopStream).toHaveBeenCalledWith(
      expect.objectContaining({ session_status: "active" }),
    );
  });

  test("finish() closes with session_status 'processing' when other messages are still in flight (AC #5)", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    await progress.finish({ stillInFlight: true });
    expect(client.chat.stopStream).toHaveBeenCalledWith(
      expect.objectContaining({ session_status: "processing" }),
    );
  });

  // AC #3: setStatus stays unused on the finish() side too.
  test("finish() does NOT call setStatus (AC #3)", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    await progress.finish();
    expect(client.agents.sessions.setStatus).not.toHaveBeenCalled();
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

  test("start() does not throw when the client has no chat namespace, and warns", async () => {
    const progress = new SlackProgress({
      client: { agents: { sessions: { setStatus: mock(async () => {}) } } },
      channel: CHANNEL,
      threadTs: THREAD_TS,
    });
    await expect(progress.start()).resolves.toBeUndefined();
    // startStream fails (no chat namespace), then the seed-card append also
    // fails for the same reason — both are swallowed and warned.
    expect(warnCalls).toContainEqual([
      "[slack-progress] startStream failed:",
      "undefined is not an object (evaluating 'this.client.chat.startStream')",
    ]);
    expect(warnCalls).toContainEqual([
      "[slack-progress] appendStream(Thinking…) failed:",
      "undefined is not an object (evaluating 'this.client.chat.appendStream')",
    ]);
  });

  test("start() does not throw when chat.startStream rejects, and warns", async () => {
    const client = makeMockClient();
    client.chat.startStream.mockRejectedValueOnce(new Error("stream down"));
    const { progress } = makeProgress({ client });
    await expect(progress.start()).resolves.toBeUndefined();
    expect(warnCalls).toContainEqual([
      "[slack-progress] startStream failed:",
      "stream down",
    ]);
  });

  test("onProgress does not throw when the client has no chat namespace, and warns", async () => {
    const progress = new SlackProgress({
      client: { agents: { sessions: { setStatus: mock(async () => {}) } } },
      channel: CHANNEL,
      threadTs: THREAD_TS,
    });
    expect(() => progress.onProgress({}, "reading")).not.toThrow();
    expect(warnCalls).toContainEqual([
      "[slack-progress] appendStream(Reading files…) failed:",
      "undefined is not an object (evaluating 'this.client.chat.appendStream')",
    ]);
  });

  test("onProgress warns (async) when chat.appendStream rejects", async () => {
    const client = makeMockClient();
    const { progress } = makeProgress({ client });
    await progress.start();
    client.chat.appendStream.mockRejectedValueOnce(new Error("append down"));
    expect(() => progress.onProgress({}, "reading")).not.toThrow();
    // appendStream is fire-and-forget (sync callback) — let the rejection's
    // .catch() microtask run before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(warnCalls).toContainEqual([
      "[slack-progress] appendStream(Reading files…) failed:",
      "append down",
    ]);
  });

  test("finish() does not throw when the client has no chat namespace, and warns", async () => {
    const progress = new SlackProgress({
      client: { agents: { sessions: { setStatus: mock(async () => {}) } } },
      channel: CHANNEL,
      threadTs: THREAD_TS,
    });
    await expect(progress.finish()).resolves.toBeUndefined();
    expect(warnCalls).toContainEqual([
      "[slack-progress] stopStream failed:",
      "undefined is not an object (evaluating 'this.client.chat.stopStream')",
    ]);
  });

  test("finish() does not throw when chat.stopStream rejects, and warns", async () => {
    const client = makeMockClient();
    client.chat.stopStream.mockRejectedValueOnce(new Error("stop down"));
    const { progress } = makeProgress({ client });
    await progress.start();
    await expect(progress.finish()).resolves.toBeUndefined();
    expect(warnCalls).toContainEqual([
      "[slack-progress] stopStream failed:",
      "stop down",
    ]);
  });

  test("deliverContent() does not throw when chat.appendStream rejects, and warns", async () => {
    const client = makeMockClient();
    const { progress } = makeProgress({ client });
    await progress.start();
    client.chat.appendStream.mockRejectedValueOnce(new Error("deliver down"));
    await expect(
      progress.deliverContent("final answer"),
    ).resolves.toBeUndefined();
    expect(warnCalls).toContainEqual([
      "[slack-progress] deliverContent failed:",
      "deliver down",
    ]);
  });
});
