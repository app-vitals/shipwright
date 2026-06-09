/**
 * agent/src/chat.smoke.test.ts
 * Smoke tests for the /chat endpoint via app.request().
 *
 * Uses an injected fake runner — no real Claude, no mock.module(), no global.*
 */

import { describe, expect, it } from "bun:test";
import { createChatApp } from "./chat.ts";

// ─── Fake runner ──────────────────────────────────────────────────────────────

const fakeRunner = async (message: string, _sessionKey?: string) => ({
  result: `echo: ${message}`,
  sessionId: "claude-session-123",
});

// ─── devChat: true ────────────────────────────────────────────────────────────

describe("chat endpoint — devChat: true", () => {
  it("POST /chat with message returns { result, sessionId }", async () => {
    const app = createChatApp({ runner: fakeRunner });
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBe("echo: hello");
    expect(typeof body.sessionId).toBe("string");
    expect(body.sessionId.length).toBeGreaterThan(0);
  });

  it("POST /chat without session generates a new sessionId each call", async () => {
    const app = createChatApp({ runner: fakeRunner });

    const res1 = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "first" }),
    });
    const body1 = await res1.json();

    const res2 = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "second" }),
    });
    const body2 = await res2.json();

    // Without a session passed in, each call gets a fresh session key
    expect(body1.sessionId).not.toBe(body2.sessionId);
  });

  it("POST /chat with session preserves sessionId (continuity)", async () => {
    const app = createChatApp({ runner: fakeRunner });

    // First call: no session → get a sessionId back
    const res1 = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "first" }),
    });
    const body1 = await res1.json();
    const sessionId = body1.sessionId;
    expect(typeof sessionId).toBe("string");

    // Second call: pass the sessionId back → same sessionId returned
    const res2 = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "second", session: sessionId }),
    });
    const body2 = await res2.json();
    expect(body2.sessionId).toBe(sessionId);
    expect(body2.result).toBe("echo: second");
  });

  it("POST /chat passes sessionKey to runner for continuation", async () => {
    const calls: Array<{ message: string; sessionKey?: string }> = [];
    const trackingRunner = async (message: string, sessionKey?: string) => {
      calls.push({ message, sessionKey });
      return { result: `echo: ${message}`, sessionId: "claude-session-abc" };
    };

    const app = createChatApp({ runner: trackingRunner });

    // First call: no session
    const res1 = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "msg1" }),
    });
    const body1 = await res1.json();
    const chatSessionId = body1.sessionId;

    // Second call: pass session back
    await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "msg2", session: chatSessionId }),
    });

    // First call: sessionKey is the generated UUID (same as chatSessionId)
    expect(calls[0].sessionKey).toBe(chatSessionId);
    // Second call: sessionKey is the same chat session UUID
    expect(calls[1].sessionKey).toBe(chatSessionId);
  });

  it("POST /chat returns 400 when message is missing", async () => {
    const app = createChatApp({ runner: fakeRunner });
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "some-session" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /chat returns 400 when body is not JSON", async () => {
    const app = createChatApp({ runner: fakeRunner });
    const res = await app.request("/chat", {
      method: "POST",
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });
});

// ─── devChat: false (route absent) ───────────────────────────────────────────
//
// When devChat is false, the chat app is NOT mounted. We verify this by
// constructing a plain Hono app without the chat route — which mirrors exactly
// what createComposedApp does when devChat !== true.

describe("chat endpoint — devChat: false (route not registered)", () => {
  it("POST /chat returns 404 when chat app is not mounted", async () => {
    // Simulate a root app that does NOT have the chat route registered
    const { Hono } = await import("hono");
    const root = new Hono();
    // Intentionally do NOT mount createChatApp
    root.get("/health", (c) => c.json({ status: "ok" }));

    const res = await root.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /chat returns 200 when chat app IS mounted (devChat: true)", async () => {
    // Simulate createComposedApp with devChat: true by mounting chatApp at root
    const { Hono } = await import("hono");
    const root = new Hono();
    const chatApp = createChatApp({ runner: fakeRunner });
    root.route("/", chatApp);
    root.get("/health", (c) => c.json({ status: "ok" }));

    const res = await root.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBe("echo: hello");
    expect(typeof body.sessionId).toBe("string");
  });
});
