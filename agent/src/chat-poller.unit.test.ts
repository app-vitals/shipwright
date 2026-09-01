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
import { createChatPoller, deriveReply } from "./chat-poller.ts";
import type { ClaudeRunResult, ProgressCallback } from "./claude.ts";
import type { ChatServiceClient } from "./http-chat-service-client.ts";

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
    heartbeatAt: null,
    cancelRequestedAt: null,
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
    heartbeat: async () => ({ cancelRequested: false }),
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
    const [runBody, runKey] = runner.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(runBody).toBe(message.body);
    expect(runKey).toBe(`chat:${threadId}`);

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
    const [runBody2, runKey2] = runner.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(runBody2).toBe(message.body);
    expect(runKey2).toBe(`chat:${threadId}`);
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

// ─── poll: listThreads failure ─────────────────────────────────────────────────

describe("createChatPoller poll: listThreads failure", () => {
  it("does not throw and skips the poll iteration when listThreads fails", async () => {
    const listThreads = mock(async () => {
      throw new Error("chat service unreachable");
    });
    const claimMessage = mock(async () => null);
    const client = makeFakeClient({ listThreads, claimMessage });
    const runner = mock(async () => ({ result: "ok" }));

    const poller = createChatPoller({ client, runner });

    await expect(poller.pollOnce()).resolves.toBeUndefined();
    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(claimMessage).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });
});

// ─── poll: heartbeat during a long-running reply ───────────────────────────────

/**
 * Deterministic stand-in for setInterval/clearInterval. Registered callbacks
 * fire only when `tick()` is called, so tests never depend on wall time.
 */
function makeFakeInterval() {
  let nextId = 1;
  const active = new Map<number, () => void>();
  const setIntervalFn = ((fn: () => void) => {
    const id = nextId++;
    active.set(id, fn);
    return id;
  }) as unknown as typeof setInterval;
  const clearIntervalFn = ((id: number) => {
    active.delete(id);
  }) as unknown as typeof clearInterval;
  const tick = (times = 1) => {
    for (let i = 0; i < times; i++) for (const fn of [...active.values()]) fn();
  };
  return {
    setIntervalFn,
    clearIntervalFn,
    tick,
    activeCount: () => active.size,
  };
}

