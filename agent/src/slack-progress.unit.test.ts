/**
 * agent/src/slack-progress.unit.test.ts
 *
 * Unit tests for SlackProgress — the status-only progress driver for Slack
 * thread replies. Covers start()/onProgress()/finish() calling
 * `assistant.threads.setStatus`, the phase-stomping bug fix (a usage-only
 * onProgress tick — phase === undefined — must leave the last real milestone
 * label in place rather than resetting it), and that every Slack API failure
 * is swallowed rather than thrown.
 *
 * The mock Slack client is a plain object of mock fns — no mock.module(), no
 * global overrides. No Clock injection is needed: SlackProgress no longer
 * does any time-based scheduling.
 */

import { describe, expect, mock, test } from "bun:test";
import { SlackProgress } from "./slack-progress.ts";

// ─── Mock Slack client ────────────────────────────────────────────────────────

function makeMockClient() {
  return {
    assistant: {
      threads: {
        setStatus: mock(async (_args: unknown) => {}),
      },
    },
  };
}

const CHANNEL = "D123";
const THREAD_TS = "111.222";

function makeProgress(
  overrides: { client?: ReturnType<typeof makeMockClient> } = {},
) {
  const client = overrides.client ?? makeMockClient();
  const progress = new SlackProgress({
    client,
    channel: CHANNEL,
    threadTs: THREAD_TS,
  });
  return { progress, client };
}

// ─── status-on-start ───────────────────────────────────────────────────────────

describe("SlackProgress — start()", () => {
  test("sets status to Thinking...", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    expect(client.assistant.threads.setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "Thinking...",
    });
  });
});

// ─── status-updates-on-real-phase ───────────────────────────────────────────────

describe("SlackProgress.onProgress — real phase", () => {
  test("calls setStatus with the label for the phase", () => {
    const { progress, client } = makeProgress();
    progress.onProgress({}, "reading");
    expect(client.assistant.threads.setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "Reading files",
    });
  });
});

// ─── status-untouched-on-usage-only-tick (the bug fix) ─────────────────────────

describe("SlackProgress.onProgress — usage-only tick (phase undefined)", () => {
  test("does not call setStatus at all when phase is undefined", () => {
    const { progress, client } = makeProgress();
    progress.onProgress({}, undefined);
    expect(client.assistant.threads.setStatus).not.toHaveBeenCalled();
  });

  test("leaves the last real milestone label in place instead of resetting it", () => {
    const { progress, client } = makeProgress();
    progress.onProgress({}, "reading");
    expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "Reading files",
    });

    // A usage-only tick (no phase) immediately follows, as happens in
    // claude.ts for most stream lines — this must NOT stomp the real
    // milestone label with a generic default.
    progress.onProgress({}, undefined);
    expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "Reading files",
    });
    expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);
  });
});

// ─── status-cleared-on-finish ───────────────────────────────────────────────────

describe("SlackProgress — finish()", () => {
  test("clears status to empty string", async () => {
    const { progress, client } = makeProgress();
    await progress.finish();
    expect(client.assistant.threads.setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "",
    });
  });
});

// ─── errors-swallowed ────────────────────────────────────────────────────────────

describe("SlackProgress — errors swallowed", () => {
  test("start() does not throw when setStatus rejects", async () => {
    const client = makeMockClient();
    client.assistant.threads.setStatus.mockRejectedValueOnce(
      new Error("api down"),
    );
    const { progress } = makeProgress({ client });
    await expect(progress.start()).resolves.toBeUndefined();
  });

  test("onProgress does not throw when setStatus rejects", () => {
    const client = makeMockClient();
    client.assistant.threads.setStatus.mockRejectedValueOnce(new Error("boom"));
    const { progress } = makeProgress({ client });
    expect(() => progress.onProgress({}, "editing")).not.toThrow();
  });

  test("finish() does not throw when setStatus rejects", async () => {
    const client = makeMockClient();
    client.assistant.threads.setStatus.mockRejectedValueOnce(
      new Error("api down"),
    );
    const { progress } = makeProgress({ client });
    await expect(progress.finish()).resolves.toBeUndefined();
  });
});
