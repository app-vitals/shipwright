/**
 * agent/src/slack-trial-expiry.unit.test.ts
 *
 * Unit tests for ATE-3.1's trial-expiry Slack gate: the pure isTrialExpired()
 * predicate, plus handler-level gating for all three inbound Slack event
 * handlers (message, app_mention, reaction_added).
 *
 * Builds its own minimal MockApp harness (mirroring slack.unit.test.ts's own
 * "membership gating" harness) so this file is self-contained and
 * slack.unit.test.ts stays untouched.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  type AgentTrialExpiryRef,
  createAgentTrialExpiryRef,
} from "./agent-trial-expiry-ref.ts";
import { createSlackApp as _createSlackApp, isTrialExpired } from "./slack.ts";

// ─── isTrialExpired ─────────────────────────────────────────────────────────

describe("isTrialExpired", () => {
  const NOW = () => new Date("2026-06-15T00:00:00.000Z");

  test("fails open (not expired) when the ref has never synced", () => {
    const ref = createAgentTrialExpiryRef();
    expect(isTrialExpired(ref, NOW)).toBe(false);
  });

  test("fails open (not expired) when synced but trialExpiresAt is null", () => {
    const ref = createAgentTrialExpiryRef();
    ref.set(null);
    expect(isTrialExpired(ref, NOW)).toBe(false);
  });

  test("not expired when trialExpiresAt is in the future", () => {
    const ref = createAgentTrialExpiryRef();
    ref.set(new Date("2026-07-01T00:00:00.000Z"));
    expect(isTrialExpired(ref, NOW)).toBe(false);
  });

  test("expired when trialExpiresAt is in the past", () => {
    const ref = createAgentTrialExpiryRef();
    ref.set(new Date("2026-06-01T00:00:00.000Z"));
    expect(isTrialExpired(ref, NOW)).toBe(true);
  });

  test("trialExpiresAt exactly equal to now is NOT expired (strictly-past only)", () => {
    const ref = createAgentTrialExpiryRef();
    ref.set(NOW());
    expect(isTrialExpired(ref, NOW)).toBe(false);
  });

  test("defaults `now` to the real current time when omitted", () => {
    const ref = createAgentTrialExpiryRef();
    ref.set(new Date("2099-01-01T00:00:00.000Z"));
    expect(isTrialExpired(ref)).toBe(false);

    ref.set(new Date("2000-01-01T00:00:00.000Z"));
    expect(isTrialExpired(ref)).toBe(true);
  });
});

// ─── Handler-level trial-expiry gating ─────────────────────────────────────

type HandlerFn = (...args: unknown[]) => Promise<void>;

let capturedMessageHandler: HandlerFn | null = null;
let capturedMentionHandler: HandlerFn | null = null;
let capturedReactionAddedHandler: HandlerFn | null = null;

class MockApp {
  constructor(_args: Record<string, unknown>) {
    capturedMessageHandler = null;
    capturedMentionHandler = null;
    capturedReactionAddedHandler = null;
  }

  message(handler: HandlerFn) {
    capturedMessageHandler = handler;
  }

  event(type: string, handler: HandlerFn) {
    if (type === "app_mention") capturedMentionHandler = handler;
    if (type === "reaction_added") capturedReactionAddedHandler = handler;
  }
}

const mockGatingSlackConfig = {
  botToken: "xoxb-test-token",
  appToken: "xapp-test-token",
  signingSecret: "test-secret",
};

function makeMockClient() {
  return {
    chat: {
      postMessage: mock(async (_args: unknown) => ({ ts: "resp.ts.1" })),
      startStream: mock(async (_args: unknown) => ({ ts: "stream.ts.1" })),
      appendStream: mock(async (_args: unknown) => {}),
      stopStream: mock(async (_args: unknown) => {}),
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
  trialExpiryRef: AgentTrialExpiryRef;
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
    async () => undefined, // resolveUserEmailFn — default (irrelevant here)
    undefined, // membershipRef — default (irrelevant here)
    overrides.trialExpiryRef,
  );

  return { runner };
}

describe("trial-expiry gating — message handler", () => {
  async function invokeDM(trialExpiryRef: AgentTrialExpiryRef) {
    const { runner } = setupGatingApp({ trialExpiryRef });
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

  test("unsynced ref: processed as today (runner called, no notice)", async () => {
    const ref = createAgentTrialExpiryRef();
    const { runner, say } = await invokeDM(ref);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(say).not.toHaveBeenCalled();
  });

  test("trial not yet expired: processed as today (runner called)", async () => {
    const ref = createAgentTrialExpiryRef();
    ref.set(new Date(Date.now() + 60 * 60 * 1000));
    const { runner, say } = await invokeDM(ref);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(say).not.toHaveBeenCalled();
  });

  test("trial expired: runner not called, a single trial-ended notice is replied", async () => {
    const ref = createAgentTrialExpiryRef();
    ref.set(new Date(Date.now() - 60 * 60 * 1000));
    const { runner, say } = await invokeDM(ref);
    expect(runner).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
    const call = say.mock.calls[0]?.[0] as { text: string };
    expect(call.text.toLowerCase()).toContain("trial");
  });
});

describe("trial-expiry gating — app_mention handler", () => {
  async function invokeMention(trialExpiryRef: AgentTrialExpiryRef) {
    const { runner } = setupGatingApp({ trialExpiryRef });
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

  test("unsynced ref: processed as today (runner called, no notice)", async () => {
    const ref = createAgentTrialExpiryRef();
    const { runner, say } = await invokeMention(ref);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(say).not.toHaveBeenCalled();
  });

  test("trial expired: runner not called, a single trial-ended notice is replied", async () => {
    const ref = createAgentTrialExpiryRef();
    ref.set(new Date(Date.now() - 60 * 60 * 1000));
    const { runner, say } = await invokeMention(ref);
    expect(runner).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
    const call = say.mock.calls[0]?.[0] as { text: string };
    expect(call.text.toLowerCase()).toContain("trial");
  });
});

describe("trial-expiry gating — reaction_added handler", () => {
  async function invokeReaction(trialExpiryRef: AgentTrialExpiryRef) {
    const { runner } = setupGatingApp({ trialExpiryRef });
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

  test("unsynced ref: processed as today (runner called, no notice)", async () => {
    const ref = createAgentTrialExpiryRef();
    const { runner, client } = await invokeReaction(ref);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("trial expired: runner not called, a single trial-ended notice is posted via client.chat.postMessage", async () => {
    const ref = createAgentTrialExpiryRef();
    ref.set(new Date(Date.now() - 60 * 60 * 1000));
    const { runner, client } = await invokeReaction(ref);
    expect(runner).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const call = (client.chat.postMessage as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as { text: string };
    expect(call.text.toLowerCase()).toContain("trial");
  });
});
