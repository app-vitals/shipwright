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
  dispatchMarkers,
  hasSlackCredentials,
  isAllowedSlackSender,
  createSlackApp as _createSlackApp,
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
    assistant: {
      threads: {
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
  resolveUserEmailFn: (userId: string, client: unknown) => Promise<string | undefined>;
  runner?: (message: string, sessionKey?: string) => Promise<{
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
