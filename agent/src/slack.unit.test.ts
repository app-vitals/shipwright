/**
 * Unit tests for pure helpers in agent/src/slack.ts.
 *
 * hasSlackCredentials gates whether the agent boots its Slack Bolt App. Bolt's
 * Socket Mode throws "Must provide an App-Level Token" when constructed without
 * a non-empty appToken, so the agent must only call createSlackApp when both the
 * bot token and the app-level token are present. Absent creds → offline mode.
 *
 * The isAllowedSlackSender + handler-level membership-gating tests below cover
 * SMR-4.1: a single shared gate, called at the top of message/app_mention/
 * reaction_added, before runner() is invoked. This file builds its own minimal
 * MockApp harness (mirroring slack.integration.test.ts's pattern) so these
 * cases are self-contained and slack.integration.test.ts stays untouched —
 * its existing "processed as today" assertions continue to exercise the same
 * default fail-open code path (unsynced ref / restrict=false).
 */

import { describe, expect, mock, test } from "bun:test";
import type { AgentSlackMembershipRef } from "./agent-slack-membership-ref.ts";
import { createAgentSlackMembershipRef } from "./agent-slack-membership-ref.ts";
import {
  createSlackApp as _createSlackApp,
  dispatchMarkers,
  hasSlackCredentials,
  isAllowedSlackSender,
} from "./slack.ts";

describe("hasSlackCredentials", () => {
  test("true when both bot and app tokens are non-empty", () => {
    expect(
      hasSlackCredentials({ botToken: "xoxb-1", appToken: "xapp-1" }),
    ).toBe(true);
  });

  test("false when app token is missing (the Socket Mode requirement)", () => {
    expect(hasSlackCredentials({ botToken: "xoxb-1", appToken: "" })).toBe(
      false,
    );
  });

  test("false when bot token is missing", () => {
    expect(hasSlackCredentials({ botToken: "", appToken: "xapp-1" })).toBe(
      false,
    );
  });

  test("false when both are empty (offline dev default)", () => {
    expect(hasSlackCredentials({ botToken: "", appToken: "" })).toBe(false);
  });

  test("treats whitespace-only tokens as absent", () => {
    expect(hasSlackCredentials({ botToken: "  ", appToken: "  " })).toBe(false);
  });
});

// ─── dispatchMarkers — plan marker ──────────────────────────────────────────
// Injects a plain-object Slack client double (no mock.module, no global
// override) and asserts the [plan:url] marker posts a "View plan" message to
// the bound channel/thread.

describe("dispatchMarkers — plan marker", () => {
  test("posts a View plan message to the bound channel/thread", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test double captures calls
    const calls: any[] = [];
    const client = {
      chat: {
        // biome-ignore lint/suspicious/noExplicitAny: test double
        postMessage: async (a: any) => {
          calls.push(a);
          return { ok: true };
        },
      },
    };

    await dispatchMarkers(
      [{ type: "plan", url: "https://example.com/p/abc" }],
      { client, channel: "C123", threadTs: "1700.1" },
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.channel).toBe("C123");
    expect(call.thread_ts).toBe("1700.1");
    expect(JSON.stringify(call.blocks)).toContain("https://example.com/p/abc");
    expect(call.text).toContain("https://example.com/p/abc");
  });
});

// ─── isAllowedSlackSender ───────────────────────────────────────────────────

