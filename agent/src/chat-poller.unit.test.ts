/**
 * agent/src/chat-poller.unit.test.ts
 *
 * Unit tests for the chat poll loop.
 * Uses fake client + fake runner — no real HTTP, no global.fetch overrides.
 */

import { describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatServiceClient } from "./http-chat-service-client.ts";
import { createChatPoller } from "./chat-poller.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeThread(id: string) {
  return {
    id,
    agentId: "agent-1",
    memberId: null,
    title: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeMessage(threadId: string, messageId = "msg-1") {
  return {
    id: messageId,
    threadId,
    role: "user",
    body: "Hello from user",
    claimedBy: "agent-1",
    claimedAt: new Date(),
    repliedAt: null,
    tokens: null,
    costUsd: null,
    attachmentFilename: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeReplyResult(msg: ReturnType<typeof makeMessage>) {
  return {
    userMessage: msg,
    assistantMessage: {
      ...msg,
      id: "msg-reply-1",
      role: "assistant",
      body: "Hi there!",
      claimedBy: null,
      claimedAt: null,
    },
  };
}

/** Create a fake ChatServiceClient. All methods are overridable per test. */
function makeFakeClient(
  overrides: Partial<ChatServiceClient> = {},
): ChatServiceClient {
  return {
    listThreads: async () => ({ threads: [], total: 0, limit: 50, offset: 0 }),
    claimMessage: async () => null,
    replyToMessage: async () => ({
      userMessage: makeMessage("thread-1"),
      assistantMessage: makeMessage("thread-1"),
    }),
    getAttachment: async () => null,
    ...overrides,
  };
}

// ─── createChatPoller: basic structure ────────────────────────────────────────

describe("createChatPoller", () => {
  it("returns an object with start and stop methods", () => {
    const client = makeFakeClient();
    const runner = async () => ({ result: "ok" });
    const poller = createChatPoller({ client, runner });

    expect(typeof poller.start).toBe("function");
    expect(typeof poller.stop).toBe("function");
  });
});

// ─── poll: no threads → no-op ─────────────────────────────────────────────────

describe("createChatPoller poll: no threads", () => {
  it("does not call claimMessage when there are no threads", async () => {
    const claimMessage = mock(async () => null);
    const client = makeFakeClient({ claimMessage });
    const runner = mock(async () => ({ result: "ok" }));

    const poller = createChatPoller({ client, runner });
    await poller.pollOnce();

    expect(claimMessage).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });
});

// ─── poll: thread with no unclaimed messages ───────────────────────────────────

describe("createChatPoller poll: thread with no unclaimed message", () => {
  it("does not call runner when claimMessage returns null", async () => {
    const thread = makeThread("thread-1");
    const client = makeFakeClient({
      listThreads: async () => ({
        threads: [thread],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      claimMessage: async () => null,
    });
    const runner = mock(async () => ({ result: "ok" }));

    const poller = createChatPoller({ client, runner });
    await poller.pollOnce();

    expect(runner).not.toHaveBeenCalled();
  });
});

// ─── poll: claim + reply happy path ───────────────────────────────────────────

describe("createChatPoller poll: claim then reply", () => {
  it("runs runner with chat:threadId session key and posts reply", async () => {
    const threadId = "thread-42";
    const messageId = "msg-99";
    const thread = makeThread(threadId);
    const message = makeMessage(threadId, messageId);
    const replyResult = makeReplyResult(message);

    const replyToMessage = mock(async () => replyResult);
    const client = makeFakeClient({
      listThreads: async () => ({
        threads: [thread],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      claimMessage: async () => message,
      replyToMessage,
    });

    const runnerResult = {
      result: "Claude said hi",
      sessionId: "session-abc",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      totalCostUsd: 0.002,
    };
    const runner = mock(async () => runnerResult);

    const poller = createChatPoller({ client, runner });
    await poller.pollOnce();

    // Runner called with the message body and correct session key
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(message.body, `chat:${threadId}`);

    // Reply posted with runner output
    expect(replyToMessage).toHaveBeenCalledTimes(1);
    expect(replyToMessage).toHaveBeenCalledWith(
      threadId,
      messageId,
      expect.objectContaining({
        body: runnerResult.result,
        tokens: runnerResult.usage,
        costUsd: runnerResult.totalCostUsd,
      }),
    );
  });

  it("passes chat:threadId session key to runner for per-thread continuity", async () => {
    // The poller passes a stable `chat:<threadId>` session key to the runner on
    // every call. The runner (createRunClaude) uses this key to look up and
    // persist session IDs in its own injected session store — the poller does
    // not manage session persistence directly.
    const threadId = "thread-session-test";
    const thread = makeThread(threadId);
    const message = makeMessage(threadId);
    const replyResult = makeReplyResult(message);

    const client = makeFakeClient({
      listThreads: async () => ({
        threads: [thread],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      claimMessage: async () => message,
      replyToMessage: async () => replyResult,
    });

    const runner = mock(async () => ({
      result: "reply",
      sessionId: "session-stored-123",
    }));

    const poller = createChatPoller({ client, runner });
    await poller.pollOnce();

    // Runner must receive the stable session key so it can resume the session
    expect(runner).toHaveBeenCalledWith(message.body, `chat:${threadId}`);
  });
});

// ─── poll: per-thread error isolation ─────────────────────────────────────────

describe("createChatPoller poll: per-thread error isolation", () => {
  it("continues processing other threads when one thread fails", async () => {
    const thread1 = makeThread("thread-fail");
    const thread2 = makeThread("thread-ok");
    const messageOk = makeMessage("thread-ok", "msg-ok");
    const replyResult = makeReplyResult(messageOk);

    let callCount = 0;
    const client = makeFakeClient({
      listThreads: async () => ({
        threads: [thread1, thread2],
        total: 2,
        limit: 50,
        offset: 0,
      }),
      claimMessage: async (threadId) => {
        if (threadId === "thread-fail") {
          throw new Error("claim failed for thread-fail");
        }
        return messageOk;
      },
      replyToMessage: async () => replyResult,
    });

    const runner = mock(async () => ({
      result: "ok reply",
      sessionId: "s1",
    }));

    const poller = createChatPoller({ client, runner });

    // Should not throw even though thread-fail errors
    await expect(poller.pollOnce()).resolves.toBeUndefined();
    callCount++;

    // Runner should still be called for the successful thread
    expect(runner).toHaveBeenCalledTimes(1);
    expect(callCount).toBe(1);
  });

  it("does not throw when runner fails for one thread", async () => {
    const thread = makeThread("thread-runner-fail");
    const message = makeMessage("thread-runner-fail");

    const client = makeFakeClient({
      listThreads: async () => ({
        threads: [thread],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      claimMessage: async () => message,
    });

    const runner = mock(async () => {
      throw new Error("runner crashed");
    });

    const poller = createChatPoller({ client, runner });

    // Must not throw — errors are caught per-thread
    await expect(poller.pollOnce()).resolves.toBeUndefined();
  });

  it("does not throw when replyToMessage fails", async () => {
    const thread = makeThread("thread-reply-fail");
    const message = makeMessage("thread-reply-fail");

    const client = makeFakeClient({
      listThreads: async () => ({
        threads: [thread],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      claimMessage: async () => message,
      replyToMessage: async () => {
        throw new Error("reply service down");
      },
    });

    const runner = mock(async () => ({ result: "ok" }));

    const poller = createChatPoller({ client, runner });

    await expect(poller.pollOnce()).resolves.toBeUndefined();
  });
});

// ─── poll: multiple threads ────────────────────────────────────────────────────

describe("createChatPoller poll: multiple threads", () => {
  it("processes all threads in a single poll", async () => {
    const threads = [makeThread("t1"), makeThread("t2"), makeThread("t3")];
    const messages = {
      t1: makeMessage("t1", "m1"),
      t2: makeMessage("t2", "m2"),
      t3: makeMessage("t3", "m3"),
    };
    const claimedThreadIds: string[] = [];
    const repliedThreadIds: string[] = [];

    const client = makeFakeClient({
      listThreads: async () => ({
        threads,
        total: 3,
        limit: 50,
        offset: 0,
      }),
      claimMessage: async (threadId) => {
        claimedThreadIds.push(threadId);
        return messages[threadId as "t1" | "t2" | "t3"] ?? null;
      },
      replyToMessage: async (threadId) => {
        repliedThreadIds.push(threadId);
        return makeReplyResult(messages[threadId as "t1" | "t2" | "t3"]);
      },
    });

    const runner = mock(async () => ({ result: "ok" }));

    const poller = createChatPoller({ client, runner });
    await poller.pollOnce();

    expect(claimedThreadIds.sort()).toEqual(["t1", "t2", "t3"]);
    expect(repliedThreadIds.sort()).toEqual(["t1", "t2", "t3"]);
    expect(runner).toHaveBeenCalledTimes(3);
  });
});

// ─── poll: attachment handling ─────────────────────────────────────────────────

function makeMessageWithAttachment(
  threadId: string,
  filename: string,
  messageId = "msg-att",
) {
  return {
    ...makeMessage(threadId, messageId),
    attachmentFilename: filename,
  };
}

describe("createChatPoller poll: attachment handling", () => {
  it("pulls attachment, writes it to the workspace, and augments the runner message", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "chat-poller-att-"));
    try {
      const threadId = "thread-att";
      const messageId = "msg-att-1";
      const thread = makeThread(threadId);
      const message = makeMessageWithAttachment(
        threadId,
        "report.txt",
        messageId,
      );
      const replyResult = makeReplyResult(makeMessage(threadId, messageId));

      const fileBytes = new Uint8Array([104, 105]); // "hi"
      const getAttachment = mock(async () => fileBytes);

      const client = makeFakeClient({
        listThreads: async () => ({
          threads: [thread],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        claimMessage: async () => message,
        replyToMessage: async () => replyResult,
        getAttachment,
      });

      const runner = mock(async () => ({ result: "ok" }));

      const poller = createChatPoller({ client, runner, workspaceDir });
      await poller.pollOnce();

      // getAttachment called with thread + message id
      expect(getAttachment).toHaveBeenCalledTimes(1);
      expect(getAttachment).toHaveBeenCalledWith(threadId, messageId);

      // Runner message augmented with the attachment note
      expect(runner).toHaveBeenCalledTimes(1);
      const runnerArg = (runner.mock.calls[0] as unknown[])[0] as string;
      expect(runnerArg).toContain(message.body);
      expect(runnerArg).toContain("report.txt");

      // File written to <workspace>/uploads/<id>-<filename>
      const filePath = join(
        workspaceDir,
        "uploads",
        `${messageId}-report.txt`,
      );
      const written = await readFile(filePath);
      expect(Array.from(new Uint8Array(written))).toEqual([104, 105]);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not augment the runner message when getAttachment returns null", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "chat-poller-att-"));
    try {
      const threadId = "thread-att-null";
      const thread = makeThread(threadId);
      const message = makeMessageWithAttachment(threadId, "gone.txt");
      const replyResult = makeReplyResult(makeMessage(threadId));

      const getAttachment = mock(async () => null);
      const client = makeFakeClient({
        listThreads: async () => ({
          threads: [thread],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        claimMessage: async () => message,
        replyToMessage: async () => replyResult,
        getAttachment,
      });

      const runner = mock(async () => ({ result: "ok" }));
      const poller = createChatPoller({ client, runner, workspaceDir });
      await poller.pollOnce();

      expect(getAttachment).toHaveBeenCalledTimes(1);
      const runnerArg = (runner.mock.calls[0] as unknown[])[0] as string;
      expect(runnerArg).toBe(message.body);
      expect(runnerArg).not.toContain("gone.txt");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not call getAttachment when the message has no attachmentFilename", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "chat-poller-att-"));
    try {
      const threadId = "thread-no-att";
      const thread = makeThread(threadId);
      const message = makeMessage(threadId);
      const replyResult = makeReplyResult(message);

      const getAttachment = mock(async () => new Uint8Array([1]));
      const client = makeFakeClient({
        listThreads: async () => ({
          threads: [thread],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        claimMessage: async () => message,
        replyToMessage: async () => replyResult,
        getAttachment,
      });

      const runner = mock(async () => ({ result: "ok" }));
      const poller = createChatPoller({ client, runner, workspaceDir });
      await poller.pollOnce();

      expect(getAttachment).not.toHaveBeenCalled();
      const runnerArg = (runner.mock.calls[0] as unknown[])[0] as string;
      expect(runnerArg).toBe(message.body);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
