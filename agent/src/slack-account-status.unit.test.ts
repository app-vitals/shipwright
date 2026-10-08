/**
 * agent/src/slack-account-status.unit.test.ts
 *
 * Unit tests for SSP-8.3's account-status Slack gate: the pure
 * isAccountPaused() predicate, plus handler-level gating for all three
 * inbound Slack event handlers (message, app_mention, reaction_added).
 * Mirrors slack-trial-expiry.unit.test.ts's harness.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  type AgentAccountStatusRef,
  createAgentAccountStatusRef,
} from "./agent-account-status-ref.ts";
import {
  createSlackApp as _createSlackApp,
  ACCOUNT_PAUSED_NOTICE,
  isAccountPaused,
} from "./slack.ts";

function refWith(status: string | null): AgentAccountStatusRef {
  const ref = createAgentAccountStatusRef();
  ref.set(status);
  return ref;
}

describe("isAccountPaused", () => {
  test("fails open when the ref has never synced", () => {
    expect(isAccountPaused(createAgentAccountStatusRef())).toBe(false);
  });

  test("not paused for an agent with no account (null)", () => {
    expect(isAccountPaused(refWith(null))).toBe(false);
  });

  test("not paused for an active account", () => {
    expect(isAccountPaused(refWith("active"))).toBe(false);
  });

  test("paused for suspended and trial_expired", () => {
    expect(isAccountPaused(refWith("suspended"))).toBe(true);
    expect(isAccountPaused(refWith("trial_expired"))).toBe(true);
  });

  test("self-heals once the ref syncs back to active", () => {
    const ref = refWith("suspended");
    expect(isAccountPaused(ref)).toBe(true);
    ref.set("active");
    expect(isAccountPaused(ref)).toBe(false);
  });
});

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
  accountStatusRef: AgentAccountStatusRef;
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
    undefined, // trialExpiryRef — default (unsynced, fails open)
    overrides.accountStatusRef,
  );

  return { runner };
}

describe("account-status gating — message handler", () => {
  async function invokeDM(accountStatusRef: AgentAccountStatusRef) {
    const { runner } = setupGatingApp({ accountStatusRef });
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
    return { runner, say };
  }

  for (const status of [null, "active"]) {
    test(`${status ?? "no account"}: processed as today`, async () => {
      const { runner, say } = await invokeDM(refWith(status));
      expect(runner).toHaveBeenCalledTimes(1);
      expect(say).not.toHaveBeenCalled();
    });
  }

  for (const status of ["suspended", "trial_expired"]) {
    test(`${status}: runner not called, one paused notice replied`, async () => {
      const { runner, say } = await invokeDM(refWith(status));
      expect(runner).not.toHaveBeenCalled();
      expect(say).toHaveBeenCalledTimes(1);
      const call = say.mock.calls[0]?.[0] as { text: string };
      expect(call.text).toBe(ACCOUNT_PAUSED_NOTICE);
    });
  }

  test("reactivation: messages are handled again after the next sync", async () => {
    const ref = refWith("suspended");
    expect((await invokeDM(ref)).runner).not.toHaveBeenCalled();
    ref.set("active");
    expect((await invokeDM(ref)).runner).toHaveBeenCalledTimes(1);
  });
});

describe("account-status gating — app_mention handler", () => {
  async function invokeMention(accountStatusRef: AgentAccountStatusRef) {
    const { runner } = setupGatingApp({ accountStatusRef });
    const client = makeMockClient();
    const say = makeSay();
    const event = {
      text: "<@UBOT> do something",
      channel: "C999",
      ts: "222.333",
      user: "U-SENDER",
    };
    await capturedMentionHandler?.({ event, say, client });
    return { runner, say };
  }

  test("active: processed as today", async () => {
    const { runner, say } = await invokeMention(refWith("active"));
    expect(runner).toHaveBeenCalledTimes(1);
    expect(say).not.toHaveBeenCalled();
  });

  test("suspended: runner not called, one paused notice replied", async () => {
    const { runner, say } = await invokeMention(refWith("suspended"));
    expect(runner).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
    const call = say.mock.calls[0]?.[0] as { text: string };
    expect(call.text).toBe(ACCOUNT_PAUSED_NOTICE);
  });
});

describe("account-status gating — reaction_added handler", () => {
  async function invokeReaction(accountStatusRef: AgentAccountStatusRef) {
    const { runner } = setupGatingApp({ accountStatusRef });
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

  test("active: processed as today", async () => {
    const { runner, client } = await invokeReaction(refWith("active"));
    expect(runner).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("trial_expired: runner not called, one paused notice posted", async () => {
    const { runner, client } = await invokeReaction(refWith("trial_expired"));
    expect(runner).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const call = (client.chat.postMessage as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as { text: string };
    expect(call.text).toBe(ACCOUNT_PAUSED_NOTICE);
  });
});