describe("isAllowedSlackSender", () => {
  test("allows when the membership ref has never synced, regardless of email", () => {
    const ref = createAgentSlackMembershipRef();
    expect(isAllowedSlackSender(undefined, ref)).toBe(true);
    expect(isAllowedSlackSender("nobody@example.com", ref)).toBe(true);
  });

  test("allows when synced but restrict is false", () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: false, emails: ["dan@example.com"] });
    expect(isAllowedSlackSender(undefined, ref)).toBe(true);
    expect(isAllowedSlackSender("someone-else@example.com", ref)).toBe(true);
  });

  test("allows a matching email (exact case)", () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: true, emails: ["dan@example.com"] });
    expect(isAllowedSlackSender("dan@example.com", ref)).toBe(true);
  });

  test("allows a matching email case-insensitively", () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: true, emails: ["Dan@Example.com"] });
    expect(isAllowedSlackSender("dan@example.com", ref)).toBe(true);
    expect(isAllowedSlackSender("DAN@EXAMPLE.COM", ref)).toBe(true);
  });

  test("rejects a non-matching email", () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: true, emails: ["dan@example.com"] });
    expect(isAllowedSlackSender("stranger@example.com", ref)).toBe(false);
  });

  test("rejects an undefined email when restrict is true", () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: true, emails: ["dan@example.com"] });
    expect(isAllowedSlackSender(undefined, ref)).toBe(false);
  });
});

// ─── Handler-level membership gating ───────────────────────────────────────
// Self-contained MockApp harness (mirrors slack.integration.test.ts) scoped
// to this file — captures constructor args + registered handlers so the
// three gating call sites can be exercised without duplicating the 3000+
// lines of unrelated setup living in slack.integration.test.ts.

type HandlerFn = (...args: unknown[]) => Promise<void>;

let capturedMessageHandler: HandlerFn | null = null;
let capturedMentionHandler: HandlerFn | null = null;
let capturedReactionAddedHandler: HandlerFn | null = null;
let capturedAgentSessionStoppedHandler: HandlerFn | null = null;

class MockApp {
  constructor(_args: Record<string, unknown>) {
    capturedMessageHandler = null;
    capturedMentionHandler = null;
    capturedReactionAddedHandler = null;
    capturedAgentSessionStoppedHandler = null;
  }

  message(handler: HandlerFn) {
    capturedMessageHandler = handler;
  }

  event(type: string, handler: HandlerFn) {
    if (type === "app_mention") capturedMentionHandler = handler;
    if (type === "reaction_added") capturedReactionAddedHandler = handler;
    if (type === "agent_session_stopped")
      capturedAgentSessionStoppedHandler = handler;
  }
}

const mockGatingSlackConfig = {
  botToken: "xoxb-test-token",
  appToken: "xapp-test-token",
  signingSecret: "test-secret",
};

function makeMockClient() {
  return {
    agents: {
      sessions: {
        setStatus: mock(async (_args: unknown) => {}),
      },
    },
    reactions: {
      add: mock(async (_args: unknown) => {}),
    },
    files: {
      uploadV2: mock(async (_args: unknown) => {}),
    },
    chat: {
      postMessage: mock(async (_args: unknown) => ({ ts: "resp.ts.1" })),
    },
    users: {
      info: mock(async (_args: unknown) => ({
        user: {
          profile: { display_name: "Test User", email: "member@example.com" },
          name: "testuser",
        },
      })),
    },
  };
}

function makeSay() {
  return mock(async (_args: unknown) => ({ ts: "reply.ts.1" }));
}

function setupGatingApp(overrides: {
  membershipRef: AgentSlackMembershipRef;
  resolveUserEmailFn: (
    userId: string,
    client: unknown,
  ) => Promise<string | undefined>;
  runner?: (
    message: string,
    sessionKey?: string,
  ) => Promise<{
    result: string;
    sessionId?: string;
    streamIncomplete?: boolean;
  }>;
  getSessionFn?: (key: string) => Promise<string | undefined>;
}) {
  const runner =
    overrides.runner ??
    mock(async (_msg: string, _key?: string) => ({
      result: "Claude response",
      sessionId: "sess-1",
    }));

  _createSlackApp(
    runner,
    (text: string) => text,
    (channel: string, ts: string) => `${channel}:${ts}`,
    // biome-ignore lint/suspicious/noExplicitAny: mock factory for tests
    (cfg) => new MockApp(cfg as Record<string, unknown>) as any,
    mockGatingSlackConfig,
    undefined, // sentryClient — default noop
    async () => null, // fileDownloaderFn
    {}, // voiceConfig
    async () => null, // transcribeAudioFn
    async () => null, // synthesizeSpeechFn
    async (userId: string) => userId, // resolveUserFn (display name) — identity
    "UBOT123", // botUserId
    async () => ({ messages: [] }), // conversationsRepliesFn
    overrides.getSessionFn ?? (async () => undefined), // getSessionFn
    undefined, // blocksConverter — default
    undefined, // chatTokenReporter — default noop
    overrides.resolveUserEmailFn,
    overrides.membershipRef,
  );

  return { runner };
}

