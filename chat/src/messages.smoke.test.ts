/**
 * chat/src/messages.smoke.test.ts
 *
 * Smoke tests for message CRUD + queue API routes.
 * Tests run in-process via app.request() — no real HTTP socket, no real DB.
 *
 * Covers:
 *   - GET    /threads/:id/messages          list messages
 *   - POST   /threads/:id/messages          create message
 *   - GET    /threads/:id/messages/:msgId   get message
 *   - PATCH  /threads/:id/messages/:msgId   update message
 *   - DELETE /threads/:id/messages/:msgId   delete message
 *   - POST   /threads/:id/messages/claim    claim next unclaimed (queue API)
 *   - POST   /threads/:id/messages/:msgId/reply  agent reply (queue API)
 *   - 413 when attachmentBytes exceeds 10 MB
 *   - 404 when thread not found
 */

import { describe, expect, it } from "bun:test";
import { createChatServiceApp } from "./app.ts";
import type { Message } from "./message-service.ts";
import {
  fakeAdminTokenService,
  fakeAgentTokenService,
  fakeMessageService,
  fakeThreadService,
} from "./test-fakes.ts";

const ADMIN_TOKEN = "admin-token";
const AGENT_TOKEN = "agent-token";
const AGENT_ID = "agent-1";

function buildApp(
  threadService: ReturnType<typeof fakeThreadService>,
  messageService: ReturnType<typeof fakeMessageService>,
) {
  return createChatServiceApp({
    tokenService: fakeAdminTokenService(ADMIN_TOKEN),
    threadService,
    messageService,
  });
}

function agentApp(
  threadService: ReturnType<typeof fakeThreadService>,
  messageService: ReturnType<typeof fakeMessageService>,
) {
  return createChatServiceApp({
    tokenService: fakeAgentTokenService(AGENT_TOKEN, AGENT_ID),
    threadService,
    messageService,
  });
}

const H = {
  get: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  post: {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    "content-type": "application/json",
  },
} as const;

// ─── Create ───────────────────────────────────────────────────────────────────

