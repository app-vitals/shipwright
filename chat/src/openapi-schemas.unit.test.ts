/**
 * chat/src/openapi-schemas.unit.test.ts
 * Parse/reject tests for all Zod entity schemas in openapi-schemas.ts.
 * Tests validate that good input parses cleanly and bad input produces typed errors.
 */

import { describe, expect, test } from "bun:test";
import {
  type ChatToken,
  ChatTokenSchema,
  ErrorSchema,
  type Message,
  MessageSchema,
  type Thread,
  ThreadSchema,
  type ThreadStats,
  ThreadStatsSchema,
} from "./openapi-schemas.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const now = new Date().toISOString();
const yesterday = new Date(Date.now() - 86400000).toISOString();

const validChatToken = {
  id: "clxtoken123456",
  label: "ci-runner",
  agentId: "agent-id-123",
  createdAt: now,
  revokedAt: null,
};

const validThread = {
  id: "clxthread123456",
  agentId: "agent-id-123",
  memberId: "member-id-123",
  title: "Deployment question",
  createdAt: yesterday,
  updatedAt: now,
};

const validMessage = {
  id: "clxmessage123456",
  threadId: "clxthread123456",
  role: "user",
  body: "How do I deploy this?",
  tokens: { input_tokens: 10, output_tokens: 20 },
  costUsd: 0.02,
  attachmentFilename: "screenshot.png",
  attachmentSize: 1024,
  claimed: true,
  claimedAt: yesterday,
  claimedBy: "agent-id-123",
  repliedAt: now,
  errorKind: null,
  createdAt: yesterday,
};

const validThreadStats = {
  messageCount: 5,
  totalInputTokens: 100,
  totalOutputTokens: 200,
  totalCostUsd: 0.05,
};

// ─── ChatTokenSchema ────────────────────────────────────────────────────────────