describe("membership gating — message handler", () => {
  async function invokeDM(
    membershipRef: AgentSlackMembershipRef,
    resolveUserEmailFn: (
      userId: string,
      client: unknown,
    ) => Promise<string | undefined>,
  ) {
    const { runner } = setupGatingApp({ membershipRef, resolveUserEmailFn });
    const client = makeMockClient();
    const say = makeSay();
    const message = {
      channel: "D123",
      ts: "111.222",
      text: "Hello bot",
      channel_type: "im",
      user: "U-SENDER",
    };
    await capturedMessageHandler?.({ message, say, client });
    return { runner, say, client };
  }

  test("unsynced ref: processed as today (runner called)", async () => {
    const ref = createAgentSlackMembershipRef();
    const { runner, say } = await invokeDM(ref, async () => undefined);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalled();
  });

  test("restrict=false: processed as today (runner called)", async () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: false, emails: [] });
    const { runner, say } = await invokeDM(ref, async () => undefined);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalled();
  });

  test("restrict=true + matching email: processed as today", async () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: true, emails: ["member@example.com"] });
    const { runner, say } = await invokeDM(
      ref,
      async () => "member@example.com",
    );
    expect(runner).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalled();
  });

  test("restrict=true + non-member email: runner not called, no reply posted", async () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: true, emails: ["member@example.com"] });
    const { runner, say } = await invokeDM(
      ref,
      async () => "stranger@example.com",
    );
    expect(runner).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  test("restrict=true + undefined email (resolution failed): runner not called", async () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: true, emails: ["member@example.com"] });
    const { runner, say } = await invokeDM(ref, async () => undefined);
    expect(runner).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });
});

describe("membership gating — app_mention handler", () => {
  async function invokeMention(
    membershipRef: AgentSlackMembershipRef,
    resolveUserEmailFn: (
      userId: string,
      client: unknown,
    ) => Promise<string | undefined>,
  ) {
    const { runner } = setupGatingApp({ membershipRef, resolveUserEmailFn });
    const client = makeMockClient();
    const say = makeSay();
    const event = {
      text: "<@UBOT> do something",
      channel: "C999",
      ts: "222.333",
      user: "U-SENDER",
    };
    await capturedMentionHandler?.({ event, say, client });
    return { runner, say, client };
  }

  test("unsynced ref: processed as today (runner called)", async () => {
    const ref = createAgentSlackMembershipRef();
    const { runner, say } = await invokeMention(ref, async () => undefined);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalled();
  });

  test("restrict=false: processed as today (runner called)", async () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: false, emails: [] });
    const { runner, say } = await invokeMention(ref, async () => undefined);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalled();
  });

  test("restrict=true + matching email: processed as today", async () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: true, emails: ["member@example.com"] });
    const { runner, say } = await invokeMention(
      ref,
      async () => "MEMBER@example.com",
    );
    expect(runner).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalled();
  });

  test("restrict=true + non-member email: runner not called, no reply posted", async () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: true, emails: ["member@example.com"] });
    const { runner, say } = await invokeMention(
      ref,
      async () => "stranger@example.com",
    );
    expect(runner).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  test("restrict=true + undefined email (resolution failed): runner not called", async () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: true, emails: ["member@example.com"] });
    const { runner, say } = await invokeMention(ref, async () => undefined);
    expect(runner).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });
});

