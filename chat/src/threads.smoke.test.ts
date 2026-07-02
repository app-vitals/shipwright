/**
 * chat/src/threads.smoke.test.ts
 *
 * Smoke tests for thread CRUD routes.
 * Tests run in-process via app.request() — no real HTTP socket, no real DB.
 *
 * Covers:
 *   - GET    /threads               list threads (admin sees all; agent sees own)
 *   - POST   /threads               create thread
 *   - GET    /threads/:id           get thread
 *   - PATCH  /threads/:id           update thread
 *   - DELETE /threads/:id           delete thread
 *   - 403 when agent accesses another agent's thread
 */

import { describe, expect, it } from "bun:test";
import { createChatServiceApp } from "./app.ts";
import type { Thread } from "./thread-service.ts";
import {
  fakeAdminTokenService,
  fakeAgentTokenService,
  fakeMessageService,
  fakeThreadService,
} from "./test-fakes.ts";

const ADMIN_TOKEN = "admin-token";
const AGENT_TOKEN = "agent-token";
const AGENT_ID = "agent-1";

const HA = (token = ADMIN_TOKEN) => ({ Authorization: `Bearer ${token}` });
const HP = (token = ADMIN_TOKEN) => ({
  Authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

function adminApp(threadService = fakeThreadService()) {
  return createChatServiceApp({
    tokenService: fakeAdminTokenService(ADMIN_TOKEN),
    threadService,
    messageService: fakeMessageService(),
  });
}

function agentApp(threadService = fakeThreadService()) {
  return createChatServiceApp({
    tokenService: fakeAgentTokenService(AGENT_TOKEN, AGENT_ID),
    threadService,
    messageService: fakeMessageService(),
  });
}

// ─── Create ───────────────────────────────────────────────────────────────────

describe("POST /threads", () => {
  it("admin can create a thread and returns 201", async () => {
    const app = adminApp();
    const res = await app.request("/threads", {
      method: "POST",
      headers: HP(),
      body: JSON.stringify({ agentId: "agent-x", title: "Hello" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Thread;
    expect(body.agentId).toBe("agent-x");
    expect(body.title).toBe("Hello");
  });

  it("agent can create a thread for themselves", async () => {
    const app = agentApp();
    const res = await app.request("/threads", {
      method: "POST",
      headers: HP(AGENT_TOKEN),
      body: JSON.stringify({ agentId: AGENT_ID }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Thread;
    expect(body.agentId).toBe(AGENT_ID);
  });

  it("agent cannot create a thread for another agent (403)", async () => {
    const app = agentApp();
    const res = await app.request("/threads", {
      method: "POST",
      headers: HP(AGENT_TOKEN),
      body: JSON.stringify({ agentId: "other-agent" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 when agentId is missing", async () => {
    const app = adminApp();
    const res = await app.request("/threads", {
      method: "POST",
      headers: HP(),
      body: JSON.stringify({ title: "No agent" }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── List ─────────────────────────────────────────────────────────────────────

describe("GET /threads", () => {
  it("returns empty list when no threads exist", async () => {
    const app = adminApp();
    const res = await app.request("/threads", { headers: HA() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: Thread[]; total: number };
    expect(body.threads).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns threads created via admin", async () => {
    const ts = fakeThreadService();
    await ts.create({ agentId: "a1", title: "T1" });
    await ts.create({ agentId: "a2", title: "T2" });
    const app = adminApp(ts);
    const res = await app.request("/threads", { headers: HA() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: Thread[]; total: number };
    expect(body.total).toBe(2);
  });

  it("agent only sees their own threads", async () => {
    const ts = fakeThreadService();
    await ts.create({ agentId: AGENT_ID, title: "Mine" });
    await ts.create({ agentId: "other", title: "Not mine" });
    const app = agentApp(ts);
    const res = await app.request("/threads", { headers: HA(AGENT_TOKEN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: Thread[]; total: number };
    expect(body.threads.every((t) => t.agentId === AGENT_ID)).toBe(true);
    expect(body.total).toBe(1);
  });
});

// ─── Get ──────────────────────────────────────────────────────────────────────

describe("GET /threads/:id", () => {
  it("returns 200 with thread data", async () => {
    const ts = fakeThreadService();
    const thread = await ts.create({ agentId: "a1", title: "T1" });
    const app = adminApp(ts);
    const res = await app.request(`/threads/${thread.id}`, { headers: HA() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Thread;
    expect(body.id).toBe(thread.id);
  });

  it("returns 404 for unknown thread", async () => {
    const app = adminApp();
    const res = await app.request("/threads/nonexistent", { headers: HA() });
    expect(res.status).toBe(404);
  });

  it("agent cannot access another agent's thread (403)", async () => {
    const ts = fakeThreadService();
    const thread = await ts.create({
      agentId: "other-agent",
      title: "Not mine",
    });
    const app = agentApp(ts);
    const res = await app.request(`/threads/${thread.id}`, {
      headers: HA(AGENT_TOKEN),
    });
    expect(res.status).toBe(403);
  });
});

// ─── Update ───────────────────────────────────────────────────────────────────

describe("PATCH /threads/:id", () => {
  it("updates title and returns 200", async () => {
    const ts = fakeThreadService();
    const thread = await ts.create({ agentId: "a1", title: "Old" });
    const app = adminApp(ts);
    const res = await app.request(`/threads/${thread.id}`, {
      method: "PATCH",
      headers: HP(),
      body: JSON.stringify({ title: "New" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Thread;
    expect(body.title).toBe("New");
  });

  it("returns 404 for unknown thread", async () => {
    const app = adminApp();
    const res = await app.request("/threads/nonexistent", {
      method: "PATCH",
      headers: HP(),
      body: JSON.stringify({ title: "X" }),
    });
    expect(res.status).toBe(404);
  });
});

// ─── Delete ───────────────────────────────────────────────────────────────────

describe("DELETE /threads/:id", () => {
  it("deletes thread and returns 200", async () => {
    const ts = fakeThreadService();
    const thread = await ts.create({ agentId: "a1" });
    const app = adminApp(ts);
    const res = await app.request(`/threads/${thread.id}`, {
      method: "DELETE",
      headers: HA(),
    });
    expect(res.status).toBe(200);
    // Should now be gone.
    const res2 = await app.request(`/threads/${thread.id}`, {
      headers: HA(),
    });
    expect(res2.status).toBe(404);
  });

  it("returns 404 for unknown thread", async () => {
    const app = adminApp();
    const res = await app.request("/threads/nonexistent", {
      method: "DELETE",
      headers: HA(),
    });
    expect(res.status).toBe(404);
  });
});
