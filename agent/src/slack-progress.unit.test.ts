/**
 * agent/src/slack-progress.unit.test.ts
 *
 * Unit tests for SlackProgress — the live Thinking Steps stream driver for
 * Slack thread replies (STS2-1.1, fixed for STS-1.1/PR #3034's broken first
 * cut, whose `{type: "task_update", text}` chunk shape was rejected by
 * Slack's real API on every call — see the module doc comment in
 * slack-progress.ts for the full root-cause writeup; TSD-1.1 then removed
 * the feature flag that gated it, making streaming the only mode; ISW-1.1
 * then made agents.sessions.setStatus an eager, unconditional call rather
 * than a stream-failure-only fallback):
 *   - start() calls agents.sessions.setStatus({status: "processing"}) before
 *     startStream() runs, so Slack's native "is working" indicator shows
 *     immediately in channels too (where chat.startStream's own status
 *     effect is gated behind opening the message's thread).
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
 *     always calls agents.sessions.setStatus with the final session status,
 *     and independently also passes that status through to stopStream
 *     whenever a stream did open.
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
    isDM?: boolean;
    recipientUserId?: string;
    recipientTeamId?: string;
  } = {},
) {
  const client = overrides.client ?? makeMockClient();
  const progress = new SlackProgress({
    client,
    channel: CHANNEL,
    threadTs: THREAD_TS,
    // CHANNEL ("D123") is a DM-shaped id — default to isDM: true so the
    // existing DM-focused tests below keep exercising DM behavior (no
    // recipient_team_id/recipient_user_id) unless a test explicitly opts
    // into a channel/group scenario via the override (STS-2.1).
    isDM: overrides.isDM ?? true,
    recipientUserId: overrides.recipientUserId,
    recipientTeamId: overrides.recipientTeamId,
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

  // ─── recipient_team_id / recipient_user_id (STS-2.1) ───────────────────
  // Slack's own SDK types document both fields as "required when starting a
  // streaming conversation outside of a DM" — omitting them in a channel/
  // group thread makes every chat.startStream call fail with
  // missing_recipient_team_id, which is the root cause this task fixes.

  test("start() includes recipient_team_id and recipient_user_id for a non-DM (channel/group) thread (AC #1)", async () => {
    const { progress, client } = makeProgress({
      isDM: false,
      recipientUserId: "U-SENDER",
      recipientTeamId: "T-TEAM",
    });
    await progress.start();
    expect(client.chat.startStream).toHaveBeenCalledWith({
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      task_display_mode: "timeline",
      recipient_team_id: "T-TEAM",
      recipient_user_id: "U-SENDER",
    });
  });

  test("start() omits recipient_team_id and recipient_user_id for a DM thread, even when supplied (AC #2)", async () => {
    const { progress, client } = makeProgress({
      isDM: true,
      recipientUserId: "U-SENDER",
      recipientTeamId: "T-TEAM",
    });
    await progress.start();
    const call = client.chat.startStream.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call).not.toHaveProperty("recipient_team_id");
    expect(call).not.toHaveProperty("recipient_user_id");
  });

  // ISW-1.1: agents.sessions.setStatus is called eagerly, before
  // startStream() even runs — channel @mentions get no visible "is working"
  // signal until chat.startStream's timeline card becomes visible (which
  // requires opening the message's thread in a channel), but setStatus needs
  // only channel_id/thread_ts and shows immediately for both DMs and
  // channels.
  test("start() calls setStatus with status:processing before startStream() runs, for a DM thread (AC #1)", async () => {
    const callOrder: string[] = [];
    const client = makeMockClient();
    client.agents.sessions.setStatus.mockImplementationOnce(async () => {
      callOrder.push("setStatus");
    });
    client.chat.startStream.mockImplementationOnce(async () => {
      callOrder.push("startStream");
      return { ts: "stream.ts.1" };
    });
    const { progress } = makeProgress({ client, isDM: true });
    await progress.start();
    expect(client.agents.sessions.setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "processing",
    });
    expect(callOrder).toEqual(["setStatus", "startStream"]);
  });

  test("start() calls setStatus with status:processing before startStream() runs, for a non-DM (channel) thread (AC #1)", async () => {
    const callOrder: string[] = [];
    const client = makeMockClient();
    client.agents.sessions.setStatus.mockImplementationOnce(async () => {
      callOrder.push("setStatus");
    });
    client.chat.startStream.mockImplementationOnce(async () => {
      callOrder.push("startStream");
      return { ts: "stream.ts.1" };
    });
    const { progress } = makeProgress({
      client,
      isDM: false,
      recipientUserId: "U-SENDER",
      recipientTeamId: "T-TEAM",
    });
    await progress.start();
    expect(client.agents.sessions.setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "processing",
    });
    expect(callOrder).toEqual(["setStatus", "startStream"]);
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
    // Completion text never ends in an ellipsis, and is empty rather than
    // "Done" (STS-2.1 AC #4).
    expect((chunk?.title as string).endsWith("…")).toBe(false);
    expect(chunk?.title).toBe("");
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

  // The "Done" title on the terminal card was getting prepended to the
  // response preview in Slack's UI, adding confusion — the non-silent
  // completion title is now empty (STS-2.1 AC #4). SILENT_COMPLETE_TITLE
  // ("Ack") is unchanged — see the finish({ silent: true }) test above.
  test("finish() and finish({ silent: false }) send an empty completion title, not 'Done' (STS-2.1 AC #4)", async () => {
    for (const opts of [undefined, { silent: false }] as const) {
      const { progress, client } = makeProgress();
      await progress.start();
      client.chat.appendStream.mockClear();
      await progress.finish(opts);
      const call = client.chat.appendStream.mock.calls[0]?.[0] as {
        chunks: Array<Record<string, unknown>>;
      };
      const chunk = taskUpdateChunk(call);
      expect(chunk?.title).toBe("");
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

  // ISW-1.1 (AC #2): finish() always calls setStatus as the authoritative
  // resolution of the "is working" indicator — independent of whether a
  // stream ever opened — AND still calls stopStream() whenever a stream did
  // open (the two are independent, not either/or).
  test("finish() always calls setStatus with session_status 'active' by default, alongside stopStream() when a stream opened (AC #2)", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    await progress.finish();
    expect(client.agents.sessions.setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "active",
    });
    expect(client.chat.stopStream).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: CHANNEL,
        thread_ts: THREAD_TS,
        ts: "stream.ts.1",
        session_status: "active",
      }),
    );
  });

  test("finish({ stillInFlight: true }) calls setStatus with 'processing', alongside stopStream() when a stream opened (AC #2)", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    await progress.finish({ stillInFlight: true });
    expect(client.agents.sessions.setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "processing",
    });
    expect(client.chat.stopStream).toHaveBeenCalledWith(
      expect.objectContaining({ session_status: "processing" }),
    );
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
    const setStatus = mock(async (_args: unknown) => {});
    const progress = new SlackProgress({
      client: { agents: { sessions: { setStatus } } },
      channel: CHANNEL,
      threadTs: THREAD_TS,
      isDM: true,
    });
    await expect(progress.start()).resolves.toBeUndefined();
    // setStatus (eager, ISW-1.1) succeeds first, then startStream fails (no
    // chat namespace), then the seed-card append also fails for the same
    // reason — all three swallowed/warned as appropriate.
    expect(setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "processing",
    });
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

  // ISW-1.1 / AC #3: a setStatus failure at start() — the new eager call —
  // must be caught and logged without preventing startStream() or the seed
  // appendTaskUpdate from proceeding. Mirrors the existing
  // finish()'s-setStatus-fallback-failure test pattern below.
  test("start() does not throw when agents.sessions.setStatus rejects, and warns — startStream()/seed card still proceed (AC #3)", async () => {
    const client = makeMockClient();
    client.agents.sessions.setStatus.mockRejectedValueOnce(
      new Error("setStatus down"),
    );
    const { progress } = makeProgress({ client });
    await expect(progress.start()).resolves.toBeUndefined();
    expect(warnCalls).toContainEqual([
      "[slack-progress] setStatus failed:",
      "setStatus down",
    ]);
    // startStream() and the seed card still ran despite the setStatus
    // failure.
    expect(client.chat.startStream).toHaveBeenCalledTimes(1);
    expect(client.chat.appendStream).toHaveBeenCalledTimes(1);
  });

  // Same as above, but the client is missing the `agents` namespace
  // entirely — the property access itself throws synchronously, which must
  // also be caught without blocking startStream()/the seed card.
  test("start() does not throw when the client has no agents namespace at all, and warns — startStream()/seed card still proceed (AC #3)", async () => {
    const { chat } = makeMockClient();
    const client = { chat } as unknown as ReturnType<typeof makeMockClient>;
    const { progress } = makeProgress({ client });
    await expect(progress.start()).resolves.toBeUndefined();
    expect(warnCalls).toContainEqual([
      "[slack-progress] setStatus failed:",
      "undefined is not an object (evaluating 'this.client.agents.sessions')",
    ]);
    expect(client.chat.startStream).toHaveBeenCalledTimes(1);
    expect(client.chat.appendStream).toHaveBeenCalledTimes(1);
  });

  test("onProgress does not throw when the client has no chat namespace, and warns", async () => {
    const progress = new SlackProgress({
      client: { agents: { sessions: { setStatus: mock(async () => {}) } } },
      channel: CHANNEL,
      threadTs: THREAD_TS,
      isDM: true,
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

  // ISW-1.1 / AC #2: a stream that never opened (streamTs stayed undefined —
  // here because the client has no chat namespace at all) must not fall
  // through to a doomed chat.stopStream call (guaranteed to fail with no
  // valid ts) — finish()'s now-unconditional agents.sessions.setStatus call
  // still runs regardless, so the "is working" indicator can still be
  // cleared.
  test("finish() calls agents.sessions.setStatus when the client has no chat namespace (stream never opened) (AC #2)", async () => {
    const setStatus = mock(async (_args: unknown) => {});
    const progress = new SlackProgress({
      client: { agents: { sessions: { setStatus } } },
      channel: CHANNEL,
      threadTs: THREAD_TS,
      isDM: true,
    });
    await expect(progress.finish()).resolves.toBeUndefined();
    expect(setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "active",
    });
  });

  // Same path, but the setStatus call itself also fails — must still not
  // throw, and warns instead of silently swallowing it.
  test("finish()'s setStatus call failure does not throw, and warns", async () => {
    const setStatus = mock(async (_args: unknown) => {
      throw new Error("setStatus down");
    });
    const progress = new SlackProgress({
      client: { agents: { sessions: { setStatus } } },
      channel: CHANNEL,
      threadTs: THREAD_TS,
      isDM: true,
    });
    await expect(progress.finish()).resolves.toBeUndefined();
    expect(warnCalls).toContainEqual([
      "[slack-progress] setStatus failed:",
      "setStatus down",
    ]);
  });

  // The client is missing the `agents` namespace entirely too — must not
  // throw synchronously on the property access either.
  test("finish()'s setStatus call does not throw when the client has no agents namespace at all, and warns", async () => {
    const progress = new SlackProgress({
      client: {},
      channel: CHANNEL,
      threadTs: THREAD_TS,
      isDM: true,
    });
    await expect(progress.finish()).resolves.toBeUndefined();
    expect(warnCalls).toContainEqual([
      "[slack-progress] setStatus failed:",
      "undefined is not an object (evaluating 'this.client.agents.sessions')",
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

// ─── streamKey() / markExternallyStopped() (AGS-1.1) ──────────────────────────
// Slack's agent_session_stopped event carries a channel + streaming_message_ts
// pair identifying the dead stream. streamKey() exposes the same "channel:ts"
// shape once startStream() has resolved, so slack.ts's closure-scoped registry
// can key a live SlackProgress instance by it. markExternallyStopped() then
// makes every further stream call (appendStream/deliverContent/reportError/
// stopStream) a no-op instead of an API call — mirroring openclaw's
// applySlackStreamStop pattern — since Slack has already discarded the stream
// server-side and any further write would fail with message_not_in_streaming_state.

describe("SlackProgress.streamKey()", () => {
  test("undefined before start() (stream not yet opened)", () => {
    const { progress } = makeProgress();
    expect(progress.streamKey()).toBeUndefined();
  });

  test("returns `channel:streamTs` once the stream has opened", async () => {
    const { progress } = makeProgress();
    await progress.start();
    expect(progress.streamKey()).toBe(`${CHANNEL}:stream.ts.1`);
  });

  test("undefined when startStream failed to open (no streamTs)", async () => {
    const client = makeMockClient();
    client.chat.startStream.mockRejectedValueOnce(new Error("stream down"));
    const { progress } = makeProgress({ client });
    await progress.start();
    expect(progress.streamKey()).toBeUndefined();
  });
});

describe("SlackProgress.getThreadTs()", () => {
  test("returns the bound thread_ts, distinct from streamKey()'s stream ts", async () => {
    const { progress } = makeProgress();
    await progress.start();
    expect(progress.getThreadTs()).toBe(THREAD_TS);
    expect(progress.streamKey()).toBe(`${CHANNEL}:stream.ts.1`);
  });
});

describe("SlackProgress.markExternallyStopped()", () => {
  test("appendStream (via onProgress) becomes a no-op after the mark", async () => {
    const client = makeMockClient();
    const { progress } = makeProgress({ client });
    await progress.start();
    client.chat.appendStream.mockClear();

    progress.markExternallyStopped();
    progress.onProgress({}, "reading");
    await Promise.resolve();
    await Promise.resolve();

    expect(client.chat.appendStream).not.toHaveBeenCalled();
  });

  test("deliverContent() becomes a no-op (returns undefined, no API call) after the mark", async () => {
    const client = makeMockClient();
    const { progress } = makeProgress({ client });
    await progress.start();
    client.chat.appendStream.mockClear();

    progress.markExternallyStopped();
    const result = await progress.deliverContent("final answer");

    expect(result).toBeUndefined();
    expect(client.chat.appendStream).not.toHaveBeenCalled();
  });

  test("reportError() becomes a no-op after the mark", async () => {
    const client = makeMockClient();
    const { progress } = makeProgress({ client });
    await progress.start();
    client.chat.appendStream.mockClear();

    progress.markExternallyStopped();
    progress.reportError();

    expect(client.chat.appendStream).not.toHaveBeenCalled();
  });

  test("finish()'s stopStream call becomes a no-op after the mark", async () => {
    const client = makeMockClient();
    const { progress } = makeProgress({ client });
    await progress.start();

    progress.markExternallyStopped();
    await progress.finish();

    expect(client.chat.stopStream).not.toHaveBeenCalled();
  });

  test("finish() still resolves cleanly (no throw) after the mark", async () => {
    const client = makeMockClient();
    const { progress } = makeProgress({ client });
    await progress.start();

    progress.markExternallyStopped();
    await expect(progress.finish()).resolves.toBeUndefined();
  });
});
