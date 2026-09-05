/**
 * Tests for agent/src/slack.ts
 *
 * Strategy: inject all dependencies via createSlackApp's params. No mock.module()
 * needed anywhere.
 *
 * - appFactory: MockApp class that captures constructor args + handlers
 * - runner: mock function
 * - formatter: mock function
 * - getThreadKey: real threadKey (pure function, no deps)
 * - slackConfig: plain object with test credentials
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErrorCapturingClient } from "@shipwright/lib/sentry";
import {
  type AgentSlackMembershipRef,
  createAgentSlackMembershipRef,
} from "./agent-slack-membership-ref.ts";
import {
  type ChatTokenReporter,
  NoopChatTokenReporter,
} from "./chat-token-reporter.ts";
import {
  ClaudeRunError,
  ClaudeTimeoutError,
  createRunClaude,
} from "./claude.ts";
import type { ModelUsage, ProgressCallback, TokenUsage } from "./claude.ts";
import type { markdownToBlocks } from "./format.ts";
import { threadKey } from "./sessions.ts";
import {
  type SlackFile,
  type SynthesizeSpeechFn,
  type TranscribeAudioFn,
  createSlackApp as _createSlackApp,
  dispatchMarkers,
  downloadFile,
  formatRunErrorForSlack,
} from "./slack.ts";
import type { VoiceConfig } from "./voice.ts";

// ─── Mock resolveUserFn ───────────────────────────────────────────────────────

const mockResolveUserFn = mock(
  async (_userId: string, _client: unknown): Promise<string> => "Dan",
);

// ─── Mock runner + formatter ──────────────────────────────────────────────────

const mockUsage: TokenUsage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 20,
  cache_creation_input_tokens: 10,
};

const mockRunClaude = mock(
  async (
    _msg: string,
    _key?: string,
    _onProgress?: ProgressCallback,
  ): Promise<{
    result: string;
    sessionId?: string;
    usage?: TokenUsage;
    totalCostUsd?: number;
    modelUsage?: ModelUsage;
    streamIncomplete?: boolean;
  }> => ({
    result: "Claude response text",
    sessionId: "sess-xyz",
    usage: mockUsage,
    totalCostUsd: undefined,
  }),
);

const mockMarkdownToSlack = mock(
  (text: string): string => `[formatted] ${text}`,
);

// ─── Test slack config ────────────────────────────────────────────────────────

const mockSlackConfig = {
  botToken: "xoxb-test-token",
  appToken: "xapp-test-token",
  signingSecret: "test-secret",
};

// ─── MockApp — captures constructor args and registered handlers ──────────────

type HandlerFn = (...args: unknown[]) => Promise<void>;

let capturedConstructorArgs: Record<string, unknown> | null = null;
let capturedMessageHandler: HandlerFn | null = null;
let capturedMentionHandler: HandlerFn | null = null;
let capturedReactionAddedHandler: HandlerFn | null = null;

// STS-2.1: createSlackApp() resolves the bot's own team ID once via
// app.client.auth.test() at construction — MockApp exposes the same shape
// Bolt's real App does (a `.client` WebClient) so that resolution path is
// exercised the same way it is in production, rather than always hitting
// the "no auth.test at all" branch. Resolves to a stable team_id by
// default; individual tests can reassign `.mockResolvedValueOnce`/
// `.mockRejectedValueOnce` on `mockAuthTest` to exercise the failure path.
const mockAuthTest = mock(async (_args?: unknown) => ({ team_id: "T-TEAM" }));

class MockApp {
  client = { auth: { test: mockAuthTest } };

  constructor(args: Record<string, unknown>) {
    capturedConstructorArgs = args;
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

// ─── Fake sentry client — captures errors instead of asserting on a tracker ──

let capturedErrors: unknown[] = [];
const fakeSentryClient: ErrorCapturingClient = {
  captureException: (err: unknown) => {
    capturedErrors.push(err);
  },
};

// Wrap with test deps so all tests call createSlackApp() with no args
function createSlackApp(
  overrides: {
    fileDownloaderFn?: (
      file: SlackFile,
      botToken: string,
    ) => Promise<string | null>;
    voiceConfig?: VoiceConfig;
    transcribeAudioFn?: TranscribeAudioFn;
    synthesizeSpeechFn?: SynthesizeSpeechFn;
    resolveUserFn?: (userId: string, client: unknown) => Promise<string>;
    botUserId?: string | undefined;
    conversationsRepliesFn?: (
      client: unknown,
      channel: string,
      ts: string,
    ) => Promise<{
      messages?: { user?: string; text?: string; ts?: string }[];
    }>;
    getSessionFn?: (key: string) => Promise<string | undefined>;
    blocksConverter?: typeof markdownToBlocks;
    chatTokenReporter?: ChatTokenReporter;
    sentryClient?: ErrorCapturingClient;
    resolveUserEmailFn?: (
      userId: string,
      client: unknown,
    ) => Promise<string | undefined>;
    membershipRef?: AgentSlackMembershipRef;
  } = {},
) {
  capturedErrors = [];
  return _createSlackApp(
    mockRunClaude,
    mockMarkdownToSlack,
    threadKey,
    // biome-ignore lint/suspicious/noExplicitAny: mock factory for tests
    (cfg) => new MockApp(cfg as Record<string, unknown>) as any,
    mockSlackConfig,
    overrides.sentryClient ?? fakeSentryClient,
    overrides.fileDownloaderFn ?? (async () => null),
    overrides.voiceConfig ?? {},
    overrides.transcribeAudioFn ?? (async () => null),
    overrides.synthesizeSpeechFn ?? (async () => null),
    overrides.resolveUserFn ?? mockResolveUserFn,
    "botUserId" in overrides ? overrides.botUserId : "UBOT123",
    overrides.conversationsRepliesFn ?? (async () => ({ messages: [] })),
    overrides.getSessionFn ?? (async () => undefined),
    overrides.blocksConverter,
    overrides.chatTokenReporter ?? new NoopChatTokenReporter(),
    overrides.resolveUserEmailFn ?? (async () => undefined),
    // A fresh, unsynced ref per call — never the process-wide
    // agentSlackMembershipRef singleton, which other test files (e.g.
    // agent-slack-membership-ref.unit.test.ts) mutate directly. Falling
    // through to that shared singleton would make this suite's outcome
    // depend on bun test's file execution order (see CLAUDE.md's test
    // isolation hard rule).
    overrides.membershipRef ?? createAgentSlackMembershipRef(),
  );
}

// ─── Mock client helpers ──────────────────────────────────────────────────────

function makeMockClient() {
  return {
    agents: {
      sessions: {
        setStatus: mock(async (_args: unknown) => {}),
      },
    },
    reactions: {
      add: mock(async (_args: unknown) => {}),
      remove: mock(async (_args: unknown) => {}),
    },
    files: {
      uploadV2: mock(async (_args: unknown) => {}),
    },
    conversations: {
      open: mock(async (_args: unknown) => ({ channel: { id: "DM_CHAN_1" } })),
    },
    chat: {
      postMessage: mock(async (_args: unknown) => ({ ts: "resp.ts.1" })),
      getPermalink: mock(async (_args: unknown) => ({
        permalink: "https://slack.com/archives/C1/p1234",
      })),
      startStream: mock(async (_args: unknown) => ({ ts: "stream.ts.1" })),
      appendStream: mock(async (_args: unknown) => {}),
      stopStream: mock(async (_args: unknown) => {}),
    },
    users: {
      info: mock(async (_args: unknown) => ({
        user: {
          profile: { display_name: "Test User", real_name: "Test User Real" },
          name: "testuser",
        },
      })),
    },
  };
}

function makeSay(replyTs = "reply.ts.1") {
  return mock(async (_args: unknown) => ({ ts: replyTs }));
}

// ─── createSlackApp tests ─────────────────────────────────────────────────────

describe("createSlackApp", () => {
  test("returns a MockApp instance", () => {
    const app = createSlackApp();
    expect(app).toBeInstanceOf(MockApp);
  });

  test("constructs App with botToken from config", () => {
    createSlackApp();
    expect(capturedConstructorArgs?.token).toBe("xoxb-test-token");
  });

  test("constructs App with appToken from config", () => {
    createSlackApp();
    expect(capturedConstructorArgs?.appToken).toBe("xapp-test-token");
  });

  test("constructs App with signingSecret from config", () => {
    createSlackApp();
    expect(capturedConstructorArgs?.signingSecret).toBe("test-secret");
  });

  test("enables socketMode", () => {
    createSlackApp();
    expect(capturedConstructorArgs?.socketMode).toBe(true);
  });

  test("registers a message handler", () => {
    createSlackApp();
    expect(capturedMessageHandler).toBeTypeOf("function");
  });

  test("registers an app_mention event handler", () => {
    createSlackApp();
    expect(capturedMentionHandler).toBeTypeOf("function");
  });
});

// ─── message handler tests (DM routing) ──────────────────────────────────────

describe("message handler — DM routing", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
    mockMarkdownToSlack.mockClear();
    createSlackApp();
  });

  async function invokeDM(
    overrides: Partial<{
      subtype: string;
      text: string;
      channel: string;
      ts: string;
      thread_ts: string;
      files: SlackFile[];
      blocks: Array<{ type: string; elements?: unknown[] }>;
      user: string;
    }> = {},
  ) {
    const client = makeMockClient();
    const say = makeSay();
    const message = {
      channel: "D123",
      ts: "111.222",
      text: "Hello bot",
      channel_type: "im",
      ...overrides,
    };
    await capturedMessageHandler?.({ message, say, client });
    return { client, say };
  }

  test("fires chatTokenReporter.recordSession with the session usage on a DM", async () => {
    const recordSession = mock(
      async (
        _usage?: TokenUsage,
        _totalCostUsd?: number,
        _modelUsage?: ModelUsage,
      ) => {},
    );
    createSlackApp({ chatTokenReporter: { recordSession } });

    await invokeDM({ text: "hello" });

    expect(recordSession).toHaveBeenCalledTimes(1);
    expect(recordSession).toHaveBeenCalledWith(mockUsage, undefined, undefined);
  });

  test("returns early when message has a non-file subtype", async () => {
    const { client, say } = await invokeDM({ subtype: "bot_message" });
    expect(mockRunClaude).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
    expect(client.reactions.add).not.toHaveBeenCalled();
  });

  test("processes file_share messages", async () => {
    const file: SlackFile = {
      name: "test.txt",
      mimetype: "text/plain",
      size: 100,
      url_private: "https://files.slack.com/test.txt",
    };
    createSlackApp({ fileDownloaderFn: async () => "/tmp/test.txt" });
    const { client } = await invokeDM({
      subtype: "file_share",
      text: "",
      files: [file],
    });
    expect(mockRunClaude).toHaveBeenCalled();
    expect(client.chat.appendStream).toHaveBeenCalled();
  });

  test("returns early when message has no text and no files", async () => {
    const { client, say } = await invokeDM({ text: undefined });
    expect(mockRunClaude).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  test("does not return early when message has empty text but rich_text blocks", async () => {
    const { client } = await invokeDM({
      text: "",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "Hello from rich text" }],
            },
          ],
        },
      ],
    });
    expect(mockRunClaude).toHaveBeenCalled();
    expect(client.chat.appendStream).toHaveBeenCalled();
  });

  test("converts rich_text blocks to markdown and passes to runClaude when text is absent", async () => {
    await invokeDM({
      text: "",
      channel: "D123",
      ts: "111.222",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "Hello from rich text" }],
            },
          ],
        },
      ],
    });
    expect(mockRunClaude).toHaveBeenCalledWith(
      "Hello from rich text",
      "D123:111.222",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "D123", SLACK_THREAD_TS: "111.222" },
    );
  });

  test("uses msg.text over rich_text blocks when both are present", async () => {
    await invokeDM({
      text: "Plain text wins",
      channel: "D123",
      ts: "111.222",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "Rich text should be ignored" }],
            },
          ],
        },
      ],
    });
    expect(mockRunClaude).toHaveBeenCalledWith(
      "Plain text wins",
      "D123:111.222",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "D123", SLACK_THREAD_TS: "111.222" },
    );
  });

  test("calls runClaude with message text and thread sessionKey", async () => {
    await invokeDM({
      text: "Do the thing",
      channel: "D123",
      ts: "111.222",
    });
    expect(mockRunClaude).toHaveBeenCalledWith(
      "Do the thing",
      "D123:111.222",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "D123", SLACK_THREAD_TS: "111.222" },
    );
  });

  test("uses thread_ts as sessionKey when available", async () => {
    await invokeDM({ channel: "D456", ts: "1.1", thread_ts: "0.9" });
    expect(mockRunClaude).toHaveBeenCalledWith(
      "Hello bot",
      "D456:0.9",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "D456", SLACK_THREAD_TS: "0.9" },
    );
  });

  test("formats result with markdownToSlack before posting via the say() fallback", async () => {
    // The streaming path delivers `cleaned` unformatted via markdown_text —
    // formatter(cleaned) is only used on the say()/blocksConverter fallback,
    // so force that path by failing the stream delivery.
    const client = makeMockClient();
    client.chat.appendStream.mockRejectedValue(new Error("stream unavailable"));
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D123",
        ts: "111.222",
        text: "hi",
        channel_type: "im",
      },
      say,
      client,
    });
    expect(mockMarkdownToSlack).toHaveBeenCalledWith("Claude response text");
  });

  test("opens the Thinking Steps stream using thread_ts when available", async () => {
    const { client } = await invokeDM({ ts: "1.1", thread_ts: "0.9" });
    expect(client.chat.startStream).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: "0.9" }),
    );
  });

  test("a reply never posts via client.chat.postMessage — only the Thinking Steps stream or say()", async () => {
    // SlackProgress never calls chat.postMessage. By default (mock client
    // has a working chat namespace) the real reply is delivered via the
    // stream's markdown_text chunk and say() is not used.
    const { client, say } = await invokeDM({ channel: "D123", ts: "111.222" });
    expect(say).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("the message handler's SlackProgress opens a Thinking Steps stream (STS-1.1)", async () => {
    createSlackApp();
    const { client } = await invokeDM({ channel: "D123", ts: "111.222" });
    expect(client.chat.startStream).toHaveBeenCalledWith({
      channel: "D123",
      thread_ts: "111.222",
      task_display_mode: "timeline",
    });
    expect(client.chat.stopStream).toHaveBeenCalled();
  });

  // STS-2.1 AC #2: a DM omits recipient_team_id/recipient_user_id entirely,
  // even though MockApp's client.auth.test() resolves a real team_id and the
  // message carries a `user` — they're not required (and may not even be
  // meaningful) for a DM, which already fully identifies the recipient.
  test("omits recipient_team_id and recipient_user_id on chat.startStream for a DM (STS-2.1 AC #2)", async () => {
    createSlackApp();
    const { client } = await invokeDM({
      channel: "D123",
      ts: "111.222",
      user: "U-SENDER",
    });
    const call = client.chat.startStream.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call).not.toHaveProperty("recipient_team_id");
    expect(call).not.toHaveProperty("recipient_user_id");
  });

  // ─── STS2-1.1 regression: queued-message burst ──────────────────────────
  //
  // Every message gets its own independent stream lifecycle regardless of
  // ThreadStatusTracker's refcount (AC #5) — the refcount only informs the
  // seed card's title: "Thinking…" for the first message on a thread,
  // "Queued…" for every message that arrives while an earlier one on the
  // same thread is still in flight. Without the fix, enter()/exit() GATED
  // whether start()/finish() were even called — the second+ message in a
  // burst never opened its own stream at all.
  test("a burst of queued messages on the same thread each get their own stream + correct Queued/Thinking seed labels (STS2-1.1 AC #5)", async () => {
    createSlackApp();

    // Two deferred runner calls so both messages are genuinely in flight at
    // once — the second is dispatched before the first's runner() resolves.
    let resolveFirst: (v: {
      result: string;
      sessionId?: string;
    }) => void = () => {};
    let resolveSecond: (v: {
      result: string;
      sessionId?: string;
    }) => void = () => {};
    mockRunClaude.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    mockRunClaude.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );

    const client = makeMockClient();
    const say1 = makeSay("reply.ts.1");
    const say2 = makeSay("reply.ts.2");
    // Same thread_ts on both — the tracker keys on
    // getThreadKey(channel, thread_ts ?? ts), so a shared thread_ts is what
    // makes this a genuine same-thread burst (distinct top-level ts values
    // alone would produce distinct, unrelated session keys).
    const message = {
      channel: "D-BURST",
      ts: "1.1",
      thread_ts: "1.0",
      text: "first",
      channel_type: "im",
    };

    // Fire both messages on the same thread without awaiting the first —
    // start() for #2 runs while #1's runner() call is still pending.
    const p1 = capturedMessageHandler?.({
      message,
      say: say1,
      client,
    });
    const p2 = capturedMessageHandler?.({
      message: { ...message, ts: "1.2", text: "second" },
      say: say2,
      client,
    });

    // Both handlers should have opened their own stream by now (start() is
    // awaited synchronously before the runner() call inside each handler).
    // A real setTimeout tick (not just queued microtasks) is needed — the
    // handler crosses several real awaits (startStream, buildPromptWithFiles,
    // etc.) before reaching the runner() call below.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(client.chat.startStream).toHaveBeenCalledTimes(2);

    const appendCalls = client.chat.appendStream.mock.calls.map(
      (c) => c[0] as { chunks: Array<Record<string, unknown>> },
    );
    const seedTitles = appendCalls
      .map((c) => c.chunks.find((ch) => ch.type === "task_update")?.title)
      .filter((t): t is string => typeof t === "string");

    expect(seedTitles).toContain("Thinking…");
    expect(seedTitles).toContain("Queued…");

    resolveFirst({ result: "first done", sessionId: "s1" });
    resolveSecond({ result: "second done", sessionId: "s2" });
    await p1;
    await p2;
  });

  // ─── STS2-1.1 regression: first-to-finish keeps session_status processing
  //
  // stopStream's session_status is per-thread, not per-message — the
  // first-to-finish message of a burst must NOT dismiss the "Bodhi is
  // working" indicator for the whole thread while a later message is still
  // running (AC #5).
  test("the first-to-finish message of a burst keeps session_status 'processing' while a later one is still in flight (STS2-1.1 AC #5)", async () => {
    createSlackApp();

    let resolveFirst: (v: {
      result: string;
      sessionId?: string;
    }) => void = () => {};
    let resolveSecond: (v: {
      result: string;
      sessionId?: string;
    }) => void = () => {};
    mockRunClaude.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    mockRunClaude.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );

    const client = makeMockClient();
    const say1 = makeSay("reply.ts.1");
    const say2 = makeSay("reply.ts.2");
    // Same thread_ts on both — see the matching comment in the burst-seed
    // test above.
    const message = {
      channel: "D-BURST2",
      ts: "2.1",
      thread_ts: "2.0",
      text: "first",
      channel_type: "im",
    };

    const p1 = capturedMessageHandler?.({
      message,
      say: say1,
      client,
    });
    const p2 = capturedMessageHandler?.({
      message: { ...message, ts: "2.2", text: "second" },
      say: say2,
      client,
    });
    // A real setTimeout tick — see the matching comment in the burst-seed
    // test above.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // First message finishes while the second is still running.
    resolveFirst({ result: "first done", sessionId: "s1" });
    await p1;

    const stopCalls = client.chat.stopStream.mock.calls.map(
      (c) => c[0] as { session_status?: string },
    );
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]?.session_status).toBe("processing");

    // Now the second (genuinely last) message finishes — closes "active".
    resolveSecond({ result: "second done", sessionId: "s2" });
    await p2;

    const stopCallsAfter = client.chat.stopStream.mock.calls.map(
      (c) => c[0] as { session_status?: string },
    );
    expect(stopCallsAfter).toHaveLength(2);
    expect(stopCallsAfter[1]?.session_status).toBe("active");
  });

  // ─── STS2-1.1: chunk schema, setStatus skip, delivery ───────────────────

  test("calls agents.sessions.setStatus eagerly at start and unconditionally at finish, alongside streaming (ISW-1.1)", async () => {
    createSlackApp();
    const { client } = await invokeDM({ channel: "D123", ts: "111.222" });
    expect(client.agents.sessions.setStatus).toHaveBeenCalledWith({
      channel_id: "D123",
      thread_ts: "111.222",
      status: "processing",
    });
    expect(client.agents.sessions.setStatus).toHaveBeenCalledWith({
      channel_id: "D123",
      thread_ts: "111.222",
      status: "active",
    });
    // Independent of, not instead of, the stream's own close call.
    expect(client.chat.stopStream).toHaveBeenCalledWith(
      expect.objectContaining({ session_status: "active" }),
    );
  });

  test("every task_update chunk uses the type/id/title/status shape, never the old {type, text} shape (STS2-1.1 AC #1)", async () => {
    createSlackApp();
    const { client } = await invokeDM({ channel: "D123", ts: "111.222" });
    const taskUpdateChunks = client.chat.appendStream.mock.calls
      .flatMap(
        (c) => (c[0] as { chunks: Array<Record<string, unknown>> }).chunks,
      )
      .filter((chunk) => chunk.type === "task_update");
    expect(taskUpdateChunks.length).toBeGreaterThan(0);
    for (const chunk of taskUpdateChunks) {
      expect(chunk).not.toHaveProperty("text");
      expect(chunk.id).toBeDefined();
      expect(["in_progress", "complete", "error"]).toContain(
        chunk.status as string,
      );
    }
  });

  test("reuses a single stable task_update id across the whole run (STS2-1.1 AC #1)", async () => {
    createSlackApp();
    const { client } = await invokeDM({ channel: "D123", ts: "111.222" });
    const ids = client.chat.appendStream.mock.calls
      .flatMap(
        (c) => (c[0] as { chunks: Array<Record<string, unknown>> }).chunks,
      )
      .filter((chunk) => chunk.type === "task_update")
      .map((chunk) => chunk.id);
    expect(new Set(ids).size).toBe(1);
  });

  test("delivers the final reply as a markdown_text chunk via chat.appendStream, and skips say() (STS2-1.1 AC #2)", async () => {
    createSlackApp();
    const { client, say } = await invokeDM({ channel: "D123", ts: "111.222" });

    const markdownChunks = client.chat.appendStream.mock.calls
      .flatMap(
        (c) => (c[0] as { chunks: Array<Record<string, unknown>> }).chunks,
      )
      .filter((chunk) => chunk.type === "markdown_text");
    expect(markdownChunks).toContainEqual({
      type: "markdown_text",
      text: "Claude response text",
    });
    // Delivered via the stream — say() is not used for the real reply.
    expect(say).not.toHaveBeenCalled();
  });

  // STS2-3.1: a [silent] response must still close the stream's dangling
  // in_progress card — with a distinct "Ack" title (not "Done", which would
  // imply a real reply went out) and no markdown_text content.
  test("closes the stream with an 'Ack' completion card and posts no content when Claude returns [silent] (STS2-3.1)", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: "[silent]",
      sessionId: "sess-silent",
    });
    createSlackApp();
    const { client, say } = await invokeDM({ channel: "D123", ts: "111.222" });

    expect(say).not.toHaveBeenCalled();

    const chunks = client.chat.appendStream.mock.calls.flatMap(
      (c) => (c[0] as { chunks: Array<Record<string, unknown>> }).chunks,
    );
    const markdownChunks = chunks.filter((c) => c.type === "markdown_text");
    expect(markdownChunks).toHaveLength(0);

    const completeChunk = chunks.find(
      (c) => c.type === "task_update" && c.status === "complete",
    );
    expect(completeChunk?.title).toBe("Ack");
  });

  test("falls back to say() when chat.appendStream rejects (delivery failure never drops the reply) (STS2-1.1 AC #2)", async () => {
    const client = makeMockClient();
    client.chat.appendStream.mockImplementation(async () => {
      throw new Error("streaming_mode_mismatch");
    });
    const say = makeSay();
    createSlackApp();
    await capturedMessageHandler?.({
      message: {
        channel: "D-FALLBACK",
        ts: "9.9",
        text: "hi",
        channel_type: "im",
      },
      say,
      client,
    });
    expect(say).toHaveBeenCalledWith({
      text: "[formatted] Claude response text",
      thread_ts: "9.9",
    });
  });

  test("passes an onProgress function through to the runner as the third arg (AC #1)", async () => {
    await invokeDM({ text: "hi", channel: "D123", ts: "111.222" });
    const call = mockRunClaude.mock.calls.at(-1) as unknown[];
    expect(call[2]).toBeTypeOf("function");
  });

  test("posts error message when runClaude throws", async () => {
    mockRunClaude.mockRejectedValueOnce(new Error("spawn failed"));
    const { say } = await invokeDM({ ts: "1.1" });
    expect(say).toHaveBeenCalledWith({
      text: expect.stringContaining("spawn failed"),
      thread_ts: "1.1",
    });
  });

  test("closes the Thinking Steps stream even when runClaude throws", async () => {
    mockRunClaude.mockRejectedValueOnce(new Error("spawn failed"));
    const { client } = await invokeDM({ channel: "D123", ts: "1.1" });
    expect(client.chat.stopStream).toHaveBeenCalledWith(
      expect.objectContaining({ session_status: "active" }),
    );
  });

  test("does not throw when chat.stopStream fails", async () => {
    const client = makeMockClient();
    const say = makeSay();
    client.chat.stopStream.mockRejectedValueOnce(new Error("api error"));

    await expect(
      capturedMessageHandler?.({
        message: { channel: "D1", ts: "1.1", text: "hi", channel_type: "im" },
        say,
        client,
      }),
    ).resolves.toBeUndefined();
  });

  test("does not call sentryClient.captureException on success", async () => {
    await invokeDM({ channel: "D1", ts: "1.1", text: "hello" });
    expect(capturedErrors.length).toBe(0);
  });

  test("calls sentryClient.captureException when runClaude throws", async () => {
    mockRunClaude.mockRejectedValueOnce(new Error("boom"));
    await invokeDM({ channel: "D1", ts: "1.1" });
    expect(capturedErrors.length).toBe(1);
    expect((capturedErrors[0] as Error).message).toBe("boom");
  });

  test("marks the Thinking Steps card status:'error' when runClaude throws (STS2-4.1 AC #1)", async () => {
    createSlackApp();
    mockRunClaude.mockRejectedValueOnce(new Error("boom"));
    const { client } = await invokeDM({ channel: "D123", ts: "111.222" });

    const taskUpdateChunks = client.chat.appendStream.mock.calls
      .flatMap(
        (c) => (c[0] as { chunks: Array<Record<string, unknown>> }).chunks,
      )
      .filter((chunk) => chunk.type === "task_update");
    const errorChunks = taskUpdateChunks.filter(
      (chunk) => chunk.status === "error",
    );
    expect(errorChunks.length).toBeGreaterThan(0);
    expect(errorChunks[0]?.id).toBeDefined();

    // finish() still closes the stream, and does not send a redundant
    // status:"complete" card after the error card.
    expect(client.chat.stopStream).toHaveBeenCalled();
    const completeChunks = taskUpdateChunks.filter(
      (chunk) => chunk.status === "complete",
    );
    expect(completeChunks.length).toBe(0);
  });

  test("marks the card status:'error' even when the catch block's say() itself throws (STS2-4.1 AC #1 — #3064 review)", async () => {
    // Both the run AND the error-notification say() fail. reportError() must
    // still fire (it runs before say() in the catch block), so finish() sees
    // completed=true and never sends a "Done" card for a run that both errored
    // and failed to notify the user.
    const client = makeMockClient();
    const say = mock(async (_args: unknown) => {
      throw new Error("invalid_auth");
    });
    createSlackApp();
    mockRunClaude.mockRejectedValueOnce(new Error("boom"));

    await capturedMessageHandler?.({
      message: {
        channel: "D123",
        ts: "111.222",
        text: "Hello bot",
        channel_type: "im",
      },
      say,
      client,
    });

    const taskUpdateChunks = client.chat.appendStream.mock.calls
      .flatMap(
        (c) => (c[0] as { chunks: Array<Record<string, unknown>> }).chunks,
      )
      .filter((chunk) => chunk.type === "task_update");
    const errorChunks = taskUpdateChunks.filter(
      (chunk) => chunk.status === "error",
    );
    expect(errorChunks.length).toBeGreaterThan(0);

    // No "Done" card despite the failed notification, and the stream still
    // closes.
    const completeChunks = taskUpdateChunks.filter(
      (chunk) => chunk.status === "complete",
    );
    expect(completeChunks.length).toBe(0);
    expect(client.chat.stopStream).toHaveBeenCalled();
  });

  test("streamIncomplete:true is treated as an error, not a silent empty success (CSU-1.1 regression)", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: "",
      streamIncomplete: true,
    });
    const { say } = await invokeDM({ channel: "D1", ts: "1.1" });

    expect(capturedErrors.length).toBe(1);
    expect((capturedErrors[0] as Error).message).toContain(
      "stream ended without a terminal result event",
    );
    // An error reply is posted — a truncated stream must not look like a
    // normal empty/markers-only response with no Slack post at all.
    expect(say).toHaveBeenCalledTimes(1);
  });
});

// ─── message handler tests — thread routing ───────────────────────────────────

describe("message handler — channel thread routing", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
  });

  async function invokeChannelMessage(
    overrides: Partial<{
      text: string;
      channel: string;
      ts: string;
      thread_ts: string;
      channel_type: string;
    }> = {},
    appOverrides: Parameters<typeof createSlackApp>[0] = {},
  ) {
    createSlackApp(appOverrides);
    const client = makeMockClient();
    const say = makeSay();
    const message = {
      channel: "C123",
      ts: "111.222",
      text: "Followup message",
      channel_type: "channel",
      ...overrides,
    };
    await capturedMessageHandler?.({ message, say, client });
    return { client, say };
  }

  test("ignores channel message with no thread_ts", async () => {
    const { say } = await invokeChannelMessage({ thread_ts: undefined });
    expect(mockRunClaude).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  test("ignores channel thread message when no session exists", async () => {
    const { say } = await invokeChannelMessage({ thread_ts: "1.0" });
    expect(mockRunClaude).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  test("routes channel thread message when session exists", async () => {
    createSlackApp({ getSessionFn: mock(async () => "sess-abc") });
    const client = makeMockClient();
    const say = makeSay();
    const message = {
      channel: "C123",
      ts: "1.1",
      text: "Followup message",
      channel_type: "channel",
      thread_ts: "1.0",
    };
    await capturedMessageHandler?.({ message, say, client });
    expect(mockRunClaude).toHaveBeenCalledWith(
      "[Thread message — respond normally, or use [silent] if no response is needed]\nFollowup message",
      "C123:1.0",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "C123", SLACK_THREAD_TS: "1.0" },
    );
    expect(client.chat.appendStream).toHaveBeenCalled();
  });

  // STS-2.1 AC #3: when chat.startStream fails outright (e.g. the real
  // missing_recipient_team_id error this task fixes, or any other cause),
  // finish() must fall back to agents.sessions.setStatus directly rather
  // than only attempting a doomed chat.stopStream call — so the "is
  // working" indicator can still be cleared.
  test("falls back to agents.sessions.setStatus when chat.startStream fails outright (AC #3)", async () => {
    createSlackApp({ getSessionFn: mock(async () => "sess-abc") });
    const client = makeMockClient();
    client.chat.startStream.mockRejectedValueOnce(
      new Error("missing_recipient_team_id"),
    );
    const say = makeSay();
    const message = {
      channel: "C123",
      ts: "1.1",
      text: "Followup message",
      channel_type: "channel",
      thread_ts: "1.0",
    };
    await capturedMessageHandler?.({ message, say, client });

    expect(client.chat.stopStream).not.toHaveBeenCalled();
    expect(client.agents.sessions.setStatus).toHaveBeenCalledWith({
      channel_id: "C123",
      thread_ts: "1.0",
      status: "active",
    });
  });

  test("routes when session exists (session-based routing)", async () => {
    // Routing is exclusively via getSessionFn — no activeThreads lookup
    createSlackApp({
      getSessionFn: mock(async () => "sess-xyz"),
    });
    const client = makeMockClient();
    const say = makeSay();
    const message = {
      channel: "C123",
      ts: "1.1",
      text: "Followup message",
      channel_type: "channel",
      thread_ts: "1.0",
    };
    await capturedMessageHandler?.({ message, say, client });
    expect(mockRunClaude).toHaveBeenCalledWith(
      "[Thread message — respond normally, or use [silent] if no response is needed]\nFollowup message",
      "C123:1.0",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "C123", SLACK_THREAD_TS: "1.0" },
    );
    expect(client.chat.appendStream).toHaveBeenCalled();
  });

  test("routes cron-started thread on first human reply (session exists, no @mention)", async () => {
    // Cron posts to a channel thread → onSession sets session → human replies → should route
    // Simulated by: getSessionFn returns the session the cron registered
    createSlackApp({ getSessionFn: mock(async () => "sess-cron-001") });
    const client = makeMockClient();
    const say = makeSay();
    const message = {
      channel: "C-CRON",
      ts: "200.1",
      text: "Good work bot",
      channel_type: "channel",
      thread_ts: "200.0", // thread started by cron
    };
    await capturedMessageHandler?.({ message, say, client });
    expect(mockRunClaude).toHaveBeenCalledWith(
      "[Thread message — respond normally, or use [silent] if no response is needed]\nGood work bot",
      "C-CRON:200.0",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "C-CRON", SLACK_THREAD_TS: "200.0" },
    );
    expect(client.chat.appendStream).toHaveBeenCalled();
  });

  test("does NOT prepend thread hint for DMs", async () => {
    createSlackApp();
    const client = makeMockClient();
    const say = makeSay();
    const message = {
      channel: "D123",
      ts: "1.1",
      text: "Hello bot",
      channel_type: "im",
      user: "U123",
    };
    await capturedMessageHandler?.({ message, say, client });
    const prompt = mockRunClaude.mock.calls[0][0] as string;
    expect(prompt).not.toContain("[Thread message");
  });

  test("ignores channel message with text-only whitespace", async () => {
    const { say } = await invokeChannelMessage(
      { text: "   ", thread_ts: "1.0" },
      { getSessionFn: async () => "sess-abc" },
    );
    expect(mockRunClaude).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  test("routes with session, ignores without", async () => {
    // With session: routes
    mockRunClaude.mockClear();
    createSlackApp({ getSessionFn: async () => "sess-abc" });
    const client1 = makeMockClient();
    const say1 = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "C123",
        ts: "1.1",
        thread_ts: "1.0",
        text: "hello",
        channel_type: "channel",
      },
      say: say1,
      client: client1,
    });
    expect(mockRunClaude).toHaveBeenCalledTimes(1);

    // Without session: ignores
    mockRunClaude.mockClear();
    createSlackApp({ getSessionFn: async () => undefined });
    const client2 = makeMockClient();
    const say2 = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "C123",
        ts: "1.1",
        thread_ts: "1.0",
        text: "hello",
        channel_type: "channel",
      },
      say: say2,
      client: client2,
    });
    expect(mockRunClaude).not.toHaveBeenCalled();
  });

  test("prepends thread hint for channel thread messages", async () => {
    createSlackApp({ getSessionFn: async () => "sess-abc" });
    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "C123",
        ts: "1.1",
        thread_ts: "1.0",
        text: "Followup message",
        channel_type: "channel",
      },
      say,
      client,
    });
    expect(mockRunClaude).toHaveBeenCalledTimes(1);
    const prompt = mockRunClaude.mock.calls[0][0] as string;
    expect(prompt).toMatch(
      /^\[Thread message — respond normally, or use \[silent\] if no response is needed\]\n/,
    );
  });

  test("does not prepend thread hint for DM messages", async () => {
    createSlackApp();
    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "Direct message",
        channel_type: "im",
      },
      say,
      client,
    });
    expect(mockRunClaude).toHaveBeenCalledTimes(1);
    const prompt = mockRunClaude.mock.calls[0][0] as string;
    expect(prompt).not.toContain("[Thread message");
  });

  test("channel thread: [silent] suppresses say()", async () => {
    mockRunClaude.mockClear();
    mockRunClaude.mockResolvedValueOnce({
      result: "text [silent]",
      sessionId: "s1",
    });
    createSlackApp({ getSessionFn: mock(async () => "sess-xyz") });
    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "C123",
        ts: "2.0",
        thread_ts: "1.0",
        text: "hi",
        channel_type: "channel",
      },
      say,
      client,
    });
    expect(say).not.toHaveBeenCalled();
  });
});

// ─── message handler tests — file handling ────────────────────────────────────

describe("message handler — file handling", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
  });

  test("injects file path into prompt when file downloads successfully", async () => {
    const mockDownloader = mock(async () => "/tmp/test-image.jpg");
    createSlackApp({ fileDownloaderFn: mockDownloader });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "look at this",
        channel_type: "im",
        files: [
          {
            name: "photo.jpg",
            mimetype: "image/jpeg",
            size: 1000,
            url_private: "https://files.slack.com/photo.jpg",
          },
        ],
      },
      say,
      client,
    });

    expect(mockRunClaude).toHaveBeenCalledWith(
      "[file: /tmp/test-image.jpg]\nlook at this",
      "D1:1.1",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "D1", SLACK_THREAD_TS: "1.1" },
    );
  });

  test("routes message with files and no text when files download successfully", async () => {
    const mockDownloader = mock(async () => "/tmp/test.pdf");
    createSlackApp({ fileDownloaderFn: mockDownloader });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        channel_type: "im",
        files: [{ name: "doc.pdf", mimetype: "application/pdf", size: 500 }],
      },
      say,
      client,
    });

    expect(mockRunClaude).toHaveBeenCalledWith(
      "[file: /tmp/test.pdf]",
      "D1:1.1",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "D1", SLACK_THREAD_TS: "1.1" },
    );
  });

  test("continues without file when downloader returns null", async () => {
    const mockDownloader = mock(async () => null);
    createSlackApp({ fileDownloaderFn: mockDownloader });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "here is a file",
        channel_type: "im",
        files: [{ name: "big.zip", mimetype: "application/zip", size: 1000 }],
      },
      say,
      client,
    });

    expect(mockRunClaude).toHaveBeenCalledWith(
      "here is a file",
      "D1:1.1",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "D1", SLACK_THREAD_TS: "1.1" },
    );
  });

  test("continues without file when downloader throws", async () => {
    const mockDownloader = mock(async () => {
      throw new Error("network error");
    });
    createSlackApp({ fileDownloaderFn: mockDownloader });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "with erroring file",
        channel_type: "im",
        files: [{ name: "err.jpg", mimetype: "image/jpeg", size: 1000 }],
      },
      say,
      client,
    });

    expect(mockRunClaude).toHaveBeenCalledWith(
      "with erroring file",
      "D1:1.1",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "D1", SLACK_THREAD_TS: "1.1" },
    );
  });

  test("returns early when no text and no files and files array is empty", async () => {
    createSlackApp();
    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        channel_type: "im",
      },
      say,
      client,
    });
    expect(mockRunClaude).not.toHaveBeenCalled();
  });
});

// ─── app_mention handler tests ────────────────────────────────────────────────

describe("app_mention handler", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
    mockMarkdownToSlack.mockClear();
    createSlackApp();
  });

  async function invokeMention(
    overrides: Partial<{
      text: string;
      channel: string;
      ts: string;
      thread_ts: string;
      user: string;
    }> = {},
  ) {
    const client = makeMockClient();
    const say = makeSay();
    const event = {
      text: "<@UBOT> do something",
      channel: "C999",
      ts: "222.333",
      ...overrides,
    };
    await capturedMentionHandler?.({ event, say, client });
    return { client, say };
  }

  test("calls runClaude with event text and thread sessionKey", async () => {
    await invokeMention({ channel: "C999", ts: "222.333" });
    expect(mockRunClaude).toHaveBeenCalledWith(
      "<@UBOT> do something",
      "C999:222.333",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "C999", SLACK_THREAD_TS: "222.333" },
    );
  });

  test("uses thread_ts as sessionKey when mention is in a thread", async () => {
    await invokeMention({ channel: "C999", ts: "2.2", thread_ts: "1.1" });
    expect(mockRunClaude).toHaveBeenCalledWith(
      "<@UBOT> do something",
      "C999:1.1",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "C999", SLACK_THREAD_TS: "1.1" },
    );
  });

  test("closes the Thinking Steps stream after a successful mention response", async () => {
    const { client } = await invokeMention({ channel: "C999", ts: "222.333" });
    expect(client.chat.stopStream).toHaveBeenCalledWith(
      expect.objectContaining({ session_status: "active" }),
    );
  });

  test("a mention reply never posts via client.chat.postMessage — only the Thinking Steps stream or say()", async () => {
    const { client, say } = await invokeMention({
      channel: "C999",
      ts: "222.333",
    });
    expect(say).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("the mention handler's SlackProgress opens a Thinking Steps stream (STS-1.1)", async () => {
    createSlackApp();
    const { client } = await invokeMention({ channel: "C999", ts: "222.333" });
    // app_mention is never a DM, so recipient_team_id is included — resolved
    // via MockApp's client.auth.test() mock (STS-2.1 AC #1). No `user` on
    // this event, so recipient_user_id stays undefined/omitted.
    expect(client.chat.startStream).toHaveBeenCalledWith({
      channel: "C999",
      thread_ts: "222.333",
      task_display_mode: "timeline",
      recipient_team_id: "T-TEAM",
    });
    expect(client.chat.stopStream).toHaveBeenCalled();
  });

  // STS-2.1 AC #1: a channel mention includes both recipient fields — the
  // triggering user's ID (from the event) and the bot's own team ID
  // (resolved once via client.auth.test() at app construction).
  test("includes recipient_team_id and recipient_user_id on chat.startStream (STS-2.1 AC #1)", async () => {
    createSlackApp();
    const { client } = await invokeMention({
      channel: "C999",
      ts: "222.333",
      user: "U-MENTIONER",
    });
    expect(client.chat.startStream).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient_team_id: "T-TEAM",
        recipient_user_id: "U-MENTIONER",
      }),
    );
  });

  test("delivers the final reply as a markdown_text chunk via chat.appendStream, and skips say() (STS2-2.1 AC #4)", async () => {
    createSlackApp();
    const { client, say } = await invokeMention({
      channel: "C999",
      ts: "222.333",
    });

    const markdownChunks = client.chat.appendStream.mock.calls
      .flatMap(
        (c) => (c[0] as { chunks: Array<Record<string, unknown>> }).chunks,
      )
      .filter((chunk) => chunk.type === "markdown_text");
    expect(markdownChunks).toContainEqual({
      type: "markdown_text",
      text: "Claude response text",
    });
    // Delivered via the stream — say() is not used for the real reply.
    expect(say).not.toHaveBeenCalled();
  });

  test("falls back to say() when chat.appendStream rejects (delivery failure never drops the reply) (STS2-2.1 AC #4)", async () => {
    const client = makeMockClient();
    client.chat.appendStream.mockImplementation(async () => {
      throw new Error("streaming_mode_mismatch");
    });
    const say = makeSay();
    createSlackApp();
    await capturedMentionHandler?.({
      event: {
        text: "<@UBOT> do something",
        channel: "C999",
        ts: "222.333",
      },
      say,
      client,
    });
    expect(say).toHaveBeenCalledWith({
      text: "[formatted] Claude response text",
      thread_ts: "222.333",
    });
  });

  test("passes an onProgress function through to the runner as the third arg on mention (AC #1)", async () => {
    await invokeMention({ channel: "C999", ts: "222.333" });
    const call = mockRunClaude.mock.calls.at(-1) as unknown[];
    expect(call[2]).toBeTypeOf("function");
  });

  test("posts error message when runClaude throws on mention", async () => {
    mockRunClaude.mockRejectedValueOnce(new Error("timeout"));
    const { say } = await invokeMention({ ts: "2.2" });
    expect(say).toHaveBeenCalledWith({
      text: expect.stringContaining("timeout"),
      thread_ts: "2.2",
    });
  });

  test("closes the Thinking Steps stream after mention handler error", async () => {
    mockRunClaude.mockRejectedValueOnce(new Error("timeout"));
    const { client } = await invokeMention({ channel: "C999", ts: "2.2" });
    expect(client.chat.stopStream).toHaveBeenCalledWith(
      expect.objectContaining({ session_status: "active" }),
    );
  });

  test("does not throw when chat.stopStream fails on mention", async () => {
    const client = makeMockClient();
    const say = makeSay();
    client.chat.stopStream.mockRejectedValueOnce(new Error("api error"));

    await expect(
      capturedMentionHandler?.({
        event: { text: "hi", channel: "C1", ts: "1.1" },
        say,
        client,
      }),
    ).resolves.toBeUndefined();
  });

  test("does not call sentryClient.captureException on mention success", async () => {
    await invokeMention({ channel: "C1", ts: "2.2", text: "@bot help" });
    expect(capturedErrors.length).toBe(0);
  });

  test("calls sentryClient.captureException when mention handler throws", async () => {
    mockRunClaude.mockRejectedValueOnce(new Error("oops"));
    await invokeMention({ channel: "C1", ts: "2.2" });
    expect(capturedErrors.length).toBe(1);
    expect((capturedErrors[0] as Error).message).toBe("oops");
  });

  test("marks the Thinking Steps card status:'error' when mention handler throws (STS2-4.1 AC #1)", async () => {
    createSlackApp();
    mockRunClaude.mockRejectedValueOnce(new Error("oops"));
    const { client } = await invokeMention({ channel: "C999", ts: "222.333" });

    const taskUpdateChunks = client.chat.appendStream.mock.calls
      .flatMap(
        (c) => (c[0] as { chunks: Array<Record<string, unknown>> }).chunks,
      )
      .filter((chunk) => chunk.type === "task_update");
    const errorChunks = taskUpdateChunks.filter(
      (chunk) => chunk.status === "error",
    );
    expect(errorChunks.length).toBeGreaterThan(0);

    expect(client.chat.stopStream).toHaveBeenCalled();
    const completeChunks = taskUpdateChunks.filter(
      (chunk) => chunk.status === "complete",
    );
    expect(completeChunks.length).toBe(0);
  });

  test("marks the card status:'error' even when the catch block's say() itself throws on mention (STS2-4.1 AC #1 — #3064 review)", async () => {
    // Both the run AND the error-notification say() fail. reportError() must
    // still fire (it runs before say() in the catch block), so finish() never
    // sends a "Done" card for a run that both errored and failed to notify.
    const client = makeMockClient();
    const say = mock(async (_args: unknown) => {
      throw new Error("invalid_auth");
    });
    createSlackApp();
    mockRunClaude.mockRejectedValueOnce(new Error("oops"));

    await capturedMentionHandler?.({
      event: { text: "<@UBOT> do something", channel: "C999", ts: "222.333" },
      say,
      client,
    });

    const taskUpdateChunks = client.chat.appendStream.mock.calls
      .flatMap(
        (c) => (c[0] as { chunks: Array<Record<string, unknown>> }).chunks,
      )
      .filter((chunk) => chunk.type === "task_update");
    const errorChunks = taskUpdateChunks.filter(
      (chunk) => chunk.status === "error",
    );
    expect(errorChunks.length).toBeGreaterThan(0);

    const completeChunks = taskUpdateChunks.filter(
      (chunk) => chunk.status === "complete",
    );
    expect(completeChunks.length).toBe(0);
    expect(client.chat.stopStream).toHaveBeenCalled();
  });

  test("streamIncomplete:true on mention is treated as an error, not a silent empty success (CSU-1.1 regression)", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: "",
      streamIncomplete: true,
    });
    const { say } = await invokeMention({ channel: "C1", ts: "2.2" });

    expect(capturedErrors.length).toBe(1);
    expect((capturedErrors[0] as Error).message).toContain(
      "stream ended without a terminal result event",
    );
    expect(say).toHaveBeenCalledTimes(1);
  });

  test("app_mention in active thread: runClaude not called when session exists", async () => {
    // The fix: when thread_ts is set and getSessionFn returns a session, the
    // app_mention handler returns early — the message handler already covers it
    // and would double-respond otherwise.
    createSlackApp({ getSessionFn: async () => "sess-existing" });
    const client = makeMockClient();
    const say = makeSay();
    await capturedMentionHandler?.({
      event: {
        text: "<@UBOT> follow-up in thread",
        channel: "C999",
        ts: "3.3",
        thread_ts: "1.0",
      },
      say,
      client,
    });
    expect(mockRunClaude).not.toHaveBeenCalled();
  });
});

// ─── app_mention handler — file handling ─────────────────────────────────────

describe("app_mention handler — file handling", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
  });

  async function invokeMentionWithFiles(
    overrides: {
      files?: SlackFile[];
      text?: string;
      fileDownloaderFn?: (
        file: SlackFile,
        botToken: string,
      ) => Promise<string | null>;
      transcribeAudioFn?: TranscribeAudioFn;
    } = {},
  ) {
    const {
      files,
      text = "<@UBOT> look at this",
      fileDownloaderFn,
      transcribeAudioFn,
    } = overrides;
    createSlackApp({
      fileDownloaderFn: fileDownloaderFn ?? (async () => null),
      transcribeAudioFn: transcribeAudioFn ?? (async () => null),
    });
    const client = makeMockClient();
    const say = makeSay();
    const event = {
      text,
      channel: "C999",
      ts: "222.333",
      ...(files !== undefined ? { files } : {}),
    };
    await capturedMentionHandler?.({ event, say, client });
    return { client, say };
  }

  test("injects file path into prompt when file attached to @mention downloads successfully", async () => {
    const mockDownloader = mock(async () => "/tmp/test-mention-image.jpg");
    await invokeMentionWithFiles({
      fileDownloaderFn: mockDownloader,
      files: [
        {
          name: "photo.jpg",
          mimetype: "image/jpeg",
          size: 1000,
          url_private: "https://files.slack.com/photo.jpg",
        },
      ],
    });

    expect(mockRunClaude).toHaveBeenCalledWith(
      "[file: /tmp/test-mention-image.jpg]\n<@UBOT> look at this",
      "C999:222.333",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "C999", SLACK_THREAD_TS: "222.333" },
    );
  });

  test("transcribes audio file attached to @mention and injects [voice transcript: ...]", async () => {
    const mockTranscribe = mock(
      async (_path: string, _cfg: unknown) => "hello from voice",
    );
    const mockDownloader = mock(async () => "/tmp/mention-voice.webm");
    await invokeMentionWithFiles({
      fileDownloaderFn: mockDownloader,
      transcribeAudioFn: mockTranscribe,
      files: [{ name: "voice.webm", mimetype: "audio/webm", size: 1000 }],
    });

    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    const prompt = mockRunClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("[voice transcript: hello from voice]");
  });

  test("continues without file when downloader returns null on @mention", async () => {
    const mockDownloader = mock(async () => null);
    await invokeMentionWithFiles({
      fileDownloaderFn: mockDownloader,
      files: [{ name: "big.zip", mimetype: "application/zip", size: 1000 }],
      text: "<@UBOT> here is a file",
    });

    expect(mockRunClaude).toHaveBeenCalledWith(
      "<@UBOT> here is a file",
      "C999:222.333",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "C999", SLACK_THREAD_TS: "222.333" },
    );
  });

  test("continues without file when downloader throws on @mention", async () => {
    const mockDownloader = mock(async () => {
      throw new Error("network error");
    });
    await invokeMentionWithFiles({
      fileDownloaderFn: mockDownloader,
      files: [{ name: "err.jpg", mimetype: "image/jpeg", size: 1000 }],
      text: "<@UBOT> with erroring file",
    });

    expect(mockRunClaude).toHaveBeenCalledWith(
      "<@UBOT> with erroring file",
      "C999:222.333",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "C999", SLACK_THREAD_TS: "222.333" },
    );
  });

  test("falls back to [file: ...] when audio transcription returns null on @mention", async () => {
    const mockTranscribe = mock(async () => null);
    const mockDownloader = mock(async () => "/tmp/mention-voice.webm");
    await invokeMentionWithFiles({
      fileDownloaderFn: mockDownloader,
      transcribeAudioFn: mockTranscribe,
      files: [{ name: "voice.webm", mimetype: "audio/webm", size: 1000 }],
    });

    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    const prompt = mockRunClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("[file: /tmp/mention-voice.webm]");
  });

  test("does not transcribe non-audio file attached to @mention", async () => {
    const mockTranscribe = mock(async () => "should not be called");
    const mockDownloader = mock(async () => "/tmp/mention-image.jpg");
    await invokeMentionWithFiles({
      fileDownloaderFn: mockDownloader,
      transcribeAudioFn: mockTranscribe,
      files: [{ name: "photo.jpg", mimetype: "image/jpeg", size: 1000 }],
    });

    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(mockRunClaude).toHaveBeenCalledWith(
      "[file: /tmp/mention-image.jpg]\n<@UBOT> look at this",
      "C999:222.333",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "C999", SLACK_THREAD_TS: "222.333" },
    );
  });
});

// ─── downloadFile unit tests ──────────────────────────────────────────────────

describe("downloadFile", () => {
  test("returns null for files exceeding 10MB", async () => {
    const file: SlackFile = {
      name: "big.bin",
      mimetype: "application/octet-stream",
      size: 11 * 1024 * 1024,
      url_private: "https://files.slack.com/big.bin",
    };
    const result = await downloadFile(file, "xoxb-token");
    expect(result).toBeNull();
  });

  test("returns null when url_private is missing", async () => {
    const file: SlackFile = {
      name: "nurl.txt",
      mimetype: "text/plain",
      size: 100,
    };
    const result = await downloadFile(file, "xoxb-token");
    expect(result).toBeNull();
  });
});

// ─── Marker dispatch — DM handler ─────────────────────────────────────────────

describe("marker dispatch — DM message handler", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
    createSlackApp();
  });

  async function invokeDMWithResult(result: string) {
    mockRunClaude.mockResolvedValueOnce({ result, sessionId: "sess-1" });
    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "hello",
        channel_type: "im",
      },
      say,
      client,
    });
    return { client, say };
  }

  test("[silent] — skips say() and closes the Thinking Steps stream", async () => {
    const { say, client } = await invokeDMWithResult("[silent]");
    expect(say).not.toHaveBeenCalled();
    expect(client.chat.stopStream).toHaveBeenCalledWith(
      expect.objectContaining({ session_status: "active" }),
    );
  });

  test("[silent] with content — DM ignores silent and posts anyway", async () => {
    const { say, client } = await invokeDMWithResult(
      "Here is your answer.\n[silent]",
    );
    expect(say).not.toHaveBeenCalled();
    const markdownChunks = client.chat.appendStream.mock.calls
      .flatMap(
        (c) => (c[0] as { chunks: Array<Record<string, unknown>> }).chunks,
      )
      .filter((chunk) => chunk.type === "markdown_text");
    expect(markdownChunks).toHaveLength(1);
    const text = markdownChunks[0]?.text as string;
    expect(text).toContain("Here is your answer.");
    expect(text).not.toContain("[silent]");
  });

  test("[upload:/path] — uploads file to Slack", async () => {
    // Write a temp file to upload
    const tmpPath = join(tmpdir(), `test-upload-${Date.now()}.txt`);
    writeFileSync(tmpPath, "upload content");
    const { client } = await invokeDMWithResult(`[upload:${tmpPath}]`);
    expect(client.files.uploadV2).toHaveBeenCalledTimes(1);
    const uploadCall = (
      client.files.uploadV2.mock.calls[0] as [Record<string, unknown>]
    )[0];
    expect(uploadCall.channel_id).toBe("D1");
    expect(uploadCall.filename).toBe(tmpPath.split("/").pop());
    unlinkSync(tmpPath);
  });

  test("[upload:/path] — skips upload when file does not exist", async () => {
    const { client } = await invokeDMWithResult(
      "[upload:/nonexistent/file.txt]",
    );
    expect(client.files.uploadV2).not.toHaveBeenCalled();
  });
});

// ─── Marker dispatch — app_mention handler ────────────────────────────────────

describe("marker dispatch — app_mention handler", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
    createSlackApp();
  });

  async function invokeMentionWithResult(result: string) {
    mockRunClaude.mockResolvedValueOnce({ result, sessionId: "sess-1" });
    const client = makeMockClient();
    const say = makeSay();
    await capturedMentionHandler?.({
      event: { text: "@bot help", channel: "C1", ts: "1.1" },
      say,
      client,
    });
    return { client, say };
  }

  test("[silent] — skips say() in mention handler", async () => {
    const { say } = await invokeMentionWithResult("[silent]");
    expect(say).not.toHaveBeenCalled();
  });

  test("[upload:/path] — skips upload when file not found in mention handler", async () => {
    const { client } = await invokeMentionWithResult(
      "Here [upload:/nonexistent/mention-file.txt]",
    );
    expect(client.files.uploadV2).not.toHaveBeenCalled();
  });

  test("[upload:/path] — uploads file in mention handler", async () => {
    const tmpPath = join(tmpdir(), `test-mention-upload-${Date.now()}.txt`);
    writeFileSync(tmpPath, "mention upload content");
    const { client } = await invokeMentionWithResult(`[upload:${tmpPath}]`);
    expect(client.files.uploadV2).toHaveBeenCalledTimes(1);
    const uploadCall = (
      client.files.uploadV2.mock.calls[0] as [Record<string, unknown>]
    )[0];
    expect(uploadCall.channel_id).toBe("C1");
    unlinkSync(tmpPath);
  });
});

// ─── Voice integration tests ──────────────────────────────────────────────────

describe("voice integration — audio transcription in DM handler", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
  });

  test("transcribes audio/* file and passes transcript to Claude", async () => {
    const mockTranscribe = mock(
      async (_path: string, _cfg: unknown) => "hello from audio",
    );
    const mockDownloader = mock(async () => "/tmp/test-voice.webm");
    createSlackApp({
      transcribeAudioFn: mockTranscribe,
      fileDownloaderFn: mockDownloader,
    });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "listen to this",
        channel_type: "im",
        files: [{ name: "voice.webm", mimetype: "audio/webm", size: 1000 }],
      },
      say,
      client,
    });

    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    const prompt = mockRunClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("[voice transcript: hello from audio]");
  });

  test("falls back to [file:] when transcription returns null", async () => {
    const mockTranscribe = mock(async () => null);
    const mockDownloader = mock(async () => "/tmp/test-audio.webm");
    createSlackApp({
      transcribeAudioFn: mockTranscribe,
      fileDownloaderFn: mockDownloader,
    });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "audio",
        channel_type: "im",
        files: [{ name: "voice.webm", mimetype: "audio/webm", size: 1000 }],
      },
      say,
      client,
    });

    const prompt = mockRunClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("[file: /tmp/test-audio.webm]");
  });

  test("non-audio files are not transcribed", async () => {
    const mockTranscribe = mock(async () => "should not be called");
    const mockDownloader = mock(async () => "/tmp/image.jpg");
    createSlackApp({
      transcribeAudioFn: mockTranscribe,
      fileDownloaderFn: mockDownloader,
    });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "image",
        channel_type: "im",
        files: [{ name: "photo.jpg", mimetype: "image/jpeg", size: 1000 }],
      },
      say,
      client,
    });

    expect(mockTranscribe).not.toHaveBeenCalled();
    const prompt = mockRunClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("[file: /tmp/image.jpg]");
  });

  test("audio/m4a file → transcribeAudioFn called with downloaded path → prompt contains [voice transcript: ...]", async () => {
    const mockTranscribe = mock(
      async (_path: string, _cfg: unknown) => "transcribed voice note",
    );
    const mockDownloader = mock(async () => "/tmp/voice-note.m4a");
    createSlackApp({
      transcribeAudioFn: mockTranscribe,
      fileDownloaderFn: mockDownloader,
    });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "voice note",
        channel_type: "im",
        files: [{ name: "voice.m4a", mimetype: "audio/m4a", size: 2000 }],
      },
      say,
      client,
    });

    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    expect(mockTranscribe).toHaveBeenCalledWith("/tmp/voice-note.m4a", {});
    const prompt = mockRunClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("[voice transcript: transcribed voice note]");
  });
});

// ─── User name context tests ──────────────────────────────────────────────────

describe("user name context — message handler", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
    mockResolveUserFn.mockClear();
    createSlackApp();
  });

  test("prepends [Name]: to prompt when user field is present", async () => {
    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "hello",
        channel_type: "im",
        user: "U123",
      },
      say,
      client,
    });
    expect(mockRunClaude).toHaveBeenCalledWith(
      "[Dan]: hello",
      "D1:1.1",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "D1", SLACK_THREAD_TS: "1.1" },
    );
  });

  test("does not prepend when user field is absent", async () => {
    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "hello",
        channel_type: "im",
      },
      say,
      client,
    });
    expect(mockRunClaude).toHaveBeenCalledWith(
      "hello",
      "D1:1.1",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "D1", SLACK_THREAD_TS: "1.1" },
    );
  });
});

describe("user name context — app_mention handler", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
    mockResolveUserFn.mockClear();
    createSlackApp();
  });

  test("prepends [Name]: to event text when event.user is present", async () => {
    const client = makeMockClient();
    const say = makeSay();
    await capturedMentionHandler?.({
      event: {
        text: "<@UBOT> do something",
        channel: "C999",
        ts: "222.333",
        user: "U456",
      },
      say,
      client,
    });
    expect(mockRunClaude).toHaveBeenCalledWith(
      "[Dan]: <@UBOT> do something",
      "C999:222.333",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "C999", SLACK_THREAD_TS: "222.333" },
    );
  });

  test("does not prepend when event.user is absent", async () => {
    const client = makeMockClient();
    const say = makeSay();
    await capturedMentionHandler?.({
      event: {
        text: "<@UBOT> do something",
        channel: "C999",
        ts: "222.333",
      },
      say,
      client,
    });
    expect(mockRunClaude).toHaveBeenCalledWith(
      "<@UBOT> do something",
      "C999:222.333",
      expect.any(Function),
      { SLACK_CHANNEL_ID: "C999", SLACK_THREAD_TS: "222.333" },
    );
  });
});

describe("voice integration — [speak:text] marker dispatch", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
  });

  test("[speak:text] in DM — synthesizes speech and uploads audio file", async () => {
    const outPath = join(tmpdir(), `test-speak-${Date.now()}.mp3`);
    writeFileSync(outPath, Buffer.from("fake audio"));
    const mockSynthesize = mock(async () => outPath);
    createSlackApp({ synthesizeSpeechFn: mockSynthesize });

    mockRunClaude.mockResolvedValueOnce({
      result: "Here is the answer. [speak:Here is the answer]",
    });
    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "speak to me",
        channel_type: "im",
      },
      say,
      client,
    });

    expect(mockSynthesize).toHaveBeenCalledWith("Here is the answer", {});
    expect(client.files.uploadV2).toHaveBeenCalledTimes(1);
    const uploadArgs = (
      client.files.uploadV2.mock.calls[0] as [Record<string, unknown>]
    )[0];
    expect(uploadArgs.channel_id).toBe("D1");
    unlinkSync(outPath);
  });

  test("[speak:text] in DM — posts text fallback when synthesis returns null", async () => {
    const mockSynthesize = mock(async () => null);
    createSlackApp({ synthesizeSpeechFn: mockSynthesize });

    mockRunClaude.mockResolvedValueOnce({
      result: "[speak:hello]",
    });
    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "speak",
        channel_type: "im",
      },
      say,
      client,
    });

    expect(client.files.uploadV2).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "D1", text: "hello" }),
    );
  });

  test("[speak:text] in DM — skips text fallback when synthesis fails and marker echoes the posted reply", async () => {
    const mockSynthesize = mock(async () => null);
    createSlackApp({ synthesizeSpeechFn: mockSynthesize });

    mockRunClaude.mockResolvedValueOnce({
      result: "Here is the answer. [speak:Here is the answer]",
    });
    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "speak to me",
        channel_type: "im",
      },
      say,
      client,
    });

    // The visible reply was already posted via say(); the fallback must not
    // post a near-duplicate copy of it via chat.postMessage.
    expect(client.files.uploadV2).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("[silent] + [speak:text] in channel — synthesis failure still posts fallback (suppressed reply must not count as posted)", async () => {
    const mockSynthesize = mock(async () => null);
    createSlackApp({
      synthesizeSpeechFn: mockSynthesize,
      getSessionFn: mock(async () => "sess-xyz"),
    });

    // [silent] suppresses the say() reply in a non-DM channel, but the
    // [speak:text] marker echoes the suppressed `cleaned` text. Since the
    // text was never actually posted, the duplicate-content guard must not
    // treat it as already-shown — the fallback should still post.
    mockRunClaude.mockResolvedValueOnce({
      result: "Here is the answer. [speak:Here is the answer] [silent]",
    });
    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "C123",
        ts: "2.0",
        thread_ts: "1.0",
        text: "hi",
        channel_type: "channel",
      },
      say,
      client,
    });

    expect(say).not.toHaveBeenCalled();
    expect(client.files.uploadV2).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Here is the answer" }),
    );
  });

  test("[speak:text] in mention — synthesizes and uploads", async () => {
    const outPath = join(tmpdir(), `test-speak-mention-${Date.now()}.mp3`);
    writeFileSync(outPath, Buffer.from("fake audio"));
    const mockSynthesize = mock(async () => outPath);
    createSlackApp({ synthesizeSpeechFn: mockSynthesize });

    mockRunClaude.mockResolvedValueOnce({
      result: "Reply. [speak:Reply]",
    });
    const client = makeMockClient();
    const say = makeSay();
    await capturedMentionHandler?.({
      event: { text: "@bot speak", channel: "C1", ts: "1.1" },
      say,
      client,
    });

    expect(mockSynthesize).toHaveBeenCalledWith("Reply", {});
    expect(client.files.uploadV2).toHaveBeenCalledTimes(1);
    unlinkSync(outPath);
  });

  test("[speak:hello] → synthesizeSpeechFn('hello', voiceConfig) → files.uploadV2 called with returned audio path", async () => {
    const outPath = join(tmpdir(), `test-speak-hello-${Date.now()}.mp3`);
    writeFileSync(outPath, Buffer.from("hello audio"));
    const testVoiceConfig: VoiceConfig = { voiceId: "test-voice" };
    const mockSynthesize = mock(async () => outPath);
    createSlackApp({
      synthesizeSpeechFn: mockSynthesize,
      voiceConfig: testVoiceConfig,
    });

    mockRunClaude.mockResolvedValueOnce({
      result: "[speak:hello]",
    });
    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "say hello",
        channel_type: "im",
      },
      say,
      client,
    });

    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    expect(mockSynthesize).toHaveBeenCalledWith("hello", testVoiceConfig);
    expect(client.files.uploadV2).toHaveBeenCalledTimes(1);
    const uploadArgs = (
      client.files.uploadV2.mock.calls[0] as [Record<string, unknown>]
    )[0];
    const expectedFilename = outPath.split("/").pop();
    expect(uploadArgs.filename).toBe(expectedFilename);
    unlinkSync(outPath);
  });

  test("[speak:text] only response in DM — does not call say, still synthesizes and uploads", async () => {
    const outPath = join(tmpdir(), `test-speak-only-${Date.now()}.mp3`);
    writeFileSync(outPath, Buffer.from("audio only"));
    const mockSynthesize = mock(async () => outPath);
    createSlackApp({ synthesizeSpeechFn: mockSynthesize });

    mockRunClaude.mockResolvedValueOnce({
      result: "[speak:Got your message loud and clear]",
    });
    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "hello",
        channel_type: "im",
      },
      say,
      client,
    });

    expect(say).not.toHaveBeenCalled();
    expect(mockSynthesize).toHaveBeenCalledWith(
      "Got your message loud and clear",
      {},
    );
    expect(client.files.uploadV2).toHaveBeenCalledTimes(1);
    unlinkSync(outPath);
  });

  test("[speak:text] only response in mention — does not call say, still synthesizes and uploads", async () => {
    const outPath = join(tmpdir(), `test-speak-only-mention-${Date.now()}.mp3`);
    writeFileSync(outPath, Buffer.from("audio only"));
    const mockSynthesize = mock(async () => outPath);
    createSlackApp({ synthesizeSpeechFn: mockSynthesize });

    mockRunClaude.mockResolvedValueOnce({
      result: "[speak:On it]",
    });
    const client = makeMockClient();
    const say = makeSay();
    await capturedMentionHandler?.({
      event: { text: "@bot hey", channel: "C1", ts: "1.1" },
      say,
      client,
    });

    expect(say).not.toHaveBeenCalled();
    expect(mockSynthesize).toHaveBeenCalledWith("On it", {});
    expect(client.files.uploadV2).toHaveBeenCalledTimes(1);
    unlinkSync(outPath);
  });

  test("[speak:text] only response in reaction_added — does not call postMessage, still synthesizes and uploads", async () => {
    const outPath = join(
      tmpdir(),
      `test-speak-only-reaction-${Date.now()}.mp3`,
    );
    writeFileSync(outPath, Buffer.from("audio only"));
    const mockSynthesize = mock(async () => outPath);
    createSlackApp({ synthesizeSpeechFn: mockSynthesize });

    mockRunClaude.mockResolvedValueOnce({ result: "[speak:Noted]" });
    const client = makeMockClient();
    await capturedReactionAddedHandler?.({
      event: {
        reaction: "thumbsup",
        item: { type: "message", channel: "D1", ts: "100.1" },
        item_user: "UBOT123",
        user: "U-DAN",
      },
      client,
    });

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(mockSynthesize).toHaveBeenCalledWith("Noted", {});
    expect(client.files.uploadV2).toHaveBeenCalledTimes(1);
    unlinkSync(outPath);
  });
});

// ─── voiceConfig presence vs absence ─────────────────────────────────────────

describe("createSlackApp — voiceConfig option set vs absent", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
  });

  test("voiceConfig absent — [speak:text] does not upload or error (no synthesizeFn)", async () => {
    createSlackApp({ synthesizeSpeechFn: async () => null });
    mockRunClaude.mockResolvedValueOnce({
      result: "[speak:hello]",
      sessionId: "sess-v1",
    });
    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: { channel: "D1", ts: "1.1", text: "hi", channel_type: "im" },
      say,
      client,
    });
    expect(client.files.uploadV2).not.toHaveBeenCalled();
  });

  test("voiceConfig present — synthesizeFn called with provided config", async () => {
    const testVoiceConfig: VoiceConfig = { voiceId: "cfg-voice" };
    const outPath = join(tmpdir(), `test-vc-present-${Date.now()}.mp3`);
    writeFileSync(outPath, Buffer.from("audio"));
    const mockSynthesize = mock(async () => outPath);
    createSlackApp({
      voiceConfig: testVoiceConfig,
      synthesizeSpeechFn: mockSynthesize,
    });
    mockRunClaude.mockResolvedValueOnce({
      result: "[speak:test]",
      sessionId: "sess-v2",
    });
    const client = makeMockClient();
    const say = makeSay();
    await capturedMessageHandler?.({
      message: { channel: "D1", ts: "1.2", text: "hi", channel_type: "im" },
      say,
      client,
    });
    expect(mockSynthesize).toHaveBeenCalledWith("test", testVoiceConfig);
    unlinkSync(outPath);
  });
});

// ─── [react:emoji] dispatch — DM message handler ──────────────────────────────

describe("marker dispatch — [react:emoji] in DM message handler", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
    createSlackApp();
  });

  async function invokeDMWithResult(result: string, msgTs = "1.1") {
    mockRunClaude.mockResolvedValueOnce({ result, sessionId: "sess-1" });
    const client = makeMockClient();
    // [react:] only fires against a real posted message ts (postedTs) — the
    // streaming delivery path never produces one (deliverContent() doesn't
    // post a separate reactable message), so force the say() fallback to
    // exercise the marker.
    client.chat.appendStream.mockRejectedValue(new Error("stream unavailable"));
    // makeSay defaults replyTs to "reply.ts.1" — distinct from msgTs
    const say = makeSay();
    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: msgTs,
        text: "hello",
        channel_type: "im",
      },
      say,
      client,
    });
    return { client, say };
  }

  test("[react:thumbsup] — calls reactions.add with correct args on posted message", async () => {
    // say returns "reply.ts.1" (the posted reply ts), distinct from the incoming msg ts
    const { client } = await invokeDMWithResult("Got it! [react:thumbsup]");
    expect(client.reactions.add).toHaveBeenCalledTimes(1);
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "D1",
      timestamp: "reply.ts.1",
      name: "thumbsup",
    });
  });

  test("[react:thumbsup,tada] — calls reactions.add for each emoji", async () => {
    const { client } = await invokeDMWithResult("Done! [react:thumbsup,tada]");
    expect(client.reactions.add).toHaveBeenCalledTimes(2);
    const calls = client.reactions.add.mock.calls as [
      { channel: string; timestamp: string; name: string },
    ][];
    expect(calls[0][0].name).toBe("thumbsup");
    expect(calls[1][0].name).toBe("tada");
  });

  test("[react:emoji] is stripped from posted text", async () => {
    const { say } = await invokeDMWithResult(
      "Here you go [react:white_check_mark]",
    );
    const postedText = (say.mock.calls[0] as [{ text: string }])[0].text;
    expect(postedText).not.toContain("[react:");
  });

  test("no reactions.add call when no [react:] marker", async () => {
    const { client } = await invokeDMWithResult("Plain response");
    expect(client.reactions.add).not.toHaveBeenCalled();
  });

  test("[react:emoji] skipped when response is silent", async () => {
    const { client } = await invokeDMWithResult("[react:thumbsup][silent]");
    // [silent] in DM with no cleaned text → suppressed; reactions should not be added
    expect(client.reactions.add).not.toHaveBeenCalled();
  });
});

// ─── [react:emoji] dispatch — app_mention handler ────────────────────────────

describe("marker dispatch — [react:emoji] in app_mention handler", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
    createSlackApp();
  });

  async function invokeMentionWithResult(result: string) {
    mockRunClaude.mockResolvedValueOnce({ result, sessionId: "sess-1" });
    const client = makeMockClient();
    // [react:] only fires against a real posted message ts (postedTs) — the
    // streaming delivery path never produces one, so force the say()
    // fallback to exercise the marker.
    client.chat.appendStream.mockRejectedValue(new Error("stream unavailable"));
    const say = makeSay(); // returns "reply.ts.1"
    await capturedMentionHandler?.({
      event: { text: "@bot help", channel: "C1", ts: "1.1" },
      say,
      client,
    });
    return { client, say };
  }

  test("[react:rocket] in mention — calls reactions.add on reply", async () => {
    const { client } = await invokeMentionWithResult("On it! [react:rocket]");
    expect(client.reactions.add).toHaveBeenCalledTimes(1);
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "reply.ts.1",
      name: "rocket",
    });
  });

  test("[react:thumbsup,tada] in mention — calls reactions.add for each emoji", async () => {
    const { client } = await invokeMentionWithResult(
      "On it! [react:thumbsup,tada]",
    );
    expect(client.reactions.add).toHaveBeenCalledTimes(2);
  });

  test("[react:emoji] stripped from mention reply text", async () => {
    const { say } = await invokeMentionWithResult(
      "Done! [react:white_check_mark]",
    );
    const postedText = (say.mock.calls[0] as [{ text: string }])[0].text;
    expect(postedText).not.toContain("[react:");
  });
});

// ─── reaction_added handler ───────────────────────────────────────────────────

describe("reaction_added handler", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
  });

  async function invokeReactionAdded(
    overrides: {
      reaction?: string;
      item?: { type: string; channel: string; ts: string };
      item_user?: string;
      user?: string;
      client?: ReturnType<typeof makeMockClient>;
    } = {},
  ) {
    const {
      reaction = "thumbsup",
      item = { type: "message", channel: "D1", ts: "100.1" },
      item_user = "UBOT123",
      user = "U-DAN",
    } = overrides;

    createSlackApp();
    const client = overrides.client ?? makeMockClient();
    await capturedReactionAddedHandler?.({
      event: { reaction, item, item_user, user },
      client,
    });
    return { client };
  }

  /** A client with delivery forced to fail, so client.chat.postMessage's
   * say()-equivalent fallback path (and its postedTs) gets exercised —
   * the streaming path never produces a reactable message ts. */
  function makeFallbackForcedClient() {
    const client = makeMockClient();
    client.chat.appendStream.mockRejectedValue(new Error("stream unavailable"));
    return client;
  }

  test("registers a reaction_added event handler", () => {
    createSlackApp();
    expect(capturedReactionAddedHandler).toBeTypeOf("function");
  });

  test("invokes Claude with the session key for the reacted message", async () => {
    await invokeReactionAdded();
    expect(mockRunClaude).toHaveBeenCalledTimes(1);
    // Runner receives the session key — it resolves the session ID internally
    expect(mockRunClaude.mock.calls[0][1]).toBe("D1:100.1");
  });

  test("passes an onProgress function through to the runner as the third arg (AC #1)", async () => {
    await invokeReactionAdded();
    expect(mockRunClaude.mock.calls[0][2]).toBeTypeOf("function");
  });

  test("delivers the reaction reply via the Thinking Steps stream, not client.chat.postMessage", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: "Logged your walk!",
      sessionId: "sess-progress-1",
    });
    const { client } = await invokeReactionAdded();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    const markdownChunks = client.chat.appendStream.mock.calls
      .flatMap(
        (c) => (c[0] as { chunks: Array<Record<string, unknown>> }).chunks,
      )
      .filter((chunk) => chunk.type === "markdown_text");
    expect(markdownChunks).toContainEqual({
      type: "markdown_text",
      text: "Logged your walk!",
    });
  });

  test("the reaction_added handler's SlackProgress opens a Thinking Steps stream (STS-1.1)", async () => {
    createSlackApp();
    const client = makeMockClient();
    await capturedReactionAddedHandler?.({
      event: {
        reaction: "thumbsup",
        item: { type: "message", channel: "D1", ts: "100.1" },
        item_user: "UBOT123",
        user: "U-DAN",
      },
      client,
    });
    // reaction_added is gated to DM channels only (`channel.startsWith("D")`)
    // — recipient_team_id/recipient_user_id are always omitted here even
    // though a `user` is present on the event (STS-2.1 AC #2).
    expect(client.chat.startStream).toHaveBeenCalledWith({
      channel: "D1",
      thread_ts: "100.1",
      task_display_mode: "timeline",
    });
    expect(client.chat.stopStream).toHaveBeenCalled();
  });

  test("delivers the final reply as a markdown_text chunk via chat.appendStream, and skips client.chat.postMessage() (STS2-2.1 AC #4)", async () => {
    createSlackApp();
    const client = makeMockClient();
    await capturedReactionAddedHandler?.({
      event: {
        reaction: "thumbsup",
        item: { type: "message", channel: "D1", ts: "100.1" },
        item_user: "UBOT123",
        user: "U-DAN",
      },
      client,
    });

    const markdownChunks = client.chat.appendStream.mock.calls
      .flatMap(
        (c) => (c[0] as { chunks: Array<Record<string, unknown>> }).chunks,
      )
      .filter((chunk) => chunk.type === "markdown_text");
    expect(markdownChunks).toContainEqual({
      type: "markdown_text",
      text: "Claude response text",
    });
    // Delivered via the stream — postMessage() is not used for the real reply.
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("falls back to client.chat.postMessage() when chat.appendStream rejects (delivery failure never drops the reply) (STS2-2.1 AC #4)", async () => {
    createSlackApp();
    const client = makeMockClient();
    client.chat.appendStream.mockImplementation(async () => {
      throw new Error("streaming_mode_mismatch");
    });
    await capturedReactionAddedHandler?.({
      event: {
        reaction: "thumbsup",
        item: { type: "message", channel: "D1", ts: "100.1" },
        item_user: "UBOT123",
        user: "U-DAN",
      },
      client,
    });
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "D1",
      text: "[formatted] Claude response text",
    });
  });

  test("marks the Thinking Steps card status:'error' when runClaude throws (STS2-4.1 AC #1)", async () => {
    createSlackApp();
    mockRunClaude.mockRejectedValueOnce(new Error("boom"));
    const client = makeMockClient();
    await capturedReactionAddedHandler?.({
      event: {
        reaction: "thumbsup",
        item: { type: "message", channel: "D1", ts: "100.1" },
        item_user: "UBOT123",
        user: "U-DAN",
      },
      client,
    });

    const taskUpdateChunks = client.chat.appendStream.mock.calls
      .flatMap(
        (c) => (c[0] as { chunks: Array<Record<string, unknown>> }).chunks,
      )
      .filter((chunk) => chunk.type === "task_update");
    const errorChunks = taskUpdateChunks.filter(
      (chunk) => chunk.status === "error",
    );
    expect(errorChunks.length).toBeGreaterThan(0);

    expect(client.chat.stopStream).toHaveBeenCalled();
    const completeChunks = taskUpdateChunks.filter(
      (chunk) => chunk.status === "complete",
    );
    expect(completeChunks.length).toBe(0);
  });

  test("builds prompt containing emoji name and display name", async () => {
    mockResolveUserFn.mockResolvedValueOnce("Dan");
    await invokeReactionAdded({ reaction: "tada" });
    const prompt = mockRunClaude.mock.calls[0][0] as string;
    expect(prompt).toContain(":tada:");
    expect(prompt).toContain("Dan");
  });

  test("ignores reaction on non-message item type", async () => {
    await invokeReactionAdded({
      item: { type: "file", channel: "D1", ts: "100.1" },
    });
    expect(mockRunClaude).not.toHaveBeenCalled();
  });

  test("ignores reaction not on bot's own message (item_user !== botUserId)", async () => {
    await invokeReactionAdded({ item_user: "U-OTHER-USER" });
    expect(mockRunClaude).not.toHaveBeenCalled();
  });

  test("ignores reaction in non-DM channel", async () => {
    await invokeReactionAdded({
      item: { type: "message", channel: "C-GENERAL", ts: "100.1" },
    });
    expect(mockRunClaude).not.toHaveBeenCalled();
  });

  test("posts Claude response to DM via client.chat.postMessage when the stream is unavailable", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: "Logged your walk!",
      sessionId: "sess-2",
    });
    const { client } = await invokeReactionAdded({
      client: makeFallbackForcedClient(),
    });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const callArg = (
      client.chat.postMessage.mock.calls[0] as [Record<string, unknown>]
    )[0];
    expect(callArg.channel).toBe("D1");
    expect(callArg.text).toContain("Logged your walk!");
  });

  test("streamIncomplete:true does not post — treated as a failed run, not a silent success (CSU-1.1 regression)", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: "",
      streamIncomplete: true,
    });
    const { client } = await invokeReactionAdded({});
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("skips post when Claude returns [silent]", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: "[silent]",
      sessionId: "sess-3",
    });
    const { client } = await invokeReactionAdded({});
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("ignores all reactions when botUserId is undefined", async () => {
    createSlackApp({ botUserId: undefined });
    const client = makeMockClient();
    await capturedReactionAddedHandler?.({
      event: {
        reaction: "thumbsup",
        item: { type: "message", channel: "D1", ts: "100.1" },
        item_user: "UBOT123",
        user: "U-DAN",
      },
      client,
    });
    expect(mockRunClaude).not.toHaveBeenCalled();
  });

  test("[react:tada] in reaction response — calls reactions.add on posted message", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: "Logged! [react:tada]",
      sessionId: "sess-4",
    });
    const { client } = await invokeReactionAdded({
      client: makeFallbackForcedClient(),
    });
    expect(client.reactions.add).toHaveBeenCalledTimes(1);
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "D1",
      timestamp: expect.any(String),
      name: "tada",
    });
  });

  test("[react:emoji] not dispatched when post fails", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: "Logged! [react:tada]",
      sessionId: "sess-5",
    });
    createSlackApp();
    const client = makeMockClient();
    // Force the stream delivery to fail so the client.chat.postMessage
    // fallback path is genuinely exercised, then simulate that fallback
    // itself failing too (returns no ts).
    client.chat.appendStream.mockRejectedValue(new Error("stream unavailable"));
    (client.chat.postMessage as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("post failed"),
    );
    await capturedReactionAddedHandler?.({
      event: {
        reaction: "thumbsup",
        item: { type: "message", channel: "D1", ts: "100.1" },
        item_user: "UBOT123",
        user: "U-DAN",
      },
      client,
    });
    expect(client.reactions.add).not.toHaveBeenCalled();
  });
});

