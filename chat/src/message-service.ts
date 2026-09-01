/**
 * chat/src/message-service.ts
 * MessageService — CRUD for messages + queue operations (claim/reply).
 */

import { PROGRESS_PHASES } from "@shipwright/lib/progress-phases";
import { Prisma } from "../prisma/client/index.js";
import { type Clock, SystemClock } from "./clock.ts";
import { BadRequestError } from "./errors.ts";
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
   * Drop the attachment bytes for a message, retaining only its metadata.
   * Used after the agent pulls a file into its workspace so content is not
   * retained long-term. Returns the updated message or null if not found.
   */
  clearAttachmentBytes(id: string): Promise<Message | null>;

  /**
   * Atomically claim the next unclaimed user message in a thread.
   * Returns the claimed message, or null if no unclaimed messages exist.
   */
  claim(threadId: string, claimedBy: string): Promise<Message | null>;

  /**
   * Bump a claimed message's heartbeatAt to now — proof of life for a
   * long-running reply. Scoped to the claim's owner: returns null unless the
   * message is an unreplied user message currently claimed by `claimedBy`.
   *
   * When `phase` is provided it must be one of PROGRESS_PHASES — otherwise
   * this throws BadRequestError and no write happens. progressSeq is always
   * incremented by exactly 1 in the same update as heartbeatAt (and
   * progressPhase, when phase is given) — last-write-wins, not an
   * append-only log.
   */
  heartbeat(
    id: string,
    claimedBy: string,
    phase?: string,
  ): Promise<Message | null>;

  /**
   * Post an agent reply to a claimed message.
   * Creates an assistant message and marks the user message with repliedAt.
   * Returns null if the user message is not found.
   *
   * When `errorKind` is set it is stamped on the assistant message (e.g.
   * "cancelled" / "incomplete" / "stalled") so the UI can render a Retry
   * affordance. The whole reply runs in a single transaction — a partial
   * failure never leaves repliedAt set with no assistant message.
   */
  reply(
    messageId: string,
    data: {
      body: string;
      tokens?: JsonValue;
      costUsd?: number;
      errorKind?: string | null;
    },
  ): Promise<{ userMessage: Message; assistantMessage: Message } | null>;

  /**
   * Request cancellation of an in-flight reply by stamping cancelRequestedAt.
   * The claiming agent observes this on its next heartbeat tick and aborts.
   * Returns the updated message, or null if the message is not found.
   */
  requestCancel(id: string): Promise<Message | null>;
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
      return await this.prisma.message.update({
        where: { id },
        data: updateData,
      });
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

  async clearAttachmentBytes(id: string): Promise<Message | null> {
    try {
      return await this.prisma.message.update({
        where: { id },
        data: { attachmentBytes: null },
      });
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

  async heartbeat(
    id: string,
    claimedBy: string,
    phase?: string,
  ): Promise<Message | null> {
    if (phase !== undefined && !PROGRESS_PHASES.includes(phase as never)) {
      throw new BadRequestError(
        `invalid phase: ${phase} (must be one of ${PROGRESS_PHASES.join(", ")})`,
      );
    }

    const data: Prisma.MessageUpdateInput = {
      heartbeatAt: this.clock.now(),
      // progressSeq is a deterministic, clock-skew-free change-detector: under
      // FixedClock, heartbeatAt is byte-identical across two beats, so an
      // incrementing integer is what makes "did this heartbeat land" testable.
      progressSeq: { increment: 1 },
    };
    if (phase !== undefined) data.progressPhase = phase;

    try {
      // Scoped to the current owner of an in-flight claim: only the agent that
      // actually claimed this message, and only while the reply is still
      // outstanding. An unscoped update would let any caller authorized for
      // the thread keep an arbitrary message looking alive.
      return await this.prisma.message.update({
        where: { id, role: "user", claimed: true, repliedAt: null, claimedBy },
        data,
      });
    } catch (err: unknown) {
      // Not found, unclaimed, already replied, or owned by another worker —
      // all surface as P2025.
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
      errorKind?: string | null;
    },
  ): Promise<{ userMessage: Message; assistantMessage: Message } | null> {
    const userMessage = await this.prisma.message.findUnique({
      where: { id: messageId },
    });
    if (!userMessage) return null;
    if (userMessage.repliedAt !== null) return null;

    const now = this.clock.now();
    // A real transaction, not Promise.all: either both the repliedAt stamp and
    // the assistant message land, or neither does. A partial failure must never
    // leave repliedAt set with no reply to show.
    const [updatedUser, assistant] = await this.prisma.$transaction([
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
          errorKind: data.errorKind ?? null,
        },
      }),
    ]);

    return { userMessage: updatedUser, assistantMessage: assistant };
  }

  async requestCancel(id: string): Promise<Message | null> {
    try {
      return await this.prisma.message.update({
        where: { id },
        data: { cancelRequestedAt: this.clock.now() },
      });
    } catch (err: unknown) {
      if (isPrismaNotFound(err)) return null;
      throw err;
    }
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
  const ab = u.buffer.slice(
    u.byteOffset,
    u.byteOffset + u.byteLength,
  ) as ArrayBuffer;
  return new Uint8Array(ab);
}
