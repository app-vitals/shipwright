/**
 * agent/src/slack-progress.unit.test.ts
 *
 * Unit tests for SlackProgress — the status-only progress driver for Slack
 * thread replies. Covers start()/finish() calling `agents.sessions.setStatus`
 * with the fixed lifecycle values ("processing" / "active"), that onProgress()
 * no longer drives any Slack API call (the new API has no per-phase text
 * slot), and that every Slack API failure is swallowed rather than thrown.
 *
 * The mock Slack client is a plain object of mock fns — no mock.module(), no
 * global overrides. No Clock injection is needed: SlackProgress does no
 * time-based scheduling.
 */

import { describe, expect, mock, test } from "bun:test";
import { SlackProgress } from "./slack-progress.ts";

// ─── Mock Slack client ────────────────────────────────────────────────────────

function makeMockClient() {
  return {
    agents: {
      sessions: {
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
  test("sets status to processing", async () => {
    const { progress, client } = makeProgress();
    await progress.start();
    expect(client.agents.sessions.setStatus).toHaveBeenCalledWith({
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      status: "processing",
    });
  });
});

// ─── onProgress is a no-op for phase transitions ───────────────────────────────

describe("SlackProgress.onProgress — phase transitions", () => {
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
  test("start() does not throw when setStatus rejects", async () => {
    const client = makeMockClient();
    client.agents.sessions.setStatus.mockRejectedValueOnce(
      new Error("api down"),
    );
    const { progress } = makeProgress({ client });
    await expect(progress.start()).resolves.toBeUndefined();
  });

  test("finish() does not throw when setStatus rejects", async () => {
    const client = makeMockClient();
    client.agents.sessions.setStatus.mockRejectedValueOnce(
      new Error("api down"),
    );
    const { progress } = makeProgress({ client });
    await expect(progress.finish()).resolves.toBeUndefined();
  });
});