// ─── invalid_blocks retry — formatter(cleaned) fallback ──────────────────────

describe("invalid_blocks retry — falls back to formatter(cleaned) when blocks.text is empty", () => {
  // A markdown table causes markdownToBlocks() to return non-null (blocks path).
  // The invalid_blocks error shape must match isInvalidBlocksError():
  //   code === "slack_webapi_platform_error" && data?.error === "invalid_blocks"
  const TABLE_RESPONSE = "| Name | Value |\n|------|-------|\n| Foo  | Bar   |";

  function makeInvalidBlocksError() {
    const err = Object.assign(new Error("invalid_blocks"), {
      code: "slack_webapi_platform_error",
      data: { error: "invalid_blocks" },
    });
    return err;
  }

  beforeEach(() => {
    mockRunClaude.mockClear();
    mockMarkdownToSlack.mockClear();
  });

  test("DM handler — retries with plain text when say throws invalid_blocks", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: TABLE_RESPONSE,
      sessionId: "sess-ib-1",
    });
    createSlackApp();
    const client = makeMockClient();
    // deliverContent() must fail so the handler falls back to say()/postMessage() —
    // this describe block specifically exercises that fallback path.
    client.chat.appendStream.mockRejectedValue(new Error("stream unavailable"));
    const say = mock(async (_args: unknown) => ({ ts: "r.1" }));
    say.mockRejectedValueOnce(makeInvalidBlocksError());

    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "1.1",
        text: "show table",
        channel_type: "im",
      },
      say,
      client,
    });

    // First call threw invalid_blocks; second call is the retry
    expect(say).toHaveBeenCalledTimes(2);
    const retryArgs = say.mock.calls[1][0] as Record<string, unknown>;
    // Retry text must be non-empty (blocks.text || formatter(cleaned) must not be falsy)
    expect(typeof retryArgs.text).toBe("string");
    expect((retryArgs.text as string).length).toBeGreaterThan(0);
    expect(retryArgs.thread_ts).toBe("1.1");
  });

  test("DM handler — retry text is non-empty even when blocks path is taken", async () => {
    // The fix guards against empty blocks.text on retry: `blocks.text || formatter(cleaned)`.
    // blocks.text comes from the real markdownToSlack (not the injected formatter), so
    // for any non-empty table response blocks.text will be non-empty and || short-circuits.
    // This test confirms the retry text is never empty — the invariant the fix enforces.
    mockRunClaude.mockResolvedValueOnce({
      result: TABLE_RESPONSE,
      sessionId: "sess-ib-2",
    });
    createSlackApp();
    const client = makeMockClient();
    // deliverContent() must fail so the handler falls back to say()/postMessage() —
    // this describe block specifically exercises that fallback path.
    client.chat.appendStream.mockRejectedValue(new Error("stream unavailable"));
    const say = mock(async (_args: unknown) => ({ ts: "r.2" }));
    say.mockRejectedValueOnce(makeInvalidBlocksError());

    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "2.2",
        text: "show table",
        channel_type: "im",
      },
      say,
      client,
    });

    expect(say).toHaveBeenCalledTimes(2);
    const retryArgs = say.mock.calls[1][0] as Record<string, unknown>;
    // The || guard ensures retry text is always non-empty (blocks.text or formatter fallback)
    expect((retryArgs.text as string).length).toBeGreaterThan(0);
  });

  test("app_mention handler — retries with plain text when say throws invalid_blocks", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: TABLE_RESPONSE,
      sessionId: "sess-ib-3",
    });
    createSlackApp();
    const client = makeMockClient();
    // deliverContent() must fail so the handler falls back to say()/postMessage() —
    // this describe block specifically exercises that fallback path.
    client.chat.appendStream.mockRejectedValue(new Error("stream unavailable"));
    const say = mock(async (_args: unknown) => ({ ts: "r.3" }));
    say.mockRejectedValueOnce(makeInvalidBlocksError());

    await capturedMentionHandler?.({
      event: {
        text: "<@UBOT> show table",
        channel: "C1",
        ts: "3.3",
      },
      say,
      client,
    });

    expect(say).toHaveBeenCalledTimes(2);
    const retryArgs = say.mock.calls[1][0] as Record<string, unknown>;
    expect(typeof retryArgs.text).toBe("string");
    expect((retryArgs.text as string).length).toBeGreaterThan(0);
    expect(retryArgs.thread_ts).toBe("3.3");
  });

  test("reaction_added handler — retries postMessage with plain text when invalid_blocks", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: TABLE_RESPONSE,
      sessionId: "sess-ib-4",
    });
    createSlackApp();
    const client = makeMockClient();
    // deliverContent() must fail so the handler falls back to say()/postMessage() —
    // this describe block specifically exercises that fallback path.
    client.chat.appendStream.mockRejectedValue(new Error("stream unavailable"));
    // First postMessage throws invalid_blocks; second succeeds
    (client.chat.postMessage as ReturnType<typeof mock>).mockRejectedValueOnce(
      makeInvalidBlocksError(),
    );

    await capturedReactionAddedHandler?.({
      event: {
        reaction: "thumbsup",
        item: { type: "message", channel: "D1", ts: "100.1" },
        item_user: "UBOT123",
        user: "U-DAN",
      },
      client,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const retryArgs = (client.chat.postMessage as ReturnType<typeof mock>).mock
      .calls[1][0] as Record<string, unknown>;
    expect(typeof retryArgs.text).toBe("string");
    expect((retryArgs.text as string).length).toBeGreaterThan(0);
    expect(retryArgs.channel).toBe("D1");
  });

  test("reaction_added handler — does not throw when the invalid_blocks retry itself fails", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: TABLE_RESPONSE,
      sessionId: "sess-ib-4b",
    });
    createSlackApp();
    const client = makeMockClient();
    client.chat.appendStream.mockRejectedValue(new Error("stream unavailable"));
    // First postMessage throws invalid_blocks; the plain-text retry also fails.
    (client.chat.postMessage as ReturnType<typeof mock>)
      .mockRejectedValueOnce(makeInvalidBlocksError())
      .mockRejectedValueOnce(new Error("retry also failed"));

    await expect(
      capturedReactionAddedHandler?.({
        event: {
          reaction: "thumbsup",
          item: { type: "message", channel: "D1", ts: "100.1" },
          item_user: "UBOT123",
          user: "U-DAN",
        },
        client,
      }),
    ).resolves.toBeUndefined();

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  test("reaction_added handler — does not retry on a non-invalid_blocks postMessage failure", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: TABLE_RESPONSE,
      sessionId: "sess-ib-4c",
    });
    createSlackApp();
    const client = makeMockClient();
    client.chat.appendStream.mockRejectedValue(new Error("stream unavailable"));
    // A genuine (non-invalid_blocks) postMessage failure on the blocks path
    // must NOT trigger the plain-text retry — only a single call.
    (client.chat.postMessage as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("rate limited"),
    );

    await expect(
      capturedReactionAddedHandler?.({
        event: {
          reaction: "thumbsup",
          item: { type: "message", channel: "D1", ts: "100.1" },
          item_user: "UBOT123",
          user: "U-DAN",
        },
        client,
      }),
    ).resolves.toBeUndefined();

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  // ─── DI-based tests: blocks.text === '' → fallback to formatter(cleaned) ──

  test("DM handler — uses formatter(cleaned) on retry when blocks.text is empty (DI)", async () => {
    // Inject a blocksConverter that returns { text: '', blocks: [...] } to directly
    // exercise the `blocks.text || formatter(cleaned)` right-hand side.
    mockRunClaude.mockResolvedValueOnce({
      result: TABLE_RESPONSE,
      sessionId: "sess-ib-empty-dm",
    });
    createSlackApp({
      blocksConverter: (_text: string) =>
        // biome-ignore lint/suspicious/noExplicitAny: minimal test stub for SlackBlock
        ({ text: "", blocks: [{ type: "section" }] }) as any,
    });
    const client = makeMockClient();
    // deliverContent() must fail so the handler falls back to say()/postMessage() —
    // this describe block specifically exercises that fallback path.
    client.chat.appendStream.mockRejectedValue(new Error("stream unavailable"));
    const say = mock(async (_args: unknown) => ({ ts: "r.empty.1" }));
    say.mockRejectedValueOnce(makeInvalidBlocksError());

    await capturedMessageHandler?.({
      message: {
        channel: "D1",
        ts: "10.1",
        text: "show table",
        channel_type: "im",
      },
      say,
      client,
    });

    expect(say).toHaveBeenCalledTimes(2);
    const retryArgs = say.mock.calls[1][0] as Record<string, unknown>;
    // blocks.text is '' → fallback to formatter(cleaned) → '[formatted] ...'
    expect(retryArgs.text as string).toMatch(/^\[formatted\]/);
    expect((retryArgs.text as string).length).toBeGreaterThan(0);
    expect(retryArgs.thread_ts).toBe("10.1");
  });

  test("app_mention handler — uses formatter(cleaned) on retry when blocks.text is empty (DI)", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: TABLE_RESPONSE,
      sessionId: "sess-ib-empty-mention",
    });
    createSlackApp({
      blocksConverter: (_text: string) =>
        // biome-ignore lint/suspicious/noExplicitAny: minimal test stub for SlackBlock
        ({ text: "", blocks: [{ type: "section" }] }) as any,
    });
    const client = makeMockClient();
    // deliverContent() must fail so the handler falls back to say()/postMessage() —
    // this describe block specifically exercises that fallback path.
    client.chat.appendStream.mockRejectedValue(new Error("stream unavailable"));
    const say = mock(async (_args: unknown) => ({ ts: "r.empty.2" }));
    say.mockRejectedValueOnce(makeInvalidBlocksError());

    await capturedMentionHandler?.({
      event: {
        text: "<@UBOT> show table",
        channel: "C1",
        ts: "20.1",
      },
      say,
      client,
    });

    expect(say).toHaveBeenCalledTimes(2);
    const retryArgs = say.mock.calls[1][0] as Record<string, unknown>;
    expect(retryArgs.text as string).toMatch(/^\[formatted\]/);
    expect((retryArgs.text as string).length).toBeGreaterThan(0);
    expect(retryArgs.thread_ts).toBe("20.1");
  });

  test("reaction_added handler — uses formatter(cleaned) on retry when blocks.text is empty (DI)", async () => {
    mockRunClaude.mockResolvedValueOnce({
      result: TABLE_RESPONSE,
      sessionId: "sess-ib-empty-reaction",
    });
    createSlackApp({
      blocksConverter: (_text: string) =>
        // biome-ignore lint/suspicious/noExplicitAny: minimal test stub for SlackBlock
        ({ text: "", blocks: [{ type: "section" }] }) as any,
    });
    const client = makeMockClient();
    // deliverContent() must fail so the handler falls back to say()/postMessage() —
    // this describe block specifically exercises that fallback path.
    client.chat.appendStream.mockRejectedValue(new Error("stream unavailable"));
    (client.chat.postMessage as ReturnType<typeof mock>).mockRejectedValueOnce(
      makeInvalidBlocksError(),
    );

    await capturedReactionAddedHandler?.({
      event: {
        reaction: "thumbsup",
        item: { type: "message", channel: "D1", ts: "100.1" },
        item_user: "UBOT123",
        user: "U-DAN",
      },
      client,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    const retryArgs = (client.chat.postMessage as ReturnType<typeof mock>).mock
      .calls[1][0] as Record<string, unknown>;
    expect(retryArgs.text as string).toMatch(/^\[formatted\]/);
    expect((retryArgs.text as string).length).toBeGreaterThan(0);
    expect(retryArgs.channel).toBe("D1");
  });
});

