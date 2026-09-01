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
 *   - POST   /threads/:id/messages/:msgId/heartbeat  bump heartbeatAt (queue API)
 *   - POST   /threads/:id/messages/:msgId/reply  agent reply (queue API)
 *   - 413 when attachmentBytes exceeds 10 MB
 *   - 404 when thread not found
 */

import { describe, expect, it } from "bun:test";
import type { ReplyNotificationEvent } from "@shipwright/lib/chat-notify";
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
  replyNotifier?: (event: ReplyNotificationEvent) => Promise<void>,
) {
  return createChatServiceApp({
    tokenService: fakeAdminTokenService(ADMIN_TOKEN),
    threadService,
    messageService,
    replyNotifier,
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

// ─── Queue API: heartbeat ───────────────────────────────────────────────────────

describe("POST /threads/:id/messages/:msgId/heartbeat", () => {
  it("bumps heartbeatAt and returns 200 for a claimed message", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, {
      role: "user",
      body: "Long-running question",
    });
    // The route derives claimedBy from the caller's token — an admin token
    // resolves to "admin", so the claim must be owned by "admin" to beat it.
    await ms.claim(thread.id, "admin");
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/heartbeat`,
      { method: "POST", headers: H.get },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Message;
    expect(body.heartbeatAt).toBeTruthy();
  });

  it("returns 404 when another worker owns the claim", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, {
      role: "user",
      body: "Long-running question",
    });
    await ms.claim(thread.id, "worker-1");
    const app = buildApp(ts, ms);

    // Caller is admin, but worker-1 holds the claim — keeping someone else's
    // in-flight message looking alive is not the caller's to do.
    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/heartbeat`,
      { method: "POST", headers: H.get },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the message has not been claimed", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, {
      role: "user",
      body: "Long-running question",
    });
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/heartbeat`,
      { method: "POST", headers: H.get },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the message has already been replied to", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, {
      role: "user",
      body: "Long-running question",
    });
    await ms.claim(thread.id, "admin");
    await ms.reply(userMsg.id, { body: "the answer" });
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/heartbeat`,
      { method: "POST", headers: H.get },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the message does not exist", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/does-not-exist/heartbeat`,
      { method: "POST", headers: H.get },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the message belongs to a different thread", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread1 = await ts.create({ agentId: "a1" });
    const thread2 = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread1.id, { role: "user", body: "hi" });
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread2.id}/messages/${userMsg.id}/heartbeat`,
      { method: "POST", headers: H.get },
    );
    expect(res.status).toBe(404);
  });

  it("persists progressPhase and bumps progressSeq when a valid phase is posted", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, {
      role: "user",
      body: "Long-running question",
    });
    await ms.claim(thread.id, "admin");
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/heartbeat`,
      {
        method: "POST",
        headers: H.post,
        body: JSON.stringify({ phase: "reading" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Message;
    expect(body.progressPhase).toBe("reading");
    expect(body.progressSeq).toBe(1);
  });

  it("returns 400 for an invalid phase", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, {
      role: "user",
      body: "Long-running question",
    });
    await ms.claim(thread.id, "admin");
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/heartbeat`,
      {
        method: "POST",
        headers: H.post,
        body: JSON.stringify({ phase: "not-a-real-phase" }),
      },
    );
    expect(res.status).toBe(400);
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

  it("persists an errorKind on the assistant reply when provided", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, { role: "user", body: "Help!" });
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/reply`,
      {
        method: "POST",
        headers: H.post,
        body: JSON.stringify({ body: "Cancelled.", errorKind: "cancelled" }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      assistantMessage: Message;
    };
    expect(body.assistantMessage.errorKind).toBe("cancelled");
  });
});

// ─── Queue API: cancel ────────────────────────────────────────────────────────