describe("POST /threads/:id/messages", () => {
  it("creates a user message and returns 201", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const app = buildApp(ts, ms);

    const res = await app.request(`/threads/${thread.id}/messages`, {
      method: "POST",
      headers: H.post,
      body: JSON.stringify({ role: "user", body: "Hello!" }),
    });
    expect(res.status).toBe(201);
    const msg = (await res.json()) as Message;
    expect(msg.role).toBe("user");
    expect(msg.body).toBe("Hello!");
    expect(msg.threadId).toBe(thread.id);
  });

  it("returns 400 when role is missing", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const app = buildApp(ts, ms);

    const res = await app.request(`/threads/${thread.id}/messages`, {
      method: "POST",
      headers: H.post,
      body: JSON.stringify({ body: "Hello" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when role is invalid", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const app = buildApp(ts, ms);

    const res = await app.request(`/threads/${thread.id}/messages`, {
      method: "POST",
      headers: H.post,
      body: JSON.stringify({ role: "system", body: "Hello" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 413 when attachmentBytes exceeds 10 MB", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const app = buildApp(ts, ms);

    // base64 string whose decoded size exceeds 10 MB
    const oversized = "A".repeat(Math.ceil((11 * 1024 * 1024 * 4) / 3));
    const res = await app.request(`/threads/${thread.id}/messages`, {
      method: "POST",
      headers: H.post,
      body: JSON.stringify({
        role: "user",
        body: "Big",
        attachmentBytes: oversized,
      }),
    });
    expect(res.status).toBe(413);
  });

  it("returns 404 when thread does not exist", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const app = buildApp(ts, ms);

    const res = await app.request("/threads/nonexistent/messages", {
      method: "POST",
      headers: H.post,
      body: JSON.stringify({ role: "user", body: "Hi" }),
    });
    expect(res.status).toBe(404);
  });
});

// ─── List ─────────────────────────────────────────────────────────────────────

describe("GET /threads/:id/messages", () => {
  it("returns empty list when thread has no messages", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const app = buildApp(ts, ms);

    const res = await app.request(`/threads/${thread.id}/messages`, {
      headers: H.get,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Message[]; total: number };
    expect(body.messages).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns messages in thread", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    await ms.create(thread.id, { role: "user", body: "Msg 1" });
    await ms.create(thread.id, { role: "assistant", body: "Msg 2" });
    const app = buildApp(ts, ms);

    const res = await app.request(`/threads/${thread.id}/messages`, {
      headers: H.get,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Message[]; total: number };
    expect(body.total).toBe(2);
    expect(body.messages.length).toBe(2);
  });

  it("returns 404 when thread does not exist", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const app = buildApp(ts, ms);

    const res = await app.request("/threads/nonexistent/messages", {
      headers: H.get,
    });
    expect(res.status).toBe(404);
  });
});

// ─── Get ──────────────────────────────────────────────────────────────────────

describe("GET /threads/:id/messages/:msgId", () => {
  it("returns 200 with the message", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const msg = await ms.create(thread.id, { role: "user", body: "Hi" });
    const app = buildApp(ts, ms);

    const res = await app.request(`/threads/${thread.id}/messages/${msg.id}`, {
      headers: H.get,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Message;
    expect(body.id).toBe(msg.id);
  });

  it("returns 404 for unknown message", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/nonexistent`,
      { headers: H.get },
    );
    expect(res.status).toBe(404);
  });
});

// ─── Update ───────────────────────────────────────────────────────────────────

describe("PATCH /threads/:id/messages/:msgId", () => {
  it("updates body and returns 200", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const msg = await ms.create(thread.id, { role: "user", body: "Old" });
    const app = buildApp(ts, ms);

    const res = await app.request(`/threads/${thread.id}/messages/${msg.id}`, {
      method: "PATCH",
      headers: H.post,
      body: JSON.stringify({ body: "Updated" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Message;
    expect(body.body).toBe("Updated");
  });
});

// ─── Delete ───────────────────────────────────────────────────────────────────

describe("DELETE /threads/:id/messages/:msgId", () => {
  it("deletes message and returns 200", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const msg = await ms.create(thread.id, { role: "user", body: "Bye" });
    const app = buildApp(ts, ms);

    const res = await app.request(`/threads/${thread.id}/messages/${msg.id}`, {
      method: "DELETE",
      headers: H.get,
    });
    expect(res.status).toBe(200);
  });
});

// ─── Queue API: claim ─────────────────────────────────────────────────────────

describe("POST /threads/:id/messages/claim", () => {
  it("claims next unclaimed user message and returns 200", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    await ms.create(thread.id, { role: "user", body: "Claim me" });
    const app = buildApp(ts, ms);

    const res = await app.request(`/threads/${thread.id}/messages/claim`, {
      method: "POST",
      headers: H.get,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Message;
    expect(body.claimed).toBe(true);
    expect(body.claimedBy).toBeTruthy();
    expect(body.body).toBe("Claim me");
  });

  it("returns 404 when no unclaimed messages exist", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const app = buildApp(ts, ms);

    const res = await app.request(`/threads/${thread.id}/messages/claim`, {
      method: "POST",
      headers: H.get,
    });
    expect(res.status).toBe(404);
  });

  it("does not claim assistant messages", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    await ms.create(thread.id, { role: "assistant", body: "I'm a reply" });
    const app = buildApp(ts, ms);

    const res = await app.request(`/threads/${thread.id}/messages/claim`, {
      method: "POST",
      headers: H.get,
    });
    expect(res.status).toBe(404);
  });
});

// ─── Queue API: reply ─────────────────────────────────────────────────────────

describe("POST /threads/:id/messages/:msgId/reply", () => {
  it("creates assistant message and marks user message as replied (201)", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, {
      role: "user",
      body: "Help!",
    });
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/reply`,
      {
        method: "POST",
        headers: H.post,
        body: JSON.stringify({ body: "Sure, here is the answer." }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      userMessage: Message;
      assistantMessage: Message;
    };
    expect(body.userMessage.repliedAt).toBeTruthy();
    expect(body.assistantMessage.role).toBe("assistant");
    expect(body.assistantMessage.body).toBe("Sure, here is the answer.");
    expect(body.assistantMessage.threadId).toBe(thread.id);
  });

  it("returns 400 when body is missing", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, {
      role: "user",
      body: "Help!",
    });
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/reply`,
      {
        method: "POST",
        headers: H.post,
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown message", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/nonexistent/reply`,
      {
        method: "POST",
        headers: H.post,
        body: JSON.stringify({ body: "reply" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when target message is an assistant message", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const assistantMsg = await ms.create(thread.id, {
      role: "assistant",
      body: "I already replied.",
    });
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/${assistantMsg.id}/reply`,
      {
        method: "POST",
        headers: H.post,
        body: JSON.stringify({ body: "trying to reply to assistant" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 when message already has a reply", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, { role: "user", body: "Hello" });
    const app = buildApp(ts, ms);

    // First reply — should succeed
    const res1 = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/reply`,
      {
        method: "POST",
        headers: H.post,
        body: JSON.stringify({ body: "First reply" }),
      },
    );
    expect(res1.status).toBe(201);

    // Second reply — should 409
    const res2 = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/reply`,
      {
        method: "POST",
        headers: H.post,
        body: JSON.stringify({ body: "Duplicate reply" }),
      },
    );
    expect(res2.status).toBe(409);
  });
});

// ─── Agent scoping: queue API ─────────────────────────────────────────────────

const AGENT_H = {
  get: { Authorization: `Bearer ${AGENT_TOKEN}` },
  post: {
    Authorization: `Bearer ${AGENT_TOKEN}`,
    "content-type": "application/json",
  },
} as const;

describe("agent scoping — queue API", () => {
  it("POST /claim — agent can claim from own thread (200)", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: AGENT_ID });
    await ms.create(thread.id, { role: "user", body: "Claim me" });
    const app = agentApp(ts, ms);

    const res = await app.request(`/threads/${thread.id}/messages/claim`, {
      method: "POST",
      headers: AGENT_H.get,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Message;
    expect(body.claimed).toBe(true);
  });

  it("POST /claim — agent gets 403 when claiming from another agent's thread", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "other-agent" });
    await ms.create(thread.id, { role: "user", body: "Not yours" });
    const app = agentApp(ts, ms);

    const res = await app.request(`/threads/${thread.id}/messages/claim`, {
      method: "POST",
      headers: AGENT_H.get,
    });
    expect(res.status).toBe(403);
  });

  it("POST /:id/reply — agent can reply in own thread (201)", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: AGENT_ID });
    const userMsg = await ms.create(thread.id, { role: "user", body: "Help!" });
    const app = agentApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/reply`,
      {
        method: "POST",
        headers: AGENT_H.post,
        body: JSON.stringify({ body: "Here you go" }),
      },
    );
    expect(res.status).toBe(201);
  });

  it("POST /:id/reply — agent gets 403 when replying in another agent's thread", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "other-agent" });
    const userMsg = await ms.create(thread.id, {
      role: "user",
      body: "Not yours",
    });
    const app = agentApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/reply`,
      {
        method: "POST",
        headers: AGENT_H.post,
        body: JSON.stringify({ body: "Intruding reply" }),
      },
    );
    expect(res.status).toBe(403);
  });
});