describe("formatRunErrorForSlack", () => {
  test("monthly usage limit (429 + 'usage limit') gets dedicated message", () => {
    const err = new ClaudeRunError(
      "claude exited 1: api_error_status=429 You've hit your org's monthly usage limit",
      429,
      "You've hit your org's monthly usage limit",
      undefined,
    );
    const out = formatRunErrorForSlack(err);
    expect(out).toContain("monthly Claude usage limit");
    expect(out).toContain("agent owner");
    expect(out).toContain("You've hit your org's monthly usage limit");
  });

  test("generic 429 gets rate-limit message", () => {
    const err = new ClaudeRunError(
      "rate limited",
      429,
      "rate_limit_error",
      undefined,
    );
    const out = formatRunErrorForSlack(err);
    expect(out).toContain("Rate-limited");
  });

  test("529 gets overload message + status link", () => {
    const err = new ClaudeRunError("overloaded", 529, "Overloaded", undefined);
    const out = formatRunErrorForSlack(err);
    expect(out).toContain("overloaded");
    expect(out).toContain("status.claude.com");
  });

  test("500 gets transient hiccup message", () => {
    const err = new ClaudeRunError(
      "5xx",
      500,
      "API Error: 500 Internal server error.",
      undefined,
    );
    const out = formatRunErrorForSlack(err);
    expect(out).toContain("500");
    expect(out).toContain("status.claude.com");
  });

  test("401 gets auth-failure message", () => {
    const err = new ClaudeRunError("auth", 401, "invalid api key", undefined);
    const out = formatRunErrorForSlack(err);
    expect(out).toContain("Auth failure");
  });

  test("unknown ClaudeRunError includes detail and stack", () => {
    const err = new ClaudeRunError("weird", 418, "I'm a teapot", undefined);
    const out = formatRunErrorForSlack(err);
    expect(out).toContain("418");
    expect(out).toContain("I'm a teapot");
    expect(out).toMatch(/```[\s\S]*ClaudeRunError[\s\S]*```/);
  });

  test("plain Error falls back to generic + detail with class name", () => {
    const out = formatRunErrorForSlack(new TypeError("spawn EPIPE"));
    expect(out).toContain("Something went wrong");
    expect(out).toContain("TypeError: spawn EPIPE");
  });

  test("includes stack trace for Error instances", () => {
    const out = formatRunErrorForSlack(new Error("boom"));
    expect(out).toMatch(/```[\s\S]*Error: boom[\s\S]*at[\s\S]*```/);
  });

  test("known ClaudeRunError omits stack trace", () => {
    const out = formatRunErrorForSlack(
      new ClaudeRunError("msg", 429, "rate_limit_error", undefined),
    );
    expect(out).not.toContain("```");
  });

  test("non-Error values produce no stack block", () => {
    const out = formatRunErrorForSlack("just a string");
    expect(out).toContain("Something went wrong");
    expect(out).toContain("just a string");
    expect(out).not.toContain("```");
  });

  test("ClaudeTimeoutError includes timeout duration and retry prompt", () => {
    const err = new ClaudeTimeoutError(30 * 60 * 1000, "ceiling");
    const out = formatRunErrorForSlack(err);
    expect(out).toContain("30 minutes");
    expect(out).toContain("retry");
    expect(out).not.toContain("```");
  });

  test("ClaudeRunError with undefined sessionId handled gracefully", () => {
    const err = new ClaudeRunError(
      "msg",
      500,
      "Internal server error",
      undefined,
    );
    const out = formatRunErrorForSlack(err);
    expect(out).toContain("500");
    expect(() => formatRunErrorForSlack(err)).not.toThrow();
  });
});

