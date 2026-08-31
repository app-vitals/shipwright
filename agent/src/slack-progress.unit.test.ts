/**
 * agent/src/slack-progress.unit.test.ts
 *
 * Unit tests for SlackProgress (CFB-5.1) — the milestone-updated progress
 * message driver for Slack thread replies.
 *
 * Strategy: inject a FixedClock-backed mutable clock plus deterministic fake
 * setTimeout/clearTimeout (id-map based, mirroring chat-poller.unit.test.ts's
 * makeFakeInterval helper) so the 3s lazy-post threshold and 15s trailing-edge
 * throttle window are exercised without any real sleeps. The Slack client is
 * a plain object of mock fns — no mock.module(), no global overrides.
 */

import { describe, expect, mock, test } from "bun:test";
import type { Clock } from "./clock.ts";
import { SlackProgress } from "./slack-progress.ts";

// ─── Deterministic fake clock (mutable, advances only when told) ────────────

function makeFakeClock(startMs = 0): Clock & { advance(ms: number): void } {
  let now = startMs;
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

// ─── Deterministic fake setTimeout/clearTimeout (id-map based) ──────────────

function makeFakeTimers() {
  let nextId = 1;
  const active = new Map<number, () => void>();
  const setTimeoutFn = ((fn: () => void, _ms?: number) => {
    const id = nextId++;
    active.set(id, fn);
    return id;
    // biome-ignore lint/suspicious/noExplicitAny: matches setTimeout's overload surface
  }) as any;
  const clearTimeoutFn = ((id: number) => {
    active.delete(id);
    // biome-ignore lint/suspicious/noExplicitAny: matches clearTimeout's overload surface
  }) as any;
  /** Fires every currently-registered timer callback, removing it first. */
  const fire = () => {
    const fns = [...active.values()];
    active.clear();
    for (const fn of fns) fn();
  };
  return {
    setTimeoutFn,
    clearTimeoutFn,
    fire,
    pendingCount: () => active.size,
  };
}

// ─── Mock Slack client ────────────────────────────────────────────────────────

function makeMockClient() {
  return {
    assistant: {
      threads: {
        setStatus: mock(async (_args: unknown) => {}),
      },
    },
    chat: {
      postMessage: mock(async (_args: unknown) => ({ ts: "progress.ts.1" })),
      update: mock(async (_args: unknown) => ({ ok: true })),
      delete: mock(async (_args: unknown) => ({ ok: true })),
    },
  };
}

function makeRateLimitError(retryAfterSec: number) {
  return Object.assign(new Error("rate limited"), {
    code: "slack_webapi_rate_limited_error",
    retryAfter: retryAfterSec,
  });
}

const CHANNEL = "D123";
const THREAD_TS = "111.222";

function makeProgress(
  overrides: { client?: ReturnType<typeof makeMockClient> } = {},
) {
  const clock = makeFakeClock();
  const timers = makeFakeTimers();
  const client = overrides.client ?? makeMockClient();
  const progress = new SlackProgress({
    client,
    channel: CHANNEL,
    threadTs: THREAD_TS,
    clock,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  return { progress, client, clock, timers };
}

// ─── start() / initial status ─────────────────────────────────────────────────

describe("SlackProgress — start()", () => {
  test("announces Thinking... via assistant.threads.setStatus", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    expect(client.assistant.threads.setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "Thinking...",
    });
  });

  test("does not throw when setStatus rejects", async () => {
    const client = makeMockClient();
    client.assistant.threads.setStatus.mockRejectedValueOnce(
      new Error("api down"),
    );
    const { progress } = makeProgress({ client });
    await expect(progress.start()).resolves.toBeUndefined();
  });
});

// ─── onProgress — setStatus on every call ─────────────────────────────────────

describe("SlackProgress.onProgress — setStatus", () => {
  test("calls setStatus with the label for the phase", () => {
    const { progress, client } = makeProgress();
    progress.onProgress({}, "reading");
    expect(client.assistant.threads.setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "Reading files",
    });
  });

  test("falls back sensibly when phase is undefined", () => {
    const { progress, client } = makeProgress();
    progress.onProgress({}, undefined);
    expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);
    const call = client.assistant.threads.setStatus.mock.calls[0]?.[0] as {
      status: string;
    };
    expect(typeof call.status).toBe("string");
    expect(call.status.length).toBeGreaterThan(0);
  });

  test("setStatus failure does not throw", () => {
    const client = makeMockClient();
    client.assistant.threads.setStatus.mockRejectedValueOnce(new Error("boom"));
    const { progress } = makeProgress({ client });
    expect(() => progress.onProgress({}, "editing")).not.toThrow();
  });
});