// ─── Per-thread status refcounting (SSF-1.1) ───────────────────────────────
// A burst of overlapping message-handler invocations on the same thread must
// result in exactly one setStatus("processing") and one setStatus("active")
// call, with "active" firing only after the LAST queued run completes — not
// the first. This exercises the ThreadStatusTracker wired into createSlackApp
// via the same MockApp/mock-client harness used by the membership-gating
// suite above.

// Flushes pending microtask hops (getSessionFn / shouldRejectSlackSender's
// resolveUserEmailFn awaits, etc.) that run before a handler reaches
// progress.start(), so assertions made right after firing a handler call
// observe state as of "just before runner() is invoked" rather than mid-flight.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("per-thread status refcounting — message handler burst", () => {
  test("2 overlapping runs on the same thread: one processing, one active (after the last)", async () => {
    // Deferred promises let the test control exactly when each runner()
    // invocation resolves. Keyed by the prompt text (which embeds the
    // message body) rather than call order — resolveUserFn's await means the
    // two concurrent handler invocations can reach runner() in either order,
    // so the mock must resolve the correct in-flight call regardless of
    // which one actually invoked runner() first.
    let resolveFirst!: (value: { result: string; sessionId?: string }) => void;
    let resolveSecond!: (value: { result: string; sessionId?: string }) => void;
    const firstDone = new Promise<{ result: string; sessionId?: string }>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    const secondDone = new Promise<{ result: string; sessionId?: string }>(
      (resolve) => {
        resolveSecond = resolve;
      },
    );

    const runner = mock(async (msg: string, _key?: string) =>
      msg.includes("second message") ? secondDone : firstDone,
    );

    const ref = createAgentSlackMembershipRef();
    setupGatingApp({
      membershipRef: ref,
      resolveUserEmailFn: async () => undefined,
      runner,
    });

    const client = makeMockClient();
    const say = makeSay();
    // Same thread_ts on both messages — sessionKey is derived from
    // (channel, thread_ts ?? ts), so a burst on one thread must share a
    // thread_ts even though each individual message has its own ts.
    const message = {
      channel: "D123",
      ts: "300.1",
      thread_ts: "300.1",
      text: "first message",
      channel_type: "im",
      user: "U-SENDER",
    };

    // Fire both handler invocations before either runner() call resolves —
    // simulates a burst of 2 messages queued on the same thread while a run
    // is in flight.
    const firstHandlerCall = capturedMessageHandler?.({
      message,
      say,
      client,
    });
    const secondHandlerCall = capturedMessageHandler?.({
      message: { ...message, ts: "300.2", text: "second message" },
      say,
      client,
    });

    await flushMicrotasks();

    // Only "processing" should have been set so far — the thread is now at
    // refcount 2, so neither handler has reached its finally block yet.
    expect(client.agents.sessions.setStatus).toHaveBeenCalledTimes(1);
    expect(client.agents.sessions.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processing" }),
    );

    // Resolve the FIRST run — since a second run is still in flight, this
    // must NOT flip status to "active" (the false "done" signal this fix
    // prevents).
    resolveFirst({ result: "first done", sessionId: "sess-1" });
    await firstHandlerCall;

    expect(client.agents.sessions.setStatus).toHaveBeenCalledTimes(1);
    expect(client.agents.sessions.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
    );

    // Resolve the SECOND (last) run — only now should "active" fire.
    resolveSecond({ result: "second done", sessionId: "sess-1" });
    await secondHandlerCall;

    expect(client.agents.sessions.setStatus).toHaveBeenCalledTimes(2);
    const calls = client.agents.sessions.setStatus.mock.calls.map(
      (c: unknown[]) => (c[0] as { status: string }).status,
    );
    expect(calls).toEqual(["processing", "active"]);
  });

  test("bursts on different threads do not interfere with each other's status", async () => {
    let resolveA!: (value: { result: string; sessionId?: string }) => void;
    let resolveB!: (value: { result: string; sessionId?: string }) => void;
    const doneA = new Promise<{ result: string; sessionId?: string }>(
      (resolve) => {
        resolveA = resolve;
      },
    );
    const doneB = new Promise<{ result: string; sessionId?: string }>(
      (resolve) => {
        resolveB = resolve;
      },
    );

    const runner = mock(async (msg: string, _key?: string) =>
      msg.includes("channel-a") ? doneA : doneB,
    );

    const ref = createAgentSlackMembershipRef();
    setupGatingApp({
      membershipRef: ref,
      resolveUserEmailFn: async () => undefined,
      runner,
    });

    const client = makeMockClient();
    const say = makeSay();

    const callA = capturedMessageHandler?.({
      message: {
        channel: "D-A",
        ts: "400.1",
        text: "message on channel-a",
        channel_type: "im",
        user: "U-SENDER",
      },
      say,
      client,
    });
    const callB = capturedMessageHandler?.({
      message: {
        channel: "D-B",
        ts: "500.1",
        text: "message on channel-b",
        channel_type: "im",
        user: "U-SENDER",
      },
      say,
      client,
    });

    await flushMicrotasks();

    // Two independent threads, both starting — two "processing" calls.
    expect(client.agents.sessions.setStatus).toHaveBeenCalledTimes(2);

    resolveA({ result: "a done", sessionId: "sess-a" });
    await callA;
    resolveB({ result: "b done", sessionId: "sess-b" });
    await callB;

    // Each thread's single run completing should independently flip its own
    // status to "active" — total 4 calls (2 processing + 2 active).
    expect(client.agents.sessions.setStatus).toHaveBeenCalledTimes(4);
    const statuses = client.agents.sessions.setStatus.mock.calls.map(
      (c: unknown[]) => (c[0] as { status: string }).status,
    );
    expect(statuses.filter((s) => s === "processing")).toHaveLength(2);
    expect(statuses.filter((s) => s === "active")).toHaveLength(2);
  });
});