describe("POST /threads/:id/messages/:msgId/cancel", () => {
  it("stamps cancelRequestedAt and returns 200 for a claimed message", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, {
      role: "user",
      body: "long task",
    });
    await ms.claim(thread.id, "admin");
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/cancel`,
      { method: "POST", headers: H.get },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Message & {
      cancelRequestedAt: string | null;
    };
    expect(body.cancelRequestedAt).toBeTruthy();
  });

  it("a subsequent heartbeat reflects the cancel request", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, {
      role: "user",
      body: "long task",
    });
    await ms.claim(thread.id, "admin");
    const app = buildApp(ts, ms);

    const cancelRes = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/cancel`,
      { method: "POST", headers: H.get },
    );
    expect(cancelRes.status).toBe(200);

    const beatRes = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/heartbeat`,
      { method: "POST", headers: H.get },
    );
    expect(beatRes.status).toBe(200);
    const beat = (await beatRes.json()) as Message & {
      cancelRequestedAt: string | null;
    };
    expect(beat.cancelRequestedAt).toBeTruthy();
  });

  it("returns 404 for an unknown message", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/nope/cancel`,
      { method: "POST", headers: H.get },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the message belongs to another thread", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const thread2 = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, {
      role: "user",
      body: "long task",
    });
    await ms.claim(thread.id, "admin");
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread2.id}/messages/${userMsg.id}/cancel`,
      { method: "POST", headers: H.get },
    );
    expect(res.status).toBe(404);
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

// ─── Attachment download (ephemeral) ──────────────────────────────────────────

/** Wrap a fake message service, spying on clearAttachmentBytes calls. */
function spyClearAttachment(
  ms: ReturnType<typeof fakeMessageService>,
): ReturnType<typeof fakeMessageService> & { clearedIds: string[] } {
  const clearedIds: string[] = [];
  const original = ms.clearAttachmentBytes.bind(ms);
  return Object.assign(ms, {
    clearedIds,
    async clearAttachmentBytes(id: string) {
      clearedIds.push(id);
      return original(id);
    },
  });
}

describe("GET /threads/:id/messages/:msgId/attachment", () => {
  it("returns 200 with bytes when an attachment exists", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const msg = await ms.create(thread.id, {
      role: "user",
      body: "See attached",
      attachmentFilename: "data.bin",
      attachmentSize: bytes.byteLength,
      attachmentBytes: bytes,
    });
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/${msg.id}/attachment`,
      { headers: H.get },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("data.bin");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns 404 when the message has no attachment bytes", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const msg = await ms.create(thread.id, { role: "user", body: "No file" });
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/${msg.id}/attachment`,
      { headers: H.get },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the message does not exist", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/nonexistent/attachment`,
      { headers: H.get },
    );
    expect(res.status).toBe(404);
  });

  it("clears the attachment bytes after a successful GET", async () => {
    const ts = fakeThreadService();
    const ms = spyClearAttachment(fakeMessageService());
    const thread = await ts.create({ agentId: "a1" });
    const bytes = new Uint8Array([9, 8, 7]);
    const msg = await ms.create(thread.id, {
      role: "user",
      body: "See attached",
      attachmentFilename: "once.bin",
      attachmentSize: bytes.byteLength,
      attachmentBytes: bytes,
    });
    const app = buildApp(ts, ms);

    const res = await app.request(
      `/threads/${thread.id}/messages/${msg.id}/attachment`,
      { headers: H.get },
    );
    expect(res.status).toBe(200);
    // clearAttachmentBytes must have been called for this message id
    expect(ms.clearedIds).toContain(msg.id);

    // A second fetch now finds no bytes → 404 (ephemeral)
    const res2 = await app.request(
      `/threads/${thread.id}/messages/${msg.id}/attachment`,
      { headers: H.get },
    );
    expect(res2.status).toBe(404);
  });
});

// ─── Reply notifier wiring (CFB-4.3) ──────────────────────────────────────────

/** Build a spy replyNotifier that records every call it receives. */
function spyReplyNotifier(behavior: "resolve" | "throw" = "resolve") {
  const calls: ReplyNotificationEvent[] = [];
  const notifier = async (event: ReplyNotificationEvent): Promise<void> => {
    calls.push(event);
    if (behavior === "throw") throw new Error("push webhook unavailable");
  };
  return { notifier, calls };
}