// ─── Lazy first post ───────────────────────────────────────────────────────────

describe("SlackProgress — lazy first post", () => {
  test("posts nothing before 3s even with a milestone", () => {
    const { progress, client } = makeProgress();
    progress.onProgress({}, "reading");
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("posts nothing at exactly under 3s elapsed", () => {
    const { progress, client, clock } = makeProgress();
    clock.advance(2999);
    progress.onProgress({}, "reading");
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("posts once 3s have elapsed AND a milestone exists", () => {
    const { progress, client, clock } = makeProgress();
    clock.advance(3000);
    progress.onProgress({}, "reading");
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const call = client.chat.postMessage.mock.calls[0]?.[0] as {
      channel: string;
      thread_ts: string;
      text: string;
    };
    expect(call.channel).toBe(CHANNEL);
    expect(call.thread_ts).toBe(THREAD_TS);
    expect(call.text).toContain("Reading files");
  });

  test("does not double-post on a second call within the same tick", () => {
    const { progress, client, clock } = makeProgress();
    clock.advance(3000);
    progress.onProgress({}, "reading");
    progress.onProgress({}, "reading");
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  test("remembers the posted message ts for later update/delete", async () => {
    const { progress, client, clock, timers } = makeProgress();
    clock.advance(3000);
    progress.onProgress({}, "reading");
    // Let the lazy postMessage's promise land before the next call, so
    // messageTs is set and the follow-up milestone goes through the
    // throttled-update path rather than colliding with the in-flight post.
    await Promise.resolve();
    await Promise.resolve();
    // A subsequent milestone within the throttle window should target
    // chat.update with the remembered ts once the window flushes.
    progress.onProgress({}, "editing");
    timers.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ ts: "progress.ts.1", channel: CHANNEL }),
    );
  });
});

// ─── Sub-3s completion (AC #4) ─────────────────────────────────────────────────

describe("SlackProgress — sub-3s completion (AC #4)", () => {
  test("a run that finishes before 3s posts no progress message at all", async () => {
    const { progress, client, clock } = makeProgress();
    progress.onProgress({}, "reading");
    clock.advance(500);
    progress.onProgress({}, "editing");
    await progress.finish();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("finish() is a no-op beyond clearing status when nothing was posted", async () => {
    const { progress, client } = makeProgress();
    await progress.finish();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(client.chat.delete).not.toHaveBeenCalled();
    expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "",
    });
  });
});

// ─── Trailing-edge 15s throttle ────────────────────────────────────────────────

describe("SlackProgress — trailing-edge 15s throttle", () => {
  test("does not chat.update immediately after the first post", async () => {
    const { progress, client, clock } = makeProgress();
    clock.advance(3000);
    progress.onProgress({}, "reading");
    await Promise.resolve();
    await Promise.resolve();
    client.chat.update.mockClear();
    progress.onProgress({}, "editing");
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  test("coalesces rapid calls within the window to the newest milestone", async () => {
    const { progress, client, clock, timers } = makeProgress();
    clock.advance(3000);
    progress.onProgress({}, "reading"); // triggers lazy post
    await Promise.resolve();
    await Promise.resolve();
    progress.onProgress({}, "editing"); // starts throttle timer
    progress.onProgress({}, "running"); // overwrites pending payload
    progress.onProgress({}, "writing"); // overwrites again — newest wins

    expect(client.chat.update).not.toHaveBeenCalled();
    timers.fire();
    await Promise.resolve();
    await Promise.resolve();

    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const call = client.chat.update.mock.calls[0]?.[0] as {
      ts: string;
      text: string;
    };
    expect(call.ts).toBe("progress.ts.1");
    expect(call.text).toContain("Writing a response");
  });

  test("a call after the window flushes starts a fresh 15s window", async () => {
    const { progress, client, clock, timers } = makeProgress();
    clock.advance(3000);
    progress.onProgress({}, "reading"); // lazy post
    await Promise.resolve();
    await Promise.resolve();
    progress.onProgress({}, "editing"); // starts window #1
    timers.fire(); // flushes "editing"
    await Promise.resolve();
    await Promise.resolve();
    expect(client.chat.update).toHaveBeenCalledTimes(1);

    progress.onProgress({}, "running"); // starts window #2
    expect(client.chat.update).toHaveBeenCalledTimes(1); // not yet flushed
    timers.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.chat.update).toHaveBeenCalledTimes(2);
    const secondCall = client.chat.update.mock.calls[1]?.[0] as {
      text: string;
    };
    expect(secondCall.text).toContain("Running commands");
  });

  test("only one throttle timer is pending at a time", async () => {
    const { progress, clock, timers } = makeProgress();
    clock.advance(3000);
    progress.onProgress({}, "reading");
    await Promise.resolve();
    await Promise.resolve();
    progress.onProgress({}, "editing");
    progress.onProgress({}, "running");
    expect(timers.pendingCount()).toBe(1);
  });
});

// ─── 429 Retry-After backoff ────────────────────────────────────────────────────

describe("SlackProgress — 429 Retry-After backoff", () => {
  test("a 429 on the lazy post suppresses further postMessage until retryAfter elapses", async () => {
    const client = makeMockClient();
    client.chat.postMessage.mockRejectedValueOnce(makeRateLimitError(30));
    const { progress, clock } = makeProgress({ client });

    clock.advance(3000);
    progress.onProgress({}, "reading");
    // let the rejected promise settle
    await Promise.resolve();
    await Promise.resolve();

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);

    // Still within the 30s backoff window — no further postMessage attempts.
    clock.advance(10_000);
    progress.onProgress({}, "editing");
    await Promise.resolve();
    await Promise.resolve();
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  test("postMessage resumes once retryAfter seconds have elapsed", async () => {
    const client = makeMockClient();
    client.chat.postMessage.mockRejectedValueOnce(makeRateLimitError(5));
    const { progress, clock } = makeProgress({ client });

    clock.advance(3000);
    progress.onProgress({}, "reading");
    await Promise.resolve();
    await Promise.resolve();
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);

    // Past the 5s backoff window.
    clock.advance(5001);
    progress.onProgress({}, "editing");
    await Promise.resolve();
    await Promise.resolve();
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  test("a 429 on chat.update suppresses further chat.update until retryAfter elapses, latest milestone still tracked", async () => {
    const client = makeMockClient();
    const { progress, clock, timers } = makeProgress({ client });

    clock.advance(3000);
    progress.onProgress({}, "reading"); // lazy post succeeds
    await Promise.resolve();
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);

    client.chat.update.mockRejectedValueOnce(makeRateLimitError(20));
    progress.onProgress({}, "editing"); // starts throttle window
    timers.fire(); // flush -> rejects with 429
    await Promise.resolve();
    await Promise.resolve();
    expect(client.chat.update).toHaveBeenCalledTimes(1);

    // Still backing off — further progress updates the pending state but
    // makes no further chat.update call while suppressed.
    progress.onProgress({}, "running");
    timers.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.chat.update).toHaveBeenCalledTimes(1);

    // Once the backoff window clears, the next progress call's flush should
    // go through with the latest milestone.
    clock.advance(20_001);
    progress.onProgress({}, "writing");
    timers.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.chat.update).toHaveBeenCalledTimes(2);
    const secondCall = client.chat.update.mock.calls[1]?.[0] as {
      text: string;
    };
    expect(secondCall.text).toContain("Writing a response");
  });

  test("does not throw on 429 — swallowed like every other Slack API failure", async () => {
    const client = makeMockClient();
    client.chat.postMessage.mockRejectedValueOnce(makeRateLimitError(1));
    const { progress, clock } = makeProgress({ client });
    clock.advance(3000);
    expect(() => progress.onProgress({}, "reading")).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});

// ─── finish() ──────────────────────────────────────────────────────────────────

describe("SlackProgress — finish()", () => {
  test("deletes the progress message when one was posted", async () => {
    const { progress, client, clock } = makeProgress();
    clock.advance(3000);
    progress.onProgress({}, "reading");
    await progress.finish();
    expect(client.chat.delete).toHaveBeenCalledWith(
      expect.objectContaining({ channel: CHANNEL, ts: "progress.ts.1" }),
    );
  });

  test("clears the AI-app status", async () => {
    const { progress, client, clock } = makeProgress();
    clock.advance(3000);
    progress.onProgress({}, "reading");
    await progress.finish();
    expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "",
    });
  });

  test("cancels a pending throttle timer", async () => {
    const { progress, clock, timers } = makeProgress();
    clock.advance(3000);
    progress.onProgress({}, "reading");
    await Promise.resolve();
    await Promise.resolve();
    progress.onProgress({}, "editing"); // starts a throttle timer
    expect(timers.pendingCount()).toBe(1);
    await progress.finish();
    expect(timers.pendingCount()).toBe(0);
  });

  test("falls back to a collapsed chat.update when chat.delete fails", async () => {
    const client = makeMockClient();
    client.chat.delete.mockRejectedValueOnce(new Error("missing_scope"));
    const { progress, clock } = makeProgress({ client });
    clock.advance(3000);
    progress.onProgress({}, "reading");
    await progress.finish();
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ channel: CHANNEL, ts: "progress.ts.1" }),
    );
  });

  test("does not throw when chat.delete AND the chat.update fallback both fail", async () => {
    const client = makeMockClient();
    client.chat.delete.mockRejectedValueOnce(new Error("missing_scope"));
    client.chat.update.mockRejectedValueOnce(new Error("also broken"));
    const { progress, clock } = makeProgress({ client });
    clock.advance(3000);
    progress.onProgress({}, "reading");
    await expect(progress.finish()).resolves.toBeUndefined();
  });

  test("does not call chat.postMessage/update/delete when no progress message was ever posted", async () => {
    const { progress, client } = makeProgress();
    // No onProgress calls at all — sub-3s / no milestone case.
    await progress.finish();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(client.chat.delete).not.toHaveBeenCalled();
  });

  test("does not throw when setStatus('') fails", async () => {
    const client = makeMockClient();
    client.assistant.threads.setStatus.mockRejectedValueOnce(
      new Error("api down"),
    );
    const { progress } = makeProgress({ client });
    await expect(progress.finish()).resolves.toBeUndefined();
  });
});

