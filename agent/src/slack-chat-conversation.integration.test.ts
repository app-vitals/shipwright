/**
 * Integration coverage for the Slack chat conversation journey (T-027).
 *
 * Scope note: the task description's "chat-service thread -> agent claims"
 * phrasing does not correspond to any real code path in this repo —
 * createSlackApp() (agent/src/slack.ts) never touches ChatServiceClient, and
 * chat-poller.ts (the chat-service flow) never touches Slack/Bolt/WebClient.
 * This suite instead exercises the REAL, buildable journey: a multi-turn
 * Slack conversation flowing end-to-end through createSlackApp — incoming
 * Bolt message/app_mention event -> injected Claude runner -> reply posted
 * via the mocked WebClient (say / client.chat.postMessage) -- verifying
 * session continuity across turns via sessions.ts's threadKey +
 * getSessionFn wiring.
 *
 * Strategy mirrors slack.integration.test.ts: inject all dependencies via
 * createSlackApp's params (MockApp Bolt factory + mocked WebClient-shaped
 * client). No mock.module(), no real Bolt socket, no real HTTP.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ModelUsage, TokenUsage } from "./claude.ts";
import { threadKey } from "./sessions.ts";
import { createSlackApp as _createSlackApp } from "./slack.ts";

// ─── Mock runner ────────────────────────────────────────────────────────────

const mockRunClaude = mock(
  async (
    _msg: string,
    _key?: string,
  ): Promise<{
    result: string;
    sessionId?: string;
    usage?: TokenUsage;
    totalCostUsd?: number;
    modelUsage?: ModelUsage;
  }> => ({ result: "Claude response text" }),
);

const identityFormatter = (text: string): string => text;

// ─── Test slack config ──────────────────────────────────────────────────────

const mockSlackConfig = {
  botToken: "xoxb-test-token",
  appToken: "xapp-test-token",
  signingSecret: "test-secret",
};

// ─── MockApp — captures registered handlers (same pattern as slack.integration.test.ts) ───

type HandlerFn = (...args: unknown[]) => Promise<void>;

let capturedMessageHandler: HandlerFn | null = null;
let capturedMentionHandler: HandlerFn | null = null;

class MockApp {
  constructor(_args: Record<string, unknown>) {
    capturedMessageHandler = null;
    capturedMentionHandler = null;
  }

  message(handler: HandlerFn) {
    capturedMessageHandler = handler;
  }

  event(type: string, handler: HandlerFn) {
    if (type === "app_mention") capturedMentionHandler = handler;
  }
}

// Wrap with test deps — mirrors the createSlackApp() wrapper in
// slack.integration.test.ts, but only exposes the params this suite needs.
function createSlackApp(getSessionFn: (key: string) => string | undefined) {
  return _createSlackApp(
    mockRunClaude,
    identityFormatter,
    threadKey,
    // biome-ignore lint/suspicious/noExplicitAny: mock factory for tests
    (cfg) => new MockApp(cfg as Record<string, unknown>) as any,
    mockSlackConfig,
    undefined, // tracker
    async () => null, // fileDownloaderFn
    {}, // voiceConfig
    async () => null, // transcribeAudioFn
    async () => null, // synthesizeSpeechFn
    async (userId: string) => userId, // resolveUserFn
    "UBOT123", // botUserId
    async () => ({ messages: [] }), // conversationsRepliesFn
    getSessionFn,
  );
}

// ─── Mock client helpers (same shape as slack.integration.test.ts) ─────────

function makeMockClient() {
  return {
    assistant: {
      threads: {
        setStatus: mock(async (_args: unknown) => {}),
      },
    },
    chat: {
      postMessage: mock(async (_args: unknown) => ({ ts: "posted.ts.1" })),
    },
  };
}

function makeSay(replyTs = "reply.ts.1") {
  return mock(async (_args: unknown) => ({ ts: replyTs }));
}

describe("Slack chat conversation journey — DM multi-turn continuity", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
  });

  test("turn 1 (no prior session) then turn 2 (established session) both reach Claude and both post replies, threaded on the same sessionKey", async () => {
    // Turn 1: brand-new DM — no session established yet.
    const noSession = mock((_key: string) => undefined);
    createSlackApp(noSession);

    const client1 = makeMockClient();
    const say1 = makeSay("reply.ts.turn1");
    mockRunClaude.mockResolvedValueOnce({
      result: "Hi! How can I help?",
      sessionId: "sess-established-1",
    });

    await capturedMessageHandler?.({
      message: {
        channel: "D100",
        ts: "1000.001",
        text: "Hey, can you look into the failing build?",
        channel_type: "im",
        user: "U1",
      },
      say: say1,
      client: client1,
    });

    // Turn 1 assertions: runner invoked with the DM's own sessionKey (thread
    // root = channel:ts, since no thread_ts on the first message), reply posted.
    expect(mockRunClaude).toHaveBeenCalledTimes(1);
    expect(mockRunClaude).toHaveBeenCalledWith(
      "[U1]: Hey, can you look into the failing build?",
      "D100:1000.001",
    );
    expect(say1).toHaveBeenCalledWith({
      text: "Hi! How can I help?",
      thread_ts: "1000.001",
    });

    // Turn 2: a follow-up DM in the SAME channel/thread. Simulate that the
    // session from turn 1 is now "established" — getSessionFn now returns the
    // fixed session id for this thread's key, proving continuity is driven by
    // the injected session lookup, not implicit in-process state.
    const establishedKey = threadKey("D100", "1000.001");
    const establishedSession = mock((key: string) =>
      key === establishedKey ? "sess-established-1" : undefined,
    );
    createSlackApp(establishedSession);

    const client2 = makeMockClient();
    const say2 = makeSay("reply.ts.turn2");
    mockRunClaude.mockResolvedValueOnce({
      result: "Found it — the linter step is timing out.",
      sessionId: "sess-established-1",
    });

    await capturedMessageHandler?.({
      message: {
        channel: "D100",
        ts: "1000.002",
        thread_ts: "1000.001", // Slack threads DM follow-ups under the root ts
        text: "Any update?",
        channel_type: "im",
        user: "U1",
      },
      say: say2,
      client: client2,
    });

    // Turn 2 assertions: runner invoked with the SAME sessionKey as turn 1
    // (continuity), and the reply is posted back threaded on the same root ts.
    expect(mockRunClaude).toHaveBeenCalledTimes(2);
    expect(mockRunClaude).toHaveBeenLastCalledWith(
      "[U1]: Any update?",
      establishedKey,
    );
    expect(say2).toHaveBeenCalledWith({
      text: "Found it — the linter step is timing out.",
      thread_ts: "1000.001",
    });

    // Sanity: if session continuity were broken (e.g. sessionKey recomputed
    // per-turn without reference to the established thread root), turn 2's
    // sessionKey would differ from turn 1's. Confirm they match exactly.
    const turn1SessionKey = mockRunClaude.mock.calls[0][1];
    const turn2SessionKey = mockRunClaude.mock.calls[1][1];
    expect(turn2SessionKey).toBe(turn1SessionKey);
  });
});

describe("Slack chat conversation journey — channel app_mention thread continuity", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
  });

  test("initial @mention (no session) then a plain follow-up message in the same thread (established session) both reach Claude on the mention's threadKey", async () => {
    // Turn 1: an @mention in a channel starts a new thread — no session yet.
    const noSession = mock((_key: string) => undefined);
    createSlackApp(noSession);

    const client1 = makeMockClient();
    const say1 = makeSay("mention.reply.ts");
    mockRunClaude.mockResolvedValueOnce({
      result: "On it — checking the deploy logs.",
      sessionId: "sess-thread-77",
    });

    await capturedMentionHandler?.({
      event: {
        text: "<@UBOT123> can you check the deploy?",
        channel: "C500",
        ts: "2000.001",
        user: "U2",
      },
      say: say1,
      client: client1,
    });

    const mentionKey = threadKey("C500", "2000.001");
    expect(mockRunClaude).toHaveBeenCalledTimes(1);
    expect(mockRunClaude).toHaveBeenCalledWith(
      "[U2]: <@UBOT123> can you check the deploy?",
      mentionKey,
    );
    expect(say1).toHaveBeenCalledWith({
      text: "On it — checking the deploy logs.",
      thread_ts: "2000.001",
    });

    // Turn 2: a plain (non-@mention) follow-up posted inside that same thread.
    // The channel message handler only routes thread replies when a session
    // is already established for that thread — simulate turn 1 having
    // established it, via getSessionFn now resolving the mention's threadKey.
    const establishedSession = mock((key: string) =>
      key === mentionKey ? "sess-thread-77" : undefined,
    );
    createSlackApp(establishedSession);

    const client2 = makeMockClient();
    const say2 = makeSay("followup.reply.ts");
    mockRunClaude.mockResolvedValueOnce({
      result: "Deploy looks healthy now.",
      sessionId: "sess-thread-77",
    });

    await capturedMessageHandler?.({
      message: {
        channel: "C500",
        ts: "2000.002",
        thread_ts: "2000.001",
        text: "thanks, any update?",
        channel_type: "channel",
        user: "U2",
      },
      say: say2,
      client: client2,
    });

    expect(mockRunClaude).toHaveBeenCalledTimes(2);
    expect(mockRunClaude).toHaveBeenLastCalledWith(
      "[Thread message — respond normally, or use [silent] if no response is needed]\n[U2]: thanks, any update?",
      mentionKey,
    );
    expect(say2).toHaveBeenCalledWith({
      text: "Deploy looks healthy now.",
      thread_ts: "2000.001",
    });

    // Continuity check: both turns keyed identically off the mention's thread root.
    const turn1SessionKey = mockRunClaude.mock.calls[0][1];
    const turn2SessionKey = mockRunClaude.mock.calls[1][1];
    expect(turn2SessionKey).toBe(turn1SessionKey);
    expect(turn2SessionKey).toBe(mentionKey);
  });

  test("a follow-up @mention in an already-established thread is dropped — the channel message handler owns it, avoiding a double response", async () => {
    // Once a thread has a session, a redundant @mention on a later message in
    // that same thread must NOT also trigger a second Claude call/reply —
    // the message handler already covers thread continuity.
    const establishedSession = mock((_key: string) => "sess-thread-77");
    createSlackApp(establishedSession);

    const client = makeMockClient();
    const say = makeSay();

    await capturedMentionHandler?.({
      event: {
        text: "<@UBOT123> one more thing",
        channel: "C500",
        ts: "2000.003",
        thread_ts: "2000.001",
        user: "U2",
      },
      say,
      client,
    });

    expect(mockRunClaude).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });
});