// ─── Thread history on first @mention ────────────────────────────────────────

describe("app_mention handler — thread history on first mention", () => {
  beforeEach(() => {
    mockRunClaude.mockClear();
    mockResolveUserFn.mockClear();
  });

  test("first @mention in thread: fetches history and prepends to prompt", async () => {
    const mockRepliesFn = mock(
      async (_client: unknown, _channel: string, _ts: string) => ({
        messages: [
          { user: "U1", text: "Hey team, anyone know the status?" },
          { user: "U2", text: "I think it's done" },
        ],
      }),
    );
    // resolveUserFn returns different names for different users
    mockResolveUserFn.mockImplementation(
      async (userId: string, _client: unknown) => {
        if (userId === "U1") return "Alice";
        if (userId === "U2") return "Bob";
        return userId;
      },
    );

    createSlackApp({ conversationsRepliesFn: mockRepliesFn });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMentionHandler?.({
      event: {
        text: "@bot help",
        channel: "C123",
        ts: "1001.0",
        thread_ts: "1000.0",
        user: "U1",
      },
      say,
      client,
    });

    expect(mockRepliesFn).toHaveBeenCalledTimes(1);
    expect(mockRepliesFn).toHaveBeenCalledWith(client, "C123", "1000.0");

    const prompt = mockRunClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("[Thread context]");
    expect(prompt).toContain("[end thread context]");
    expect(prompt).toContain("[Alice]: Hey team, anyone know the status?");
    expect(prompt).toContain("[Bob]: I think it's done");
    expect(prompt).toContain("@bot help");
  });

  test("first @mention without thread_ts: no history fetch", async () => {
    const mockRepliesFn = mock(async () => ({ messages: [] }));
    createSlackApp({ conversationsRepliesFn: mockRepliesFn });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMentionHandler?.({
      event: {
        text: "@bot help",
        channel: "C123",
        ts: "1001.0",
        // no thread_ts
      },
      say,
      client,
    });

    expect(mockRepliesFn).not.toHaveBeenCalled();
  });

  test("subsequent @mention when session exists: no history fetch", async () => {
    const mockRepliesFn = mock(async () => ({ messages: [] }));
    // Provide a getSessionFn that returns a session — bot already knows the thread
    createSlackApp({
      conversationsRepliesFn: mockRepliesFn,
      getSessionFn: mock(async () => "sess-123"),
    });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMentionHandler?.({
      event: {
        text: "@bot help again",
        channel: "C123",
        ts: "1002.0",
        thread_ts: "1000.0",
      },
      say,
      client,
    });

    expect(mockRepliesFn).not.toHaveBeenCalled();
  });

  test("conversations.replies failure: proceeds without history, no crash", async () => {
    const mockRepliesFn = mock(async () => {
      throw new Error("network failure");
    });
    createSlackApp({ conversationsRepliesFn: mockRepliesFn });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMentionHandler?.({
      event: {
        text: "@bot help",
        channel: "C123",
        ts: "1001.0",
        thread_ts: "1000.0",
      },
      say,
      client,
    });

    // runClaude must still be called — no crash
    expect(mockRunClaude).toHaveBeenCalledTimes(1);
    // Prompt should not contain thread context markers (graceful fallback)
    const prompt = mockRunClaude.mock.calls[0][0] as string;
    expect(prompt).not.toContain("[Thread context]");
  });

  test("bot messages are excluded from thread history", async () => {
    const mockRepliesFn = mock(
      async (_client: unknown, _channel: string, _ts: string) => ({
        messages: [
          { user: "U1", text: "Human message" },
          { user: "UBOT123", text: "Bot reply — should be excluded" },
          { user: "U2", text: "Another human" },
        ],
      }),
    );
    createSlackApp({
      conversationsRepliesFn: mockRepliesFn,
      botUserId: "UBOT123",
    });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMentionHandler?.({
      event: {
        text: "@bot help",
        channel: "C123",
        ts: "1001.0",
        thread_ts: "1000.0",
      },
      say,
      client,
    });

    const prompt = mockRunClaude.mock.calls[0][0] as string;
    expect(prompt).not.toContain("Bot reply — should be excluded");
    expect(prompt).toContain("Human message");
    expect(prompt).toContain("Another human");
  });

  test("messages with no text are excluded from thread history", async () => {
    const mockRepliesFn = mock(
      async (_client: unknown, _channel: string, _ts: string) => ({
        messages: [
          { user: "U1", text: "Has text" },
          { user: "U2" /* no text field */ },
          { user: "U3", text: "" /* empty text */ },
        ],
      }),
    );
    createSlackApp({ conversationsRepliesFn: mockRepliesFn });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMentionHandler?.({
      event: {
        text: "@bot help",
        channel: "C123",
        ts: "1001.0",
        thread_ts: "1000.0",
      },
      say,
      client,
    });

    const prompt = mockRunClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("Has text");
    // U2 and U3 should not appear
    const lines = prompt.split("\n").filter((l) => l.startsWith("["));
    // Only U1's message and the @mention itself (after [end thread context])
    const historyLines = lines.filter(
      (l) =>
        !l.startsWith("[Thread context]") &&
        !l.startsWith("[end thread context]"),
    );
    const u2u3Lines = historyLines.filter(
      (l) => !l.includes("Has text") && !l.includes("@bot help"),
    );
    expect(u2u3Lines.length).toBe(0);
  });

  test("bot messages are included in thread history when botUserId is undefined", async () => {
    // When botUserId is unknown, the filter (!botUserId || m.user !== botUserId)
    // short-circuits to true — no messages are excluded by user ID.
    // This is the safe behavior: don't accidentally filter human messages just
    // because we can't identify the bot.
    const mockRepliesFn = mock(
      async (_client: unknown, _channel: string, _ts: string) => ({
        messages: [
          {
            user: "UBOT_NO_ID",
            text: "Bot message without botUserId",
            ts: "999.0",
          },
          { user: "U1", text: "Human message", ts: "998.0" },
        ],
      }),
    );
    createSlackApp({
      conversationsRepliesFn: mockRepliesFn,
      botUserId: undefined,
    });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMentionHandler?.({
      event: {
        text: "@bot help",
        channel: "C123",
        ts: "1001.0",
        thread_ts: "1000.0",
      },
      say,
      client,
    });

    const prompt = mockRunClaude.mock.calls[0][0] as string;
    // Both messages should appear — no bot filtering when botUserId is undefined
    expect(prompt).toContain("Bot message without botUserId");
    expect(prompt).toContain("Human message");
  });

  test("triggering @mention is not duplicated in thread history", async () => {
    // conversations.replies returns all thread messages including the @mention
    // itself (at event.ts). The filter must exclude it so Claude doesn't see
    // the request twice — once in [Thread context] and once as the prompt.
    const mockRepliesFn = mock(
      async (_client: unknown, _channel: string, _ts: string) => ({
        messages: [
          { user: "U1", text: "Prior message in thread", ts: "999.0" },
          { user: "U2", text: "@bot help", ts: "1001.0" }, // same ts as event
        ],
      }),
    );
    createSlackApp({ conversationsRepliesFn: mockRepliesFn });

    const client = makeMockClient();
    const say = makeSay();
    await capturedMentionHandler?.({
      event: {
        text: "@bot help",
        channel: "C123",
        ts: "1001.0",
        thread_ts: "1000.0",
        user: "U2",
      },
      say,
      client,
    });

    const prompt = mockRunClaude.mock.calls[0][0] as string;
    // "@bot help" should appear exactly once (as the current prompt), not in [Thread context]
    expect(prompt).toContain("Prior message in thread");
    const threadContextMatch = prompt.match(
      /\[Thread context\]([\s\S]*?)\[end thread context\]/,
    );
    expect(threadContextMatch).not.toBeNull();
    // The triggering message must not be inside [Thread context]
    expect(threadContextMatch?.[1]).not.toContain("@bot help");
  });
});