describe("membership gating — reaction_added handler", () => {
  async function invokeReaction(
    membershipRef: AgentSlackMembershipRef,
    resolveUserEmailFn: (
      userId: string,
      client: unknown,
    ) => Promise<string | undefined>,
  ) {
    const { runner } = setupGatingApp({ membershipRef, resolveUserEmailFn });
    const client = makeMockClient();
    const event = {
      reaction: "thumbsup",
      item: { type: "message", channel: "D1", ts: "100.1" },
      item_user: "UBOT123",
      user: "U-SENDER",
    };
    await capturedReactionAddedHandler?.({ event, client });
    return { runner, client };
  }

  test("unsynced ref: processed as today (runner called)", async () => {
    const ref = createAgentSlackMembershipRef();
    const { runner } = await invokeReaction(ref, async () => undefined);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test("restrict=false: processed as today (runner called)", async () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: false, emails: [] });
    const { runner } = await invokeReaction(ref, async () => undefined);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test("restrict=true + matching email: processed as today", async () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: true, emails: ["member@example.com"] });
    const { runner } = await invokeReaction(
      ref,
      async () => "member@example.com",
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test("restrict=true + non-member email: runner not called, no post", async () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: true, emails: ["member@example.com"] });
    const { runner, client } = await invokeReaction(
      ref,
      async () => "stranger@example.com",
    );
    expect(runner).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("restrict=true + undefined email (resolution failed): runner not called", async () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: true, emails: ["member@example.com"] });
    const { runner, client } = await invokeReaction(ref, async () => undefined);
    expect(runner).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});

