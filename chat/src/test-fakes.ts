/**
 * chat/src/test-fakes.ts
 * In-memory fake implementations for smoke tests.
 * Do not import from production code paths.
 */

import type { Prisma } from "../prisma/client/index.js";
import type { Message, MessageServiceLike } from "./message-service.ts";
import type { Thread, ThreadServiceLike } from "./thread-service.ts";
import type { ChatToken, ChatTokenServiceLike } from "./token-service.ts";

// ─── Token fakes ──────────────────────────────────────────────────────────────

export function fakeAdminTokenService(
  adminToken = "admin-token",
): ChatTokenServiceLike {
  return {
    async create(label?: string, agentId?: string) {
      return {
        token: {
          id: "tok-new",
          token: "hash-new",
          label: label ?? null,
          agentId: agentId ?? null,
          createdAt: new Date(),
          revokedAt: null,
        },
        rawToken: "raw-token-value",
      };
    },
    async validate(raw: string) {
      return raw === adminToken ? { id: "tok-admin", agentId: null } : null;
    },
    async revoke(tokenId: string) {
      if (tokenId === "nonexistent") return null;
      return {
        id: tokenId,
        token: "hash",
        label: null,
        agentId: null,
        createdAt: new Date(),
        revokedAt: new Date(),
      };
    },
    async list(): Promise<ChatToken[]> {
      return [];
    },
    async update() {
      return null;
    },
    async seed() {},
  };
}

export function fakeAgentTokenService(
  agentToken = "agent-token",
  agentId = "agent-1",
): ChatTokenServiceLike {
  return {
    async create(label?: string, aid?: string) {
      return {
        token: {
          id: "tok-agent",
          token: "hash-agent",
          label: label ?? null,
          agentId: aid ?? agentId,
          createdAt: new Date(),
          revokedAt: null,
        },
        rawToken: "raw-agent",
      };
    },
    async validate(raw: string) {
      return raw === agentToken ? { id: "tok-agent", agentId } : null;
    },
    async revoke() {
      return null;
    },
    async list(): Promise<ChatToken[]> {
      return [];
    },
    async update() {
      return null;
    },
    async seed() {},
  };
}

// ─── Thread fakes ─────────────────────────────────────────────────────────────

export function fakeThreadService(
  threads: Thread[] = [],
): ThreadServiceLike & { _threads: Thread[] } {
  const store: Thread[] = [...threads];
  let counter = 1;

  return {
    _threads: store,
    async create(data) {
      const thread: Thread = {
        id: `thread-${counter++}`,
        agentId: data.agentId,
        memberId: data.memberId ?? null,
        title: data.title ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      store.push(thread);
      return thread;
    },
    async findById(id) {
      return store.find((t) => t.id === id) ?? null;
    },
    async list(filter = {}) {
      let results = store;
      if (filter.agentId !== undefined)
        results = results.filter((t) => t.agentId === filter.agentId);
      if (filter.memberId !== undefined)
        results = results.filter((t) => t.memberId === filter.memberId);
      const offset = filter.offset ?? 0;
      const limit = filter.limit ?? 50;
      return {
        threads: results.slice(offset, offset + limit),
        total: results.length,
      };
    },
    async update(id, data) {
      const idx = store.findIndex((t) => t.id === id);
      if (idx === -1) return null;
      const thread = store[idx];
      if (thread === undefined) return null;
      const updated: Thread = {
        ...thread,
        title: data.title !== undefined ? data.title : thread.title,
        memberId:
          data.memberId !== undefined ? data.memberId : thread.memberId,
        updatedAt: new Date(),
      };
      store[idx] = updated;
      return updated;
    },
    async delete(id) {
      const idx = store.findIndex((t) => t.id === id);
      if (idx === -1) return null;
      const [deleted] = store.splice(idx, 1);
      return deleted ?? null;
    },
  };
}

// ─── Message fakes ────────────────────────────────────────────────────────────

export function fakeMessageService(
  messages: Message[] = [],
): MessageServiceLike & { _messages: Message[] } {
  const store: Message[] = [...messages];
  let counter = 1;

  return {
    _messages: store,
    async create(threadId, data) {
      const msg: Message = {
        id: `msg-${counter++}`,
        threadId,
        role: data.role,
        body: data.body,
        tokens: (data.tokens ?? null) as Prisma.JsonValue | null,
        costUsd: data.costUsd ?? null,
        attachmentFilename: data.attachmentFilename ?? null,
        attachmentSize: data.attachmentSize ?? null,
        attachmentBytes: (data.attachmentBytes ?? null) as Prisma.Bytes | null,
        claimed: false,
        claimedAt: null,
        claimedBy: null,
        repliedAt: null,
        errorKind: null,
        createdAt: new Date(),
      };
      store.push(msg);
      return msg;
    },
    async findById(id) {
      return store.find((m) => m.id === id) ?? null;
    },
    async list(threadId, filter = {}) {
      const results = store.filter((m) => m.threadId === threadId);
      const offset = filter.offset ?? 0;
      const limit = filter.limit ?? 50;
      return {
        messages: results.slice(offset, offset + limit),
        total: results.length,
      };
    },
    async update(id, data) {
      const idx = store.findIndex((m) => m.id === id);
      if (idx === -1) return null;
      const msg = store[idx];
      if (msg === undefined) return null;
      const updated: Message = {
        ...msg,
        body: data.body !== undefined ? data.body : msg.body,
        tokens:
          data.tokens !== undefined
            ? ((data.tokens ?? null) as Prisma.JsonValue | null)
            : msg.tokens,
        costUsd: data.costUsd !== undefined ? data.costUsd : msg.costUsd,
        errorKind:
          data.errorKind !== undefined ? data.errorKind : msg.errorKind,
      };
      store[idx] = updated;
      return updated;
    },
    async delete(id) {
      const idx = store.findIndex((m) => m.id === id);
      if (idx === -1) return null;
      const [deleted] = store.splice(idx, 1);
      return deleted ?? null;
    },
    async claim(threadId, claimedBy) {
      const msg = store.find(
        (m) => m.threadId === threadId && m.role === "user" && !m.claimed,
      );
      if (!msg) return null;
      msg.claimed = true;
      msg.claimedAt = new Date();
      msg.claimedBy = claimedBy;
      return msg;
    },
    async reply(messageId, data) {
      const userMsg = store.find((m) => m.id === messageId);
      if (!userMsg || userMsg.repliedAt !== null) return null;
      userMsg.repliedAt = new Date();
      const assistant: Message = {
        id: `msg-${counter++}`,
        threadId: userMsg.threadId,
        role: "assistant",
        body: data.body,
        tokens: (data.tokens ?? null) as Prisma.JsonValue | null,
        costUsd: data.costUsd ?? null,
        attachmentFilename: null,
        attachmentSize: null,
        attachmentBytes: null,
        claimed: false,
        claimedAt: null,
        claimedBy: null,
        repliedAt: null,
        errorKind: null,
        createdAt: new Date(),
      };
      store.push(assistant);
      return { userMessage: userMsg, assistantMessage: assistant };
    },
  };
}