// ─── dispatchMarkers (direct) ─────────────────────────────────────────────────
//
// These tests call dispatchMarkers directly (not through a handler) to cover
// the full marker surface at the function boundary.

describe("dispatchMarkers — direct", () => {
  // biome-ignore lint/suspicious/noExplicitAny: mock Slack client
  let client: any;

  beforeEach(() => {
    client = {
      reactions: { add: mock(() => Promise.resolve()) },
      files: { uploadV2: mock(() => Promise.resolve()) },
      chat: { postMessage: mock(() => Promise.resolve({ ts: "999.000" })) },
    };
  });

  test("adds react emoji for react markers", async () => {
    await dispatchMarkers([{ type: "react", emojis: ["thumbsup"] }], {
      client,
      channel: "C123",
      postedTs: "1.0",
    });

    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1.0",
      name: "thumbsup",
    });
  });

  test("silent marker is skipped gracefully", async () => {
    await dispatchMarkers([{ type: "silent" }], { client, channel: "C123" });
    expect(client.reactions.add).not.toHaveBeenCalled();
  });

  test("upload marker — skips when file does not exist", async () => {
    await dispatchMarkers([{ type: "upload", path: "/nonexistent/file.txt" }], {
      client,
      channel: "C123",
    });
    expect(client.files.uploadV2).not.toHaveBeenCalled();
  });

  test("upload marker — uploads when file exists", async () => {
    const tmpPath = join(tmpdir(), `test-dispatch-upload-${Date.now()}.txt`);
    writeFileSync(tmpPath, "dispatch upload content");

    await dispatchMarkers([{ type: "upload", path: tmpPath }], {
      client,
      channel: "C456",
    });

    expect(client.files.uploadV2).toHaveBeenCalledTimes(1);
    const uploadArgs = (
      client.files.uploadV2.mock.calls[0] as [Record<string, unknown>]
    )[0];
    expect(uploadArgs.channel_id).toBe("C456");
    expect(uploadArgs.filename).toBe(tmpPath.split("/").pop());
    unlinkSync(tmpPath);
  });

  test("speak marker — calls synthesizeSpeechFn and uploads result", async () => {
    const outPath = join(tmpdir(), `test-dispatch-speak-${Date.now()}.mp3`);
    writeFileSync(outPath, Buffer.from("audio data"));
    const mockSynthesize = mock(async () => outPath);

    await dispatchMarkers([{ type: "speak", text: "Hello there" }], {
      client,
      channel: "D1",
      synthesizeSpeechFn: mockSynthesize,
      voiceConfig: {},
    });

    expect(mockSynthesize).toHaveBeenCalledWith("Hello there", {});
    expect(client.files.uploadV2).toHaveBeenCalledTimes(1);
    unlinkSync(outPath);
  });

  test("speak marker — posts text fallback when synthesis returns null", async () => {
    const mockSynthesize = mock(async () => null);

    await dispatchMarkers([{ type: "speak", text: "Hello" }], {
      client,
      channel: "D1",
      synthesizeSpeechFn: mockSynthesize,
      voiceConfig: {},
    });

    expect(client.files.uploadV2).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "D1", text: "Hello" }),
    );
  });

  test("speak marker — posts text fallback when synthesizeSpeechFn throws", async () => {
    const throwingSynthesize = mock(async () => {
      throw new Error("synthesis blew up");
    });

    await dispatchMarkers([{ type: "speak", text: "Hello" }], {
      client,
      channel: "D1",
      synthesizeSpeechFn: throwingSynthesize,
      voiceConfig: {},
    });

    expect(client.files.uploadV2).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "D1", text: "Hello" }),
    );
  });

  test("speak marker — skips text fallback when it duplicates the already-posted reply", async () => {
    const mockSynthesize = mock(async () => null);

    await dispatchMarkers([{ type: "speak", text: "Here is the answer" }], {
      client,
      channel: "D1",
      synthesizeSpeechFn: mockSynthesize,
      voiceConfig: {},
      postedText: "Here is the answer.",
    });

    expect(client.files.uploadV2).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test("speak marker — still posts text fallback when marker text differs from the already-posted reply", async () => {
    const mockSynthesize = mock(async () => null);

    await dispatchMarkers([{ type: "speak", text: "Hello" }], {
      client,
      channel: "D1",
      synthesizeSpeechFn: mockSynthesize,
      voiceConfig: {},
      postedText: "Something completely different was posted here.",
    });

    expect(client.files.uploadV2).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "D1", text: "Hello" }),
    );
  });

  test("speak marker — skipped gracefully when synthesizeSpeechFn is absent", async () => {
    await expect(
      dispatchMarkers([{ type: "speak", text: "Hello" }], {
        client,
        channel: "D1",
      }),
    ).resolves.toBeUndefined();

    expect(client.files.uploadV2).not.toHaveBeenCalled();
  });

  test("multiple react emojis all dispatched", async () => {
    await dispatchMarkers(
      [{ type: "react", emojis: ["thumbsup", "tada", "rocket"] }],
      { client, channel: "C1", postedTs: "2.0" },
    );

    expect(client.reactions.add).toHaveBeenCalledTimes(3);
    // biome-ignore lint/suspicious/noExplicitAny: mock call args are untyped
    const names = (client.reactions.add.mock.calls as any[][]).map(
      (c) => (c[0] as { name: string }).name,
    );
    expect(names).toEqual(["thumbsup", "tada", "rocket"]);
  });

  test("react marker without postedTs does not call reactions.add", async () => {
    await dispatchMarkers([{ type: "react", emojis: ["thumbsup"] }], {
      client,
      channel: "C1",
    });
    expect(client.reactions.add).not.toHaveBeenCalled();
  });
});

