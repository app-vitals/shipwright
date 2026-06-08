/**
 * Unit tests for agent/src/slack.ts
 *
 * Strategy: inject all dependencies via createSlackApp's params.
 * No mock.module(), no global.fetch overrides.
 *
 * MockApp class captures constructor args and registered handlers,
 * then fires them synchronously in tests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ClaudeRunError } from "./claude.ts";
import { threadKey } from "./sessions.ts";
import {
  createSlackApp,
  dispatchMarkers,
  formatRunErrorForSlack,
} from "./slack.ts";

// ─── MockApp ──────────────────────────────────────────────────────────────────

type HandlerFn = (...args: unknown[]) => Promise<void>;

let capturedConstructorArgs: Record<string, unknown> | null = null;
let capturedMessageHandler: HandlerFn | null = null;
let capturedMentionHandler: HandlerFn | null = null;
let capturedReactionAddedHandler: HandlerFn | null = null;

class MockApp {
  constructor(args: Record<string, unknown>) {
    capturedConstructorArgs = args;
    capturedMessageHandler = null;
    capturedMentionHandler = null;
    capturedReactionAddedHandler = null;
  }

  message(handler: HandlerFn) {
    capturedMessageHandler = handler;
  }

  event(eventName: string, handler: HandlerFn) {
    if (eventName === "app_mention") capturedMentionHandler = handler;
    if (eventName === "reaction_added") capturedReactionAddedHandler = handler;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: mock factory for tests
const mockAppFactory = (cfg: any) => new MockApp(cfg) as any;

// ─── Mock deps ────────────────────────────────────────────────────────────────

const mockRunner = mock(
  async (_msg: string, _key?: string): Promise<{ result: string; sessionId?: string }> => ({
    result: "Claude response",
    sessionId: "sess-1",
  }),
);

const mockFormatter = mock((text: string): string => `[fmt] ${text}`);

const mockSlackConfig = {
  botToken: "xoxb-test",
  appToken: "xapp-test",
  signingSecret: "secret",
};

const mockResolveUserFn = mock(async (_userId: string, _client: unknown): Promise<string> => "TestUser");

const mockSay = mock(() => Promise.resolve({ ts: "999.000" }));

// biome-ignore lint/suspicious/noExplicitAny: mock Slack client
const mockClient: any = {
  assistant: {
    threads: {
      setStatus: mock(() => Promise.resolve()),
    },
  },
  reactions: { add: mock(() => Promise.resolve()) },
  files: { uploadV2: mock(() => Promise.resolve()) },
  chat: { postMessage: mock(() => Promise.resolve({ ts: "999.000" })) },
};

const mockGetSessionFn = mock((_key: string): string | undefined => undefined);

const mockConversationsRepliesFn = mock(async (_client: unknown, _channel: string, _ts: string) => ({
  messages: [],
}));

const mockBlocksConverter = mock((_text: string) => null as null);

beforeEach(() => {
  mockRunner.mockClear();
  mockFormatter.mockClear();
  mockSay.mockClear();
  mockResolveUserFn.mockClear();
  mockGetSessionFn.mockClear();
  mockConversationsRepliesFn.mockClear();
  mockBlocksConverter.mockClear();
  mockClient.assistant.threads.setStatus.mockClear();
  mockClient.reactions.add.mockClear();
  mockClient.files.uploadV2.mockClear();
  mockClient.chat.postMessage.mockClear();
  capturedMessageHandler = null;
  capturedMentionHandler = null;
  capturedReactionAddedHandler = null;
});

function makeApp() {
  return createSlackApp(
    mockRunner,
    mockFormatter,
    threadKey,
    mockAppFactory,
    mockSlackConfig,
    () => {},
    async () => null,
    {},
    async () => "",
    async () => null,
    mockResolveUserFn,
    "U-BOT",
    mockConversationsRepliesFn,
    mockGetSessionFn,
    mockBlocksConverter,
  );
}

// ─── Factory / constructor ────────────────────────────────────────────────────

describe("createSlackApp", () => {
  test("instantiates with injected app factory (AC 1)", () => {
    makeApp();
    expect(capturedConstructorArgs).not.toBeNull();
    expect(capturedConstructorArgs?.token).toBe("xoxb-test");
    expect(capturedConstructorArgs?.appToken).toBe("xapp-test");
    expect(capturedConstructorArgs?.socketMode).toBe(true);
  });

  test("registers message, app_mention, and reaction_added handlers", () => {
    makeApp();
    expect(capturedMessageHandler).not.toBeNull();
    expect(capturedMentionHandler).not.toBeNull();
    expect(capturedReactionAddedHandler).not.toBeNull();
  });
});

// ─── app.message — DM routing ─────────────────────────────────────────────────

describe("app.message — DM routing", () => {
  test("responds to DM messages", async () => {
    makeApp();
    await capturedMessageHandler?.({
      message: { text: "hello", channel: "D123", ts: "1.0", channel_type: "im" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockRunner).toHaveBeenCalledTimes(1);
    expect(mockSay).toHaveBeenCalledTimes(1);
  });

  test("DM: [silent] marker does NOT suppress reply (DM override)", async () => {
    mockRunner.mockResolvedValueOnce({ result: "content [silent]", sessionId: "s1" });
    makeApp();

    await capturedMessageHandler?.({
      message: { text: "hello", channel: "D123", ts: "1.0", channel_type: "im" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSay).toHaveBeenCalledTimes(1);
  });

  test("skips if message has no text and no files", async () => {
    makeApp();
    await capturedMessageHandler?.({
      message: { channel: "D123", ts: "1.0", channel_type: "im" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockRunner).not.toHaveBeenCalled();
  });
});

// ─── app.message — Channel routing ───────────────────────────────────────────

describe("app.message — channel routing", () => {
  test("skips non-DM message without thread_ts (not in a thread)", async () => {
    makeApp();
    await capturedMessageHandler?.({
      message: { text: "hi", channel: "C123", ts: "1.0", channel_type: "channel" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockRunner).not.toHaveBeenCalled();
  });

  test("skips non-DM thread message when no session exists", async () => {
    mockGetSessionFn.mockReturnValueOnce(undefined);
    makeApp();

    await capturedMessageHandler?.({
      message: {
        text: "hi",
        channel: "C123",
        ts: "2.0",
        thread_ts: "1.0",
        channel_type: "channel",
      },
      say: mockSay,
      client: mockClient,
    });

    expect(mockRunner).not.toHaveBeenCalled();
  });

  test("responds to non-DM thread message when session exists", async () => {
    mockGetSessionFn.mockReturnValueOnce("existing-session-id");
    makeApp();

    await capturedMessageHandler?.({
      message: {
        text: "follow up",
        channel: "C123",
        ts: "2.0",
        thread_ts: "1.0",
        channel_type: "channel",
      },
      say: mockSay,
      client: mockClient,
    });

    expect(mockRunner).toHaveBeenCalledTimes(1);
    expect(mockSay).toHaveBeenCalledTimes(1);
  });

  test("channel thread: [silent] suppresses reply", async () => {
    mockGetSessionFn.mockReturnValueOnce("sess-xyz");
    mockRunner.mockResolvedValueOnce({ result: "text [silent]", sessionId: "s1" });
    makeApp();

    await capturedMessageHandler?.({
      message: {
        text: "hi",
        channel: "C123",
        ts: "2.0",
        thread_ts: "1.0",
        channel_type: "channel",
      },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSay).not.toHaveBeenCalled();
  });
});

// ─── app_mention ──────────────────────────────────────────────────────────────

describe("app_mention handler", () => {
  test("responds to app_mention", async () => {
    makeApp();

    await capturedMentionHandler?.({
      event: { text: "@bot hello", channel: "C123", ts: "1.0" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockRunner).toHaveBeenCalledTimes(1);
    expect(mockSay).toHaveBeenCalledTimes(1);
  });

  test("app_mention: [silent] suppresses reply", async () => {
    mockRunner.mockResolvedValueOnce({ result: "stuff [silent]", sessionId: "s1" });
    makeApp();

    await capturedMentionHandler?.({
      event: { text: "@bot hello", channel: "C123", ts: "1.0" },
      say: mockSay,
      client: mockClient,
    });

    expect(mockSay).not.toHaveBeenCalled();
  });
});

// ─── reaction_added ───────────────────────────────────────────────────────────

describe("reaction_added handler", () => {
  test("routes reaction on bot DM message to runner", async () => {
    makeApp();

    await capturedReactionAddedHandler?.({
      event: {
        reaction: "thumbsup",
        item: { type: "message", channel: "D123", ts: "1.0" },
        item_user: "U-BOT",
        user: "U-DAN",
      },
      client: mockClient,
    });

    expect(mockRunner).toHaveBeenCalledTimes(1);
    const prompt = mockRunner.mock.calls[0][0] as string;
    expect(prompt).toContain("thumbsup");
  });

  test("ignores reaction not on bot's message", async () => {
    makeApp();

    await capturedReactionAddedHandler?.({
      event: {
        reaction: "wave",
        item: { type: "message", channel: "D123", ts: "1.0" },
        item_user: "U-SOMEONE-ELSE",
        user: "U-DAN",
      },
      client: mockClient,
    });

    expect(mockRunner).not.toHaveBeenCalled();
  });

  test("ignores reaction in non-DM channels", async () => {
    makeApp();

    await capturedReactionAddedHandler?.({
      event: {
        reaction: "wave",
        item: { type: "message", channel: "C123", ts: "1.0" },
        item_user: "U-BOT",
        user: "U-DAN",
      },
      client: mockClient,
    });

    expect(mockRunner).not.toHaveBeenCalled();
  });

  test("reaction_added: [silent] suppresses reply", async () => {
    mockRunner.mockResolvedValueOnce({ result: "ack [silent]", sessionId: "s1" });
    makeApp();

    await capturedReactionAddedHandler?.({
      event: {
        reaction: "thumbsup",
        item: { type: "message", channel: "D123", ts: "1.0" },
        item_user: "U-BOT",
        user: "U-DAN",
      },
      client: mockClient,
    });

    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
  });
});

// ─── formatRunErrorForSlack ───────────────────────────────────────────────────

describe("formatRunErrorForSlack", () => {
  test("formats ClaudeRunError with 429 rate limit", () => {
    const err = new ClaudeRunError("rate limit", 429, "usage limit reached", undefined);
    const msg = formatRunErrorForSlack(err);
    expect(msg).toContain("org's monthly Claude usage limit");
  });

  test("formats ClaudeRunError with 529", () => {
    const err = new ClaudeRunError("overloaded", 529, "overloaded", undefined);
    const msg = formatRunErrorForSlack(err);
    expect(msg).toContain("overloaded");
  });

  test("formats unknown error", () => {
    const msg = formatRunErrorForSlack(new Error("unexpected"));
    expect(msg).toContain("went wrong");
  });
});

// ─── dispatchMarkers ─────────────────────────────────────────────────────────

describe("dispatchMarkers", () => {
  test("adds react emoji for react markers", async () => {
    await dispatchMarkers(
      [{ type: "react", emojis: ["thumbsup"] }],
      { client: mockClient, channel: "C123", postedTs: "1.0" },
    );

    expect(mockClient.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1.0",
      name: "thumbsup",
    });
  });

  test("silent marker is skipped gracefully", async () => {
    await dispatchMarkers(
      [{ type: "silent" }],
      { client: mockClient, channel: "C123" },
    );
    // No error thrown, no calls made
    expect(mockClient.reactions.add).not.toHaveBeenCalled();
  });
});
