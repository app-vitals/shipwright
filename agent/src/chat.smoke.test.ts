/**
 * agent/src/chat.smoke.test.ts
 *
 * Smoke tests for the dev-only POST /chat endpoint via app.request().
 * Uses an INJECTED fake runner — no real Claude, no globals, no mock.module().
 */

import { describe, expect, it } from "bun:test";
import { createChatApp } from "./chat.ts";
import { createComposedApp } from "./run-agent.ts";
import { makeMockDeps } from "./test-helpers/mock-deps.ts";

/**
 * Build a fake runner mirroring createRunClaude's returned seam:
 * (message, sessionKey?) => Promise<{ result, sessionId?, usage? }>.
 *
 * Records the sessionKey it was invoked with on each call so tests can
 * assert continuity (the second call resumes the prior Claude session).
 */
function makeFakeRunner() {
  const calls: Array<{ message: string; sessionKey?: string }> = [];
  let counter = 0;
  const runner = async (message: string, sessionKey?: string) => {
    calls.push({ message, sessionKey });
    counter += 1;
    return {
      result: `echo:${message}`,
      sessionId: `claude-session-${counter}`,
    };
  };
  return { runner, calls };
}

describe("createChatApp — POST /chat", () => {
  it("returns { result, sessionId } from the injected runner", async () => {
    const { runner } = makeFakeRunner();
    const app = createChatApp({ runner });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBe("echo:hello");
    expect(body.sessionId).toBe("claude-session-1");
  });

  it("preserves Claude session continuity across calls with the same session", async () => {
    const { runner, calls } = makeFakeRunner();
    const app = createChatApp({ runner });

    // First call — no session yet
    const res1 = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "first", session: "conv-1" }),
    });
    const body1 = await res1.json();
    expect(body1.sessionId).toBe("claude-session-1");

    // Second call with the SAME opaque session key — runner must be invoked
    // with the sessionKey resolving to the prior Claude session.
    const res2 = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "second", session: "conv-1" }),
    });
    expect(res2.status).toBe(200);

    // The runner is given the SAME sessionKey on both calls (continuity).
    expect(calls[0].sessionKey).toBeDefined();
    expect(calls[1].sessionKey).toBe(calls[0].sessionKey);
  });

  it("returns 400 when message is missing", async () => {
    const { runner } = makeFakeRunner();
    const app = createChatApp({ runner });
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when message is empty", async () => {
    const { runner } = makeFakeRunner();
    const app = createChatApp({ runner });
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });
    expect(res.status).toBe(400);
  });
});

describe("composed app — /chat gating", () => {
  it("registers /chat when devChat:true and returns runner result", async () => {
    const { runner } = makeFakeRunner();
    const app = createComposedApp({
      ...makeMockDeps(),
      devChat: true,
      chatRunner: runner,
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBe("echo:hi");
  });

  it("does NOT register /chat by default (404)", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(404);
  });
});