// ─── Thread resume after a first-message timeout (CSI-1.2) ────────────────────
//
// mockRunClaude above is a bare mock of the *runner* param — it can't exercise
// the session-persistence-on-failure fix, since that logic lives inside
// createRunClaude's own _runClaude. These tests wire the REAL createRunClaude
// (with a fake spawner + a real in-memory session store) as the runner, so
// they exercise the actual user-facing behavior: a first DM message that
// times out must still let a later message in the same thread resume via
// `-r <sessionId>`, instead of starting a brand-new context-free session.

describe("thread resume after timeout — real createRunClaude wired as runner", () => {
  interface FakeProc {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill: () => void;
  }

  function bodyStream(content: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(content));
        controller.close();
      },
    });
  }

  /** A proc that emits a single `system`/`init` line (carrying a session id)
   * then goes silent forever — never closes on its own, only `kill()` (fired
   * by the idle timer) ends it. Simulates a first message that gets far
   * enough to create a real CLI session before hanging. */
  function hangingProcWithSessionId(sessionId: string): FakeProc {
    const enc = new TextEncoder();
    let resolveExited!: (code: number) => void;
    const exited = new Promise<number>((r) => {
      resolveExited = r;
    });
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          enc.encode(
            `${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`,
          ),
        );
        // Deliberately never close — the idle timer's kill() is what ends it.
      },
    });
    return {
      stdout,
      stderr: bodyStream(""),
      exited,
      kill: () => {
        streamController.close();
        resolveExited(143);
      },
    };
  }

  function jsonResultProc(result: string, sessionId: string): FakeProc {
    const json = JSON.stringify({
      type: "result",
      subtype: "success",
      result,
      session_id: sessionId,
      is_error: false,
    });
    return {
      stdout: bodyStream(`${json}\n`),
      stderr: bodyStream(""),
      exited: Promise.resolve(0),
      kill: () => {},
    };
  }

  test("first DM message times out, second message in the same thread resumes with -r <sessionId>", async () => {
    // Real in-memory session store, exactly like createFileSessionStore's
    // contract (get/set/clear), so the runner's own _saveSession /
    // _saveSessionFromError calls are exercised for real.
    const store = new Map<string, string>();
    const realSessions = {
      get: (key: string) => store.get(key),
      set: (key: string, id: string) => {
        store.set(key, id);
      },
      clear: (key: string) => {
        store.delete(key);
      },
    };

    let callCount = 0;
    const mockSpawn = mock(() => {
      callCount++;
      if (callCount === 1) {
        // First message: the CLI creates a real session, then hangs.
        return hangingProcWithSessionId(
          "sess-first-msg",
        ) as unknown as ReturnType<typeof Bun.spawn>;
      }
      // Second message (resumed): succeeds normally.
      return jsonResultProc(
        "Resumed reply",
        "sess-first-msg",
      ) as unknown as ReturnType<typeof Bun.spawn>;
    });

    const realRunClaude = createRunClaude(
      mockSpawn as unknown as typeof Bun.spawn,
      realSessions,
      "claude-opus-4-6",
      "/tmp",
      fakeSentryClient,
      undefined,
      undefined,
      undefined,
      5000, // ceiling — nowhere near firing
      15, // idle timeout — fires quickly since the hanging proc goes silent
    );

    capturedErrors = [];
    const app = _createSlackApp(
      (message: string, sessionKey?: string, onProgress?: ProgressCallback) =>
        realRunClaude(message, sessionKey, onProgress),
      mockMarkdownToSlack,
      threadKey,
      // biome-ignore lint/suspicious/noExplicitAny: mock factory for tests
      (cfg) => new MockApp(cfg as Record<string, unknown>) as any,
      mockSlackConfig,
      fakeSentryClient,
      async () => null,
      {},
      async () => null,
      async () => null,
      mockResolveUserFn,
      "UBOT123",
      async () => ({ messages: [] }),
      async (key: string) => realSessions.get(key),
      undefined,
      new NoopChatTokenReporter(),
      async () => undefined, // resolveUserEmailFn
      // A fresh, unsynced ref — never the process-wide agentSlackMembershipRef
      // singleton, which agent-slack-membership-ref.unit.test.ts mutates
      // directly (see the createSlackApp wrapper above for the identical fix).
      createAgentSlackMembershipRef(),
    );
    expect(app).toBeInstanceOf(MockApp);

    const client = makeMockClient();

    // First message in a new DM thread — times out.
    const firstSay = makeSay("first.reply.ts");
    await capturedMessageHandler?.({
      message: {
        channel: "D999",
        ts: "100.001",
        text: "Kick off a long task",
        channel_type: "im",
      },
      say: firstSay,
      client,
    });

    // The timeout error was surfaced to Slack, but the session id the CLI
    // created before hanging must still have been persisted.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(store.get("D999:100.001")).toBe("sess-first-msg");

    // Second message in the SAME thread (thread_ts pins it to the first
    // message's ts) — must resume, not start a fresh context-free session.
    const secondSay = makeSay("second.reply.ts");
    await capturedMessageHandler?.({
      message: {
        channel: "D999",
        ts: "100.002",
        thread_ts: "100.001",
        text: "Are you still there?",
        channel_type: "im",
      },
      say: secondSay,
      client,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const [secondCmd] = mockSpawn.mock.calls[1] as unknown as [string[]];
    const rIdx = secondCmd.indexOf("-r");
    expect(rIdx).toBeGreaterThan(-1);
    expect(secondCmd[rIdx + 1]).toBe("sess-first-msg");
    // Delivered via the Thinking Steps stream (client has a working chat
    // namespace) — say() is not used for the real reply.
    expect(secondSay).not.toHaveBeenCalled();
    const markdownChunks = client.chat.appendStream.mock.calls
      .flatMap(
        (c) => (c[0] as { chunks: Array<Record<string, unknown>> }).chunks,
      )
      .filter((chunk) => chunk.type === "markdown_text");
    expect(markdownChunks).toContainEqual({
      type: "markdown_text",
      text: "Resumed reply",
    });
  });
});