// ─── Everything .catch(()=>{}) — progress never breaks a reply ───────────────

describe("SlackProgress — failures never throw", () => {
  test("onProgress never throws even if every Slack call rejects", async () => {
    const client = makeMockClient();
    client.assistant.threads.setStatus.mockRejectedValue(new Error("x"));
    client.chat.postMessage.mockRejectedValue(new Error("y"));
    client.chat.update.mockRejectedValue(new Error("z"));
    const { progress, clock, timers } = makeProgress({ client });

    expect(() => progress.onProgress({}, "reading")).not.toThrow();
    clock.advance(3000);
    expect(() => progress.onProgress({}, "reading")).not.toThrow();
    expect(() => progress.onProgress({}, "editing")).not.toThrow();
    expect(() => timers.fire()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  test("finish() never throws even if every Slack call rejects", async () => {
    const client = makeMockClient();
    client.assistant.threads.setStatus.mockRejectedValue(new Error("x"));
    client.chat.postMessage.mockRejectedValue(new Error("y"));
    client.chat.delete.mockRejectedValue(new Error("z"));
    client.chat.update.mockRejectedValue(new Error("w"));
    const { progress, clock } = makeProgress({ client });
    clock.advance(3000);
    progress.onProgress({}, "reading");
    await expect(progress.finish()).resolves.toBeUndefined();
  });
});