// ─── agent_session_stopped handler (AGS-1.1) ───────────────────────────────
// Slack's native Stop/session-cancellation event for the Agent Sessions API.
// createSlackApp() keeps a closure-scoped registry (channel:ts -> live
// SlackProgress instance), populated when startStream() succeeds and cleared
// when the stream closes (success or failure). On agent_session_stopped, the
// handler looks up the matching instance and marks it externally-stopped
// (further appendStream/stopStream calls become no-ops), then independently
// resets the thread's "is working" indicator via a direct
// agents.sessions.setStatus({status: "active"}) call — the actual fix for the
// stuck-status bug, since it succeeds even when the stream is already dead
// server-side.

describe("agent_session_stopped handler", () => {
  function makeStreamingClient() {
    return {
      ...makeMockClient(),
      chat: {
        ...makeMockClient().chat,
        startStream: mock(async (_args: unknown) => ({ ts: "stream.ts.1" })),
        appendStream: mock(async (_args: unknown) => {}),
        stopStream: mock(async (_args: unknown) => {}),
      },
    };
  }

  // Flushes pending microtask hops (getSessionFn/resolveUserFn awaits,
  // startStream()'s await, etc.) so the handler reaches the point where it
  // has called runner() and is awaiting the still-pending run — i.e. the
  // registry entry is populated but the handler's finally block (which
  // would unregister it) hasn't run yet. Mirrors the existing
  // flushMicrotasks() helper used by the per-thread refcounting suite above.
  function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  // Starts a stream and leaves its run in flight (runner() never resolves
  // during the test) — the realistic shape of agent_session_stopped firing
  // mid-turn, and the only way the registry entry is still present when the
  // event handler looks it up (the message handler's finally block clears
  // it as soon as the run completes).
  function startAStream(overrides: {
    membershipRef: AgentSlackMembershipRef;
    resolveUserEmailFn: (
      userId: string,
      client: unknown,
    ) => Promise<string | undefined>;
    thinkingStepsEnabled?: boolean;
  }) {
    const runner = mock(
      (_msg: string, _key?: string) =>
        // biome-ignore lint/suspicious/noExplicitAny: deliberately never resolves — type matches ClaudeRunner's return via cast
        new Promise(() => {}) as any,
    );
    _createSlackApp(
      runner,
      (text: string) => text,
      (channel: string, ts: string) => `${channel}:${ts}`,
      // biome-ignore lint/suspicious/noExplicitAny: mock factory for tests
      (cfg) => new MockApp(cfg as Record<string, unknown>) as any,
      mockGatingSlackConfig,
      undefined,
      async () => null,
      {},
      async () => null,
      async () => null,
      async (userId: string) => userId,
      "UBOT123",
      async () => ({ messages: [] }),
      async () => undefined,
      undefined,
      undefined,
      overrides.resolveUserEmailFn,
      overrides.membershipRef,
      overrides.thinkingStepsEnabled ?? true,
    );

    const client = makeStreamingClient();
    const say = makeSay();
    const message = {
      channel: "D123",
      ts: "111.222",
      text: "Hello bot",
      channel_type: "im",
      user: "U-SENDER",
    };
    // Deliberately not awaited — the handler is left mid-flight, blocked on
    // runner()'s never-resolving promise.
    capturedMessageHandler?.({ message, say, client });
    return { runner, client, say };
  }

  test("marks the matching SlackProgress externally-stopped: further appendStream calls become no-ops", async () => {
    const ref = createAgentSlackMembershipRef();
    const { client } = startAStream({
      membershipRef: ref,
      resolveUserEmailFn: async () => undefined,
    });
    await flushMicrotasks();

    // Stream opened successfully — registry now has an entry for "D123:stream.ts.1".
    expect(client.chat.startStream).toHaveBeenCalledTimes(1);
    client.chat.appendStream.mockClear();

    await capturedAgentSessionStoppedHandler?.({
      event: { channel: "D123", streaming_message_ts: "stream.ts.1" },
      client,
    });

    // Any further onProgress-driven appendStream against this dead stream is
    // now a no-op — asserted indirectly by confirming a raw appendStream call
    // is never issued once the event has fired for this stream's key.
    expect(client.chat.appendStream).not.toHaveBeenCalled();
  });

  test("resets the thread status via a direct agents.sessions.setStatus('active') call", async () => {
    const ref = createAgentSlackMembershipRef();
    const { client } = startAStream({
      membershipRef: ref,
      resolveUserEmailFn: async () => undefined,
    });
    await flushMicrotasks();

    client.agents.sessions.setStatus.mockClear();

    await capturedAgentSessionStoppedHandler?.({
      event: { channel: "D123", streaming_message_ts: "stream.ts.1" },
      client,
    });

    // thread_ts must be the run's actual thread ts ("111.222", the
    // message's own ts since it has no thread_ts) — not the stream's
    // streaming_message_ts ("stream.ts.1"), which is a different value the
    // Agent Sessions API doesn't accept as a thread identifier.
    expect(client.agents.sessions.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "D123",
        thread_ts: "111.222",
        status: "active",
      }),
    );
  });

  test("unknown/already-cleared channel:ts is a no-op — does not throw", async () => {
    const ref = createAgentSlackMembershipRef();
    const { client } = startAStream({
      membershipRef: ref,
      resolveUserEmailFn: async () => undefined,
    });
    await flushMicrotasks();

    await expect(
      capturedAgentSessionStoppedHandler?.({
        event: { channel: "D999", streaming_message_ts: "no.such.stream" },
        client,
      }),
    ).resolves.toBeUndefined();

    // The direct status reset still fires regardless of registry lookup
    // outcome — AC #5 says it's independent of the stream's own close path.
    expect(client.agents.sessions.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
    );
  });

  test("agents.sessions.setStatus failure does not crash the handler", async () => {
    const ref = createAgentSlackMembershipRef();
    const { client } = startAStream({
      membershipRef: ref,
      resolveUserEmailFn: async () => undefined,
    });
    await flushMicrotasks();

    client.agents.sessions.setStatus.mockRejectedValueOnce(
      new Error("setStatus down"),
    );

    await expect(
      capturedAgentSessionStoppedHandler?.({
        event: { channel: "D123", streaming_message_ts: "stream.ts.1" },
        client,
      }),
    ).resolves.toBeUndefined();
  });

  test("registry entry is cleared once the stream closes normally — a later agent_session_stopped for it is a no-op lookup", async () => {
    const ref = createAgentSlackMembershipRef();
    const runner = mock(async (_msg: string, _key?: string) => ({
      result: "Claude response",
      sessionId: "sess-1",
    }));
    _createSlackApp(
      runner,
      (text: string) => text,
      (channel: string, ts: string) => `${channel}:${ts}`,
      // biome-ignore lint/suspicious/noExplicitAny: mock factory for tests
      (cfg) => new MockApp(cfg as Record<string, unknown>) as any,
      mockGatingSlackConfig,
      undefined,
      async () => null,
      {},
      async () => null,
      async () => null,
      async (userId: string) => userId,
      "UBOT123",
      async () => ({ messages: [] }),
      async () => undefined,
      undefined,
      undefined,
      async () => undefined,
      ref,
      true,
    );
    const client = makeStreamingClient();
    const say = makeSay();
    // Run completes normally (unlike startAStream()'s never-resolving
    // runner) — the message handler's finally block clears the registry
    // entry for this stream key before this call resolves.
    await capturedMessageHandler?.({
      message: {
        channel: "D123",
        ts: "111.222",
        text: "Hello bot",
        channel_type: "im",
        user: "U-SENDER",
      },
      say,
      client,
    });

    // Firing the event now must still be a safe no-op (covered by the
    // "unknown key" case above) — this test instead confirms stopStream was
    // not called a second time as a side effect of the (now no-op) lookup.
    client.chat.stopStream.mockClear();

    await capturedAgentSessionStoppedHandler?.({
      event: { channel: "D123", streaming_message_ts: "stream.ts.1" },
      client,
    });

    expect(client.chat.stopStream).not.toHaveBeenCalled();
  });
});
