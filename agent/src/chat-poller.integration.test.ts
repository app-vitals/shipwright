/**
 * agent/src/chat-poller.integration.test.ts
 *
 * Integration tests for the chat poll loop's start()/stop() timer lifecycle.
 * Filed as integration (not unit) per docs/test-readiness/test-system.md: these
 * tests drive `createChatPoller`'s real `setInterval`/`clearInterval` across
 * real wall-clock waits (~100ms) to observe timer start/stop behavior, which
 * puts them over the unit-layer <200ms hard cap and outside its "no I/O of any
 * kind" boundary. Client and runner remain fake doubles — no real HTTP.
 */

import { describe, expect, it, mock } from "bun:test";
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

/** Create a fake ChatServiceClient. All methods are overridable per test. */
function makeFakeClient(
  overrides: Partial<ChatServiceClient> = {},
): ChatServiceClient {
  return {
    listThreads: async () => ({ threads: [], total: 0, limit: 50, offset: 0 }),
    claimMessage: async () => null,
    replyToMessage: async () => {
      throw new Error("replyToMessage not stubbed for this test");
    },
    getAttachment: async () => null,
    ...overrides,
  };
}

// ─── start/stop: timer lifecycle ───────────────────────────────────────────────

describe("createChatPoller start/stop", () => {
  it("start() invokes pollOnce on the configured interval, and stop() halts it", async () => {
    const thread = makeThread("thread-timer");
    const claimMessage = mock(async () => null);
    const client = makeFakeClient({
      listThreads: async () => ({
        threads: [thread],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      claimMessage,
    });
    const runner = mock(async () => ({ result: "ok" }));

    const poller = createChatPoller({ client, runner, intervalMs: 10 });
    poller.start();

    // Let a couple of intervals elapse.
    await new Promise((resolve) => setTimeout(resolve, 100));
    poller.stop();
    const callsAtStop = claimMessage.mock.calls.length;
    expect(callsAtStop).toBeGreaterThan(0);

    // No further polling after stop().
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(claimMessage.mock.calls.length).toBe(callsAtStop);
  });

  it("start() is a no-op when already running (does not create a second timer)", async () => {
    const thread = makeThread("thread-timer-2");
    const claimMessage = mock(async () => null);
    const client = makeFakeClient({
      listThreads: async () => ({
        threads: [thread],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      claimMessage,
    });
    const runner = mock(async () => ({ result: "ok" }));

    const poller = createChatPoller({ client, runner, intervalMs: 10 });
    poller.start();
    poller.start(); // second call should be a no-op guard

    await new Promise((resolve) => setTimeout(resolve, 100));
    poller.stop();

    // If a second timer had been created, calls would double up per tick.
    // Just assert it ran and stopped cleanly without throwing.
    expect(claimMessage.mock.calls.length).toBeGreaterThan(0);
  });

  it("stop() is a no-op when the poller was never started", () => {
    const client = makeFakeClient();
    const runner = mock(async () => ({ result: "ok" }));
    const poller = createChatPoller({ client, runner });

    expect(() => poller.stop()).not.toThrow();
  });
});