describe("ChatTokenSchema", () => {
  test("parses valid chat token with all fields", () => {
    const result = ChatTokenSchema.safeParse(validChatToken);
    expect(result.success).toBe(true);
    if (result.success) {
      const token: ChatToken = result.data;
      expect(token.id).toBe("clxtoken123456");
      expect(token.label).toBe("ci-runner");
      expect(token.agentId).toBe("agent-id-123");
    }
  });

  test("parses chat token with minimal fields", () => {
    const minimal = {
      id: "clxtoken123456",
      createdAt: now,
    };
    const result = ChatTokenSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  test("parses chat token with nullable fields as null", () => {
    const result = ChatTokenSchema.safeParse({
      ...validChatToken,
      label: null,
      agentId: null,
      revokedAt: null,
    });
    expect(result.success).toBe(true);
  });

  test("does not expose token hash", () => {
    const withHash = { ...validChatToken, token: "sha256_hash_value" };
    const result = ChatTokenSchema.safeParse(withHash);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).token).toBeUndefined();
    }
  });

  test("rejects missing id", () => {
    const { id: _, ...noId } = validChatToken;
    const result = ChatTokenSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  test("rejects missing createdAt", () => {
    const { createdAt: _, ...noCreatedAt } = validChatToken;
    const result = ChatTokenSchema.safeParse(noCreatedAt);
    expect(result.success).toBe(false);
  });

  test("rejects non-string id", () => {
    const result = ChatTokenSchema.safeParse({ ...validChatToken, id: 123 });
    expect(result.success).toBe(false);
  });
});

// ─── ThreadSchema ─────────────────────────────────────────────────────────────

describe("ThreadSchema", () => {
  test("parses valid thread with all fields", () => {
    const result = ThreadSchema.safeParse(validThread);
    expect(result.success).toBe(true);
    if (result.success) {
      const thread: Thread = result.data;
      expect(thread.id).toBe("clxthread123456");
      expect(thread.agentId).toBe("agent-id-123");
      expect(thread.title).toBe("Deployment question");
    }
  });

  test("parses thread with minimal fields", () => {
    const minimal = {
      id: "clxthread123456",
      agentId: "agent-id-123",
      createdAt: now,
      updatedAt: now,
    };
    const result = ThreadSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  test("parses thread with nullable fields as null", () => {
    const result = ThreadSchema.safeParse({
      ...validThread,
      memberId: null,
      title: null,
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing id", () => {
    const { id: _, ...noId } = validThread;
    const result = ThreadSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  test("rejects missing agentId", () => {
    const { agentId: _, ...noAgentId } = validThread;
    const result = ThreadSchema.safeParse(noAgentId);
    expect(result.success).toBe(false);
  });

  test("rejects missing createdAt", () => {
    const { createdAt: _, ...noCreatedAt } = validThread;
    const result = ThreadSchema.safeParse(noCreatedAt);
    expect(result.success).toBe(false);
  });

  test("rejects missing updatedAt", () => {
    const { updatedAt: _, ...noUpdatedAt } = validThread;
    const result = ThreadSchema.safeParse(noUpdatedAt);
    expect(result.success).toBe(false);
  });

  test("rejects non-string agentId", () => {
    const result = ThreadSchema.safeParse({ ...validThread, agentId: 123 });
    expect(result.success).toBe(false);
  });
});

// ─── MessageSchema ────────────────────────────────────────────────────────────

describe("MessageSchema", () => {
  test("parses valid message with all fields", () => {
    const result = MessageSchema.safeParse(validMessage);
    expect(result.success).toBe(true);
    if (result.success) {
      const message: Message = result.data;
      expect(message.id).toBe("clxmessage123456");
      expect(message.threadId).toBe("clxthread123456");
      expect(message.role).toBe("user");
      expect(message.body).toBe("How do I deploy this?");
    }
  });

  test("parses message with minimal fields", () => {
    const minimal = {
      id: "clxmessage123456",
      threadId: "clxthread123456",
      role: "assistant",
      body: "You can deploy via task deploy.",
      claimed: false,
      createdAt: now,
    };
    const result = MessageSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  test("parses message with nullable fields as null", () => {
    const result = MessageSchema.safeParse({
      ...validMessage,
      tokens: null,
      costUsd: null,
      attachmentFilename: null,
      attachmentSize: null,
      claimedAt: null,
      claimedBy: null,
      repliedAt: null,
      errorKind: null,
    });
    expect(result.success).toBe(true);
  });

  test("accepts both valid role values", () => {
    for (const role of ["user", "assistant"]) {
      const result = MessageSchema.safeParse({ ...validMessage, role });
      expect(result.success).toBe(true);
    }
  });

  test("rejects invalid role", () => {
    const result = MessageSchema.safeParse({
      ...validMessage,
      role: "system",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing id", () => {
    const { id: _, ...noId } = validMessage;
    const result = MessageSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  test("rejects missing threadId", () => {
    const { threadId: _, ...noThreadId } = validMessage;
    const result = MessageSchema.safeParse(noThreadId);
    expect(result.success).toBe(false);
  });

  test("rejects missing role", () => {
    const { role: _, ...noRole } = validMessage;
    const result = MessageSchema.safeParse(noRole);
    expect(result.success).toBe(false);
  });

  test("rejects missing body", () => {
    const { body: _, ...noBody } = validMessage;
    const result = MessageSchema.safeParse(noBody);
    expect(result.success).toBe(false);
  });

  test("rejects missing createdAt", () => {
    const { createdAt: _, ...noCreatedAt } = validMessage;
    const result = MessageSchema.safeParse(noCreatedAt);
    expect(result.success).toBe(false);
  });

  test("rejects non-boolean claimed", () => {
    const result = MessageSchema.safeParse({ ...validMessage, claimed: "yes" });
    expect(result.success).toBe(false);
  });

  test("rejects non-number costUsd", () => {
    const result = MessageSchema.safeParse({
      ...validMessage,
      costUsd: "0.02",
    });
    expect(result.success).toBe(false);
  });

  test("parses tokens as a record", () => {
    const result = MessageSchema.safeParse({
      ...validMessage,
      tokens: { input_tokens: 5, output_tokens: 10, extra: "value" },
    });
    expect(result.success).toBe(true);
  });

  test("does not expose attachmentBytes", () => {
    const withBytes = { ...validMessage, attachmentBytes: "base64data" };
    const result = MessageSchema.safeParse(withBytes);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        (result.data as Record<string, unknown>).attachmentBytes,
      ).toBeUndefined();
    }
  });
});

// ─── ThreadStatsSchema ────────────────────────────────────────────────────────

describe("ThreadStatsSchema", () => {
  test("parses valid thread stats", () => {
    const result = ThreadStatsSchema.safeParse(validThreadStats);
    expect(result.success).toBe(true);
    if (result.success) {
      const stats: ThreadStats = result.data;
      expect(stats.messageCount).toBe(5);
      expect(stats.totalInputTokens).toBe(100);
      expect(stats.totalOutputTokens).toBe(200);
      expect(stats.totalCostUsd).toBe(0.05);
    }
  });

  test("rejects missing messageCount", () => {
    const { messageCount: _, ...noMessageCount } = validThreadStats;
    const result = ThreadStatsSchema.safeParse(noMessageCount);
    expect(result.success).toBe(false);
  });

  test("rejects missing totalInputTokens", () => {
    const { totalInputTokens: _, ...noTotalInputTokens } = validThreadStats;
    const result = ThreadStatsSchema.safeParse(noTotalInputTokens);
    expect(result.success).toBe(false);
  });

  test("rejects missing totalOutputTokens", () => {
    const { totalOutputTokens: _, ...noTotalOutputTokens } = validThreadStats;
    const result = ThreadStatsSchema.safeParse(noTotalOutputTokens);
    expect(result.success).toBe(false);
  });

  test("rejects missing totalCostUsd", () => {
    const { totalCostUsd: _, ...noTotalCostUsd } = validThreadStats;
    const result = ThreadStatsSchema.safeParse(noTotalCostUsd);
    expect(result.success).toBe(false);
  });

  test("rejects non-number messageCount", () => {
    const result = ThreadStatsSchema.safeParse({
      ...validThreadStats,
      messageCount: "5",
    });
    expect(result.success).toBe(false);
  });
});

// ─── ErrorSchema ──────────────────────────────────────────────────────────────

describe("ErrorSchema", () => {
  test("parses valid error response", () => {
    const result = ErrorSchema.safeParse({ error: "Not found" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error).toBe("Not found");
    }
  });

  test("rejects missing error string", () => {
    const result = ErrorSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
