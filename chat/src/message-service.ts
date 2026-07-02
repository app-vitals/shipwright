/**
 * chat/src/message-service.ts
 * MessageService — CRUD for messages + queue operations (claim/reply).
 */

import { Prisma } from "../prisma/client/index.js";
import { type Clock, SystemClock } from "./clock.ts";
import type { Message, PrismaClient } from "./index.ts";

export type { Message };

/** Json value accepted by both service callers and Prisma's NullableJson fields. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface MessageServiceLike {
  create(
    threadId: string,
    data: {
      role: string;
      body: string;
      tokens?: JsonValue;
      costUsd?: number;
      attachmentFilename?: string;
      attachmentSize?: number;
      attachmentBytes?: Uint8Array;
    },
  ): Promise<Message>;

  findById(id: string): Promise<Message | null>;

  list(
    threadId: string,
    filter?: { limit?: number; offset?: number },
  ): Promise<{ messages: Message[]; total: number }>;

  update(
    id: string,
    data: {
      body?: string;
      tokens?: JsonValue;
      costUsd?: number | null;
      errorKind?: string | null;
    },
  ): Promise<Message | null>;

  delete(id: string): Promise<Message | null>;

  /**
   * Atomically claim the next unclaimed user message in a thread.
   * Returns the claimed message, or null if no unclaimed messages exist.
   */
  claim(threadId: string, claimedBy: string): Promise<Message | null>;

  /**
   * Post an agent reply to a claimed message.
   * Creates an assistant message and marks the user message with repliedAt.
   * Returns null if the user message is not found.
   */
  reply(
    messageId: string,
    data: {
      body: string;
      tokens?: JsonValue;
      costUsd?: number;
    },
  ): Promise<{ userMessage: Message; assistantMessage: Message } | null>;
}

export class MessageService implements MessageServiceLike {
  constructor(
    private prisma: PrismaClient,
    private clock: Clock = SystemClock(),
  ) {}

  async create(
    threadId: string,
    data: {
      role: string;
      body: string;
      tokens?: JsonValue;
      costUsd?: number;
      attachmentFilename?: string;
      attachmentSize?: number;
      attachmentBytes?: Uint8Array;
    },
  ): Promise<Message> {
    return this.prisma.message.create({
      data: {
        threadId,
        role: data.role,
        body: data.body,
        tokens:
          data.tokens !== undefined
            ? (data.tokens as Prisma.InputJsonValue)
            : Prisma.DbNull,
        costUsd: data.costUsd ?? null,
        attachmentFilename: data.attachmentFilename ?? null,
        attachmentSize: data.attachmentSize ?? null,
        attachmentBytes: data.attachmentBytes
          ? toBytes(data.attachmentBytes)
          : null,
      },
    });
  }

  async findById(id: string): Promise<Message | null> {
    return this.prisma.message.findUnique({ where: { id } });
  }

  async list(
    threadId: string,
    filter: { limit?: number; offset?: number } = {},
  ): Promise<{ messages: Message[]; total: number }> {
    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = filter.offset ?? 0;

    const [messages, total] = await Promise.all([
      this.prisma.message.findMany({
        where: { threadId },
        orderBy: { createdAt: "asc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.message.count({ where: { threadId } }),
    ]);

    return { messages, total };
  }

  async update(
    id: string,
    data: {
      body?: string;
      tokens?: JsonValue;
      costUsd?: number | null;
      errorKind?: string | null;
    },
  ): Promise<Message | null> {
    const updateData: Prisma.MessageUpdateInput = {};
    if (data.body !== undefined) updateData.body = data.body;
    if (data.tokens !== undefined)
      updateData.tokens = data.tokens as Prisma.InputJsonValue;
    if (data.costUsd !== undefined) updateData.costUsd = data.costUsd;
    if (data.errorKind !== undefined) updateData.errorKind = data.errorKind;

    try {
      return await this.prisma.message.update({ where: { id }, data: updateData });
    } catch (err: unknown) {
      if (isPrismaNotFound(err)) return null;
      throw err;
    }
  }

  async delete(id: string): Promise<Message | null> {
    try {
      return await this.prisma.message.delete({ where: { id } });
    } catch (err: unknown) {
      if (isPrismaNotFound(err)) return null;
      throw err;
    }
  }

  async claim(threadId: string, claimedBy: string): Promise<Message | null> {
    // Find the oldest unclaimed user message in this thread.
    const next = await this.prisma.message.findFirst({
      where: { threadId, role: "user", claimed: false },
      orderBy: { createdAt: "asc" },
    });
    if (!next) return null;

    try {
      return await this.prisma.message.update({
        where: { id: next.id, claimed: false },
        data: { claimed: true, claimedAt: this.clock.now(), claimedBy },
      });
    } catch (err: unknown) {
      // Another worker claimed it between our findFirst and update — return null.
      if (isPrismaNotFound(err)) return null;
      throw err;
    }
  }

  async reply(
    messageId: string,
    data: {
      body: string;
      tokens?: JsonValue;
      costUsd?: number;
    },
  ): Promise<{ userMessage: Message; assistantMessage: Message } | null> {
    const userMessage = await this.prisma.message.findUnique({
      where: { id: messageId },
    });
    if (!userMessage) return null;
    if (userMessage.repliedAt !== null) return null;

    const now = this.clock.now();
    const [updatedUser, assistant] = await Promise.all([
      this.prisma.message.update({
        where: { id: messageId },
        data: { repliedAt: now },
      }),
      this.prisma.message.create({
        data: {
          threadId: userMessage.threadId,
          role: "assistant",
          body: data.body,
          tokens:
            data.tokens !== undefined
              ? (data.tokens as Prisma.InputJsonValue)
              : Prisma.DbNull,
          costUsd: data.costUsd ?? null,
        },
      }),
    ]);

    return { userMessage: updatedUser, assistantMessage: assistant };
  }
}

function isPrismaNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2025"
  );
}

/** Convert a Uint8Array (or Buffer) to the exact Uint8Array<ArrayBuffer> type Prisma expects. */
function toBytes(u: Uint8Array): Prisma.Bytes {
  // Ensure we have an owned ArrayBuffer (not SharedArrayBuffer)
  const ab = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
  return new Uint8Array(ab);
}