describe("createChatPoller poll: heartbeat during a long-running reply", () => {
  it("beats on an interval even when the run emits no progress at all", async () => {
    const threadId = "thread-hb";
    const messageId = "msg-hb";
    const thread = makeThread(threadId);
    const message = makeMessage(threadId, messageId);
    const replyResult = makeReplyResult(message);

    const heartbeat = mock(async () => ({ cancelRequested: false }));
    const client = makeFakeClient({
      listThreads: async () => ({
        threads: [thread],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      claimMessage: async () => message,
      replyToMessage: async () => replyResult,
      heartbeat,
    });

    const fake = makeFakeInterval();

    // The regression this guards: a single long tool call emits ONE stream
    // event and then nothing until it returns. A progress-driven heartbeat
    // goes silent here — exactly during the wait it exists to cover. This
    // runner never reports progress, and the heartbeat must still fire.
    const runner = mock(async () => {
      fake.tick(3);
      return { result: "ok" };
    });

    const poller = createChatPoller({
      client,
      runner,
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
    });
    await poller.pollOnce();

    expect(heartbeat).toHaveBeenCalledTimes(3);
    expect(heartbeat).toHaveBeenCalledWith(threadId, messageId);
  });

  it("stops beating once the run completes", async () => {
    const threadId = "thread-hb-stop";
    const message = makeMessage(threadId, "msg-hb-stop");
    const replyResult = makeReplyResult(message);

    const heartbeat = mock(async () => ({ cancelRequested: false }));
    const client = makeFakeClient({
      listThreads: async () => ({
        threads: [makeThread(threadId)],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      claimMessage: async () => message,
      replyToMessage: async () => replyResult,
      heartbeat,
    });

    const fake = makeFakeInterval();
    const runner = mock(async () => ({ result: "ok" }));

    const poller = createChatPoller({
      client,
      runner,
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
    });
    await poller.pollOnce();

    expect(fake.activeCount()).toBe(0);
    fake.tick(5);
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it("stops beating when the run throws", async () => {
    const threadId = "thread-hb-throw";
    const message = makeMessage(threadId, "msg-hb-throw");

    const heartbeat = mock(async () => ({ cancelRequested: false }));
    const client = makeFakeClient({
      listThreads: async () => ({
        threads: [makeThread(threadId)],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      claimMessage: async () => message,
      heartbeat,
    });

    const fake = makeFakeInterval();
    const runner = mock(async () => {
      throw new Error("runner exploded");
    });

    const poller = createChatPoller({
      client,
      runner,
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
    });
    await poller.pollOnce();

    expect(fake.activeCount()).toBe(0);
  });

  it("does not let a heartbeat failure abort the reply", async () => {
    const threadId = "thread-hb-fail";
    const message = makeMessage(threadId, "msg-hb-fail");
    const replyResult = makeReplyResult(message);

    const replyToMessage = mock(async () => replyResult);
    const client = makeFakeClient({
      listThreads: async () => ({
        threads: [makeThread(threadId)],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      claimMessage: async () => message,
      replyToMessage,
      heartbeat: async () => {
        throw new Error("chat service unreachable");
      },
    });

    const runner = mock(
      async (_msg: string, _key?: string, onProgress?: ProgressCallback) => {
        onProgress?.({});
        return { result: "ok" };
      },
    );

    const poller = createChatPoller({ client, runner });

    await expect(poller.pollOnce()).resolves.toBeUndefined();
    expect(replyToMessage).toHaveBeenCalledTimes(1);
  });
});

// ─── poll: always replies (errorKind on failure, non-empty on incomplete) ──────

describe("createChatPoller poll: always replies with an errorKind on failure", () => {
  it("replies with a non-empty body and an errorKind when the runner throws", async () => {
    const threadId = "thread-fail-reply";
    const message = makeMessage(threadId, "msg-fail");
    const replyResult = makeReplyResult(message);

    const replyToMessage = mock(async () => replyResult);
    const client = makeFakeClient({
      listThreads: async () => ({
        threads: [makeThread(threadId)],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      claimMessage: async () => message,
      replyToMessage,
    });

    const runner = mock(async () => {
      throw new Error("runner exploded");
    });

    const poller = createChatPoller({ client, runner });
    await poller.pollOnce();

    // The message must NOT be left claimed-forever: a reply is always posted.
    expect(replyToMessage).toHaveBeenCalledTimes(1);
    const [, , opts] = replyToMessage.mock.calls[0] as unknown as [
      string,
      string,
      { body: string; errorKind?: string },
    ];
    expect(opts.errorKind).toBeTruthy();
    expect(opts.body.length).toBeGreaterThan(0);
  });

  it("replies with a non-empty body and errorKind=incomplete when the run streamIncomplete's with empty result", async () => {
    const threadId = "thread-incomplete";
    const message = makeMessage(threadId, "msg-inc");
    const replyResult = makeReplyResult(message);

    const replyToMessage = mock(async () => replyResult);
    const client = makeFakeClient({
      listThreads: async () => ({
        threads: [makeThread(threadId)],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      claimMessage: async () => message,
      replyToMessage,
    });

    // Empty result + streamIncomplete — the poller must NOT post an empty reply.
    const runner = mock(async () => ({ result: "", streamIncomplete: true }));

    const poller = createChatPoller({ client, runner });
    await poller.pollOnce();

    expect(replyToMessage).toHaveBeenCalledTimes(1);
    const [, , opts] = replyToMessage.mock.calls[0] as unknown as [
      string,
      string,
      { body: string; errorKind?: string },
    ];
    expect(opts.body.length).toBeGreaterThan(0);
    expect(opts.errorKind).toBe("incomplete");
  });
});

// ─── poll: cancel via the heartbeat tick ───────────────────────────────────────

describe("createChatPoller poll: cancel via heartbeat", () => {
  it("aborts the in-flight run when a heartbeat reports cancelRequested, replying with errorKind=cancelled", async () => {
    const threadId = "thread-cancel";
    const message = makeMessage(threadId, "msg-cancel");
    const replyResult = makeReplyResult(message);

    const replyToMessage = mock(async () => replyResult);
    // Heartbeat reports cancelRequested on the first beat.
    const heartbeat = mock(async () => ({ cancelRequested: true }));
    const client = makeFakeClient({
      listThreads: async () => ({
        threads: [makeThread(threadId)],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      claimMessage: async () => message,
      replyToMessage,
      heartbeat,
    });

    const fake = makeFakeInterval();

    // The runner observes the injected AbortSignal and rejects when it aborts,
    // mirroring how createRunClaude throws ClaudeAbortedError on cancel.
    const runner = mock(
      (
        _msg: string,
        _key?: string,
        _onProgress?: ProgressCallback,
        signal?: AbortSignal,
      ) =>
        new Promise<{ result: string }>((_resolve, reject) => {
          if (signal) {
            signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "ClaudeAbortedError";
              reject(err);
            });
          }
          // Fire a heartbeat tick — which sees cancelRequested and aborts.
          fake.tick(1);
        }),
    );

    const poller = createChatPoller({
      client,
      runner,
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
    });
    await poller.pollOnce();

    // The run was cancelled and a cancelled reply was posted.
    expect(replyToMessage).toHaveBeenCalledTimes(1);
    const [, , opts] = replyToMessage.mock.calls[0] as unknown as [
      string,
      string,
      { body: string; errorKind?: string },
    ];
    expect(opts.errorKind).toBe("cancelled");
  });
});

// ─── start/stop: timer lifecycle ───────────────────────────────────────────────
//
// Moved to chat-poller.integration.test.ts — these tests drive real
// setInterval/clearInterval across real ~100ms wall-clock waits, which puts
// them over the unit-layer <200ms hard cap and outside its "no I/O of any
// kind" boundary (see docs/test-readiness/test-system.md).

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
      const filePath = join(workspaceDir, "uploads", `${messageId}-report.txt`);
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

  it("continues without augmenting the message when getAttachment throws", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "chat-poller-att-"));
    try {
      const threadId = "thread-att-error";
      const thread = makeThread(threadId);
      const message = makeMessageWithAttachment(threadId, "broken.txt");
      const replyResult = makeReplyResult(makeMessage(threadId));

      const getAttachment = mock(async () => {
        throw new Error("attachment fetch failed");
      });
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

      // Must not throw — the attachment fetch error is caught and logged, and
      // the runner still gets called with the un-augmented message body.
      await expect(poller.pollOnce()).resolves.toBeUndefined();

      expect(getAttachment).toHaveBeenCalledTimes(1);
      expect(runner).toHaveBeenCalledTimes(1);
      const runnerArg = (runner.mock.calls[0] as unknown[])[0] as string;
      expect(runnerArg).toBe(message.body);
      expect(runnerArg).not.toContain("broken.txt");
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

// ─── start: overlap guard ─────────────────────────────────────────────────────

describe("createChatPoller start: overlap guard", () => {
  it("skips interval ticks while the previous poll is still in flight", async () => {
    let releaseList: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const listThreads = mock(async () => {
      await gate;
      return { threads: [], total: 0, limit: 50, offset: 0 };
    });

    const client = makeFakeClient({ listThreads });
    const runner = mock(async () => ({ result: "ok" }));
    const fake = makeFakeInterval();

    const poller = createChatPoller({
      client,
      runner,
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
    });
    poller.start();

    // A poll that outlives its interval would otherwise stack concurrent
    // iterations for as long as it runs.
    fake.tick(); // starts poll #1, which blocks on the gate
    fake.tick(); // must be skipped
    fake.tick(); // must be skipped
    expect(listThreads).toHaveBeenCalledTimes(1);

    releaseList();
    await new Promise((resolve) => setTimeout(resolve, 0));

    fake.tick(); // previous poll settled — free to run again
    expect(listThreads).toHaveBeenCalledTimes(2);

    poller.stop();
  });
});

// ─── deriveReply: always non-empty body + correct errorKind ────────────────────

describe("deriveReply", () => {
  const R = (over: Partial<ClaudeRunResult>): ClaudeRunResult => ({
    result: "",
    ...over,
  });

  it("cancelled: fixed body + cancelled errorKind", () => {
    const d = deriveReply(undefined, "cancelled");
    expect(d.body.length).toBeGreaterThan(0);
    expect(d.errorKind).toBe("cancelled");
  });

  it("thrown runner (stalled): non-empty body + stalled errorKind", () => {
    const d = deriveReply(undefined, "stalled");
    expect(d.body.length).toBeGreaterThan(0);
    expect(d.errorKind).toBe("stalled");
  });

  it("streamIncomplete with empty result: non-empty body + incomplete errorKind", () => {
    const d = deriveReply(R({ result: "", streamIncomplete: true }), undefined);
    expect(d.body.length).toBeGreaterThan(0);
    expect(d.errorKind).toBe("incomplete");
  });

  it("clean finish with empty result: non-empty body + incomplete errorKind", () => {
    const d = deriveReply(R({ result: "   " }), undefined);
    expect(d.body.length).toBeGreaterThan(0);
    expect(d.errorKind).toBe("incomplete");
  });

  it("clean finish with real result: passes body + usage through, no errorKind", () => {
    const usage = {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const d = deriveReply(
      R({ result: "the answer", usage, totalCostUsd: 0.01 }),
      undefined,
    );
    expect(d.body).toBe("the answer");
    expect(d.tokens).toEqual(usage);
    expect(d.costUsd).toBe(0.01);
    expect(d.errorKind).toBeUndefined();
  });
});