describe("POST /threads/:id/messages/:msgId/reply — reply notifier", () => {
  it("fires the notifier exactly once for a persisted reply", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1", title: "Deploy help" });
    const userMsg = await ms.create(thread.id, { role: "user", body: "Help!" });
    const { notifier, calls } = spyReplyNotifier();
    const app = buildApp(ts, ms, notifier);

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/reply`,
      {
        method: "POST",
        headers: H.post,
        body: JSON.stringify({ body: "Sure, here is the answer." }),
      },
    );

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
  });

  it("notifier payload carries threadId, the thread's agentId, and title — no message body text", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({
      agentId: "owning-agent",
      title: "Deploy help",
    });
    const userMsg = await ms.create(thread.id, { role: "user", body: "Help!" });
    const { notifier, calls } = spyReplyNotifier();
    const app = buildApp(ts, ms, notifier);

    await app.request(`/threads/${thread.id}/messages/${userMsg.id}/reply`, {
      method: "POST",
      headers: H.post,
      body: JSON.stringify({ body: "Sure, here is the answer." }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      threadId: thread.id,
      agentId: "owning-agent",
      title: "Deploy help",
    });
    expect(Object.keys(calls[0] as object)).not.toContain("body");
    expect(Object.keys(calls[0] as object)).not.toContain("preview");
  });

  it("payload uses the thread's agentId, not the calling agent token's identity", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: AGENT_ID });
    const userMsg = await ms.create(thread.id, { role: "user", body: "Help!" });
    const { notifier, calls } = spyReplyNotifier();
    const app = createChatServiceApp({
      tokenService: fakeAgentTokenService(AGENT_TOKEN, AGENT_ID),
      threadService: ts,
      messageService: ms,
      replyNotifier: notifier,
    });

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/reply`,
      {
        method: "POST",
        headers: AGENT_H.post,
        body: JSON.stringify({ body: "Here you go" }),
      },
    );

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.agentId).toBe(AGENT_ID);
    expect(calls[0]?.title).toBeNull();
  });

  it("null thread title is passed through as null, not coerced to an empty string", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, { role: "user", body: "Help!" });
    const { notifier, calls } = spyReplyNotifier();
    const app = buildApp(ts, ms, notifier);

    await app.request(`/threads/${thread.id}/messages/${userMsg.id}/reply`, {
      method: "POST",
      headers: H.post,
      body: JSON.stringify({ body: "Answer" }),
    });

    expect(calls[0]?.title).toBeNull();
  });

  it("reply still returns 201 when the injected notifier throws", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, { role: "user", body: "Help!" });
    const { notifier, calls } = spyReplyNotifier("throw");
    const app = buildApp(ts, ms, notifier);

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/reply`,
      {
        method: "POST",
        headers: H.post,
        body: JSON.stringify({ body: "Sure, here is the answer." }),
      },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { assistantMessage: Message };
    expect(body.assistantMessage.body).toBe("Sure, here is the answer.");
    expect(calls).toHaveLength(1);
  });

  it("reply returns 201 as usual when no notifier is configured (undefined dep)", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, { role: "user", body: "Help!" });
    const app = buildApp(ts, ms, undefined);

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/reply`,
      {
        method: "POST",
        headers: H.post,
        body: JSON.stringify({ body: "Answer" }),
      },
    );

    expect(res.status).toBe(201);
  });

  it("does not fire the notifier on heartbeat", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, {
      role: "user",
      body: "Long-running question",
    });
    await ms.claim(thread.id, "admin");
    const { notifier, calls } = spyReplyNotifier();
    const app = buildApp(ts, ms, notifier);

    const res = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/heartbeat`,
      { method: "POST", headers: H.get },
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("does not fire the notifier on claim", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    await ms.create(thread.id, { role: "user", body: "Claim me" });
    const { notifier, calls } = spyReplyNotifier();
    const app = buildApp(ts, ms, notifier);

    const res = await app.request(`/threads/${thread.id}/messages/claim`, {
      method: "POST",
      headers: H.get,
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("does not fire the notifier on message create", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const { notifier, calls } = spyReplyNotifier();
    const app = buildApp(ts, ms, notifier);

    const res = await app.request(`/threads/${thread.id}/messages`, {
      method: "POST",
      headers: H.post,
      body: JSON.stringify({ role: "user", body: "Hello!" }),
    });

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(0);
  });

  it("does not fire the notifier for a duplicate reply attempt (409)", async () => {
    const ts = fakeThreadService();
    const ms = fakeMessageService();
    const thread = await ts.create({ agentId: "a1" });
    const userMsg = await ms.create(thread.id, { role: "user", body: "Hello" });
    const { notifier, calls } = spyReplyNotifier();
    const app = buildApp(ts, ms, notifier);

    const res1 = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/reply`,
      {
        method: "POST",
        headers: H.post,
        body: JSON.stringify({ body: "First reply" }),
      },
    );
    expect(res1.status).toBe(201);
    expect(calls).toHaveLength(1);

    const res2 = await app.request(
      `/threads/${thread.id}/messages/${userMsg.id}/reply`,
      {
        method: "POST",
        headers: H.post,
        body: JSON.stringify({ body: "Duplicate reply" }),
      },
    );
    expect(res2.status).toBe(409);
    // Still exactly one — the second attempt never persisted a reply.
    expect(calls).toHaveLength(1);
  });
});
