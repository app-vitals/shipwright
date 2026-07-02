/**
 * chat/src/routes/messages.ts
 * Message CRUD + queue API routes.
 *
 * Routes:
 *   GET    /                  list messages in thread
 *   POST   /                  create message
 *   POST   /claim             claim next unclaimed user message (queue API)
 *   GET    /:id               get message
 *   PATCH  /:id               update message
 *   DELETE /:id               delete message
 *   POST   /:id/reply         agent reply to a message (queue API)
 *
 * The /:threadId param is provided by the parent mount in app.ts — routes here
 * access it via c.req.param("threadId") as string.
 *
 * Attachment size guard: attachmentBytes maps to a Postgres bytea column loaded
 * in full on every Message read; cap at MAX_ATTACHMENT_BYTES to prevent WAL bloat.
 */

import { Hono } from "hono";
import type { ChatAuthEnv } from "../auth.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
} from "../errors.ts";
import type { JsonValue, MessageServiceLike } from "../message-service.ts";
import type { ThreadServiceLike } from "../thread-service.ts";
import { parseIntParam } from "./utils.ts";

/** Maximum allowed size for message attachment bytes (10 MB). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function createMessagesRoutes(
  threadService: ThreadServiceLike,
  messageService: MessageServiceLike,
): Hono<ChatAuthEnv> {
  const app = new Hono<ChatAuthEnv>();

  // ─── List ──────────────────────────────────────────────────────────────────
  app.get("/", async (c) => {
    // threadId is always present — guaranteed by the /threads/:threadId/messages mount
    const threadId = c.req.param("threadId") as string;
    await requireThread(c, threadService, threadId);

    const limit = parseIntParam(c.req.query("limit"), 50);
    const offset = parseIntParam(c.req.query("offset"), 0);

    const { messages, total } = await messageService.list(threadId, {
      limit,
      offset,
    });
    return c.json({ messages, total, limit, offset }, 200);
  });

  // ─── Create ────────────────────────────────────────────────────────────────
  app.post("/", async (c) => {
    const threadId = c.req.param("threadId") as string;
    await requireThread(c, threadService, threadId);

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON or empty body — validation below will catch missing fields.
    }

    const role = typeof body.role === "string" ? body.role : undefined;
    if (!role) throw new BadRequestError("role is required");
    if (role !== "user" && role !== "assistant") {
      throw new BadRequestError("role must be 'user' or 'assistant'");
    }

    const messageBody = typeof body.body === "string" ? body.body : undefined;
    if (messageBody === undefined) throw new BadRequestError("body is required");

    // Attachment size guard.
    let attachmentBytes: Uint8Array | undefined;
    if (body.attachmentBytes !== undefined) {
      let byteLength = 0;
      if (typeof body.attachmentBytes === "string") {
        byteLength = Math.ceil((body.attachmentBytes.length * 3) / 4);
        if (byteLength > MAX_ATTACHMENT_BYTES) {
          throw new PayloadTooLargeError(
            `attachmentBytes exceeds the 10 MB limit (received ~${Math.round(byteLength / 1024 / 1024)} MB)`,
          );
        }
        const buf = Buffer.from(body.attachmentBytes, "base64");
        attachmentBytes = new Uint8Array(
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
        );
      } else if (body.attachmentBytes instanceof Uint8Array) {
        byteLength = body.attachmentBytes.byteLength;
        if (byteLength > MAX_ATTACHMENT_BYTES) {
          throw new PayloadTooLargeError(
            `attachmentBytes exceeds the 10 MB limit (received ~${Math.round(byteLength / 1024 / 1024)} MB)`,
          );
        }
        attachmentBytes = body.attachmentBytes;
      }
    }

    const message = await messageService.create(threadId, {
      role,
      body: messageBody,
      tokens:
        body.tokens !== undefined ? (body.tokens as JsonValue) : undefined,
      costUsd: typeof body.costUsd === "number" ? body.costUsd : undefined,
      attachmentFilename:
        typeof body.attachmentFilename === "string"
          ? body.attachmentFilename
          : undefined,
      attachmentSize:
        typeof body.attachmentSize === "number" ? body.attachmentSize : undefined,
      attachmentBytes,
    });
    return c.json(message, 201);
  });

  // ─── Claim (queue API) ─────────────────────────────────────────────────────
  // Registered before /:id routes so "claim" is matched as a static segment.
  app.post("/claim", async (c) => {
    const threadId = c.req.param("threadId") as string;
    await requireThread(c, threadService, threadId);

    const callerAgentId = c.get("agentId");
    const claimedBy = callerAgentId ?? "admin";

    const claimed = await messageService.claim(threadId, claimedBy);
    if (!claimed) throw new NotFoundError("no unclaimed messages in thread");
    return c.json(claimed, 200);
  });

  // ─── Get ───────────────────────────────────────────────────────────────────
  app.get("/:id", async (c) => {
    const threadId = c.req.param("threadId") as string;
    await requireThread(c, threadService, threadId);

    const message = await messageService.findById(c.req.param("id") as string);
    if (!message || message.threadId !== threadId)
      throw new NotFoundError("message not found");
    return c.json(message, 200);
  });

  // ─── Update ────────────────────────────────────────────────────────────────
  app.patch("/:id", async (c) => {
    const threadId = c.req.param("threadId") as string;
    await requireThread(c, threadService, threadId);

    const existing = await messageService.findById(c.req.param("id") as string);
    if (!existing || existing.threadId !== threadId)
      throw new NotFoundError("message not found");

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // empty body → no-op
    }

    const updated = await messageService.update(c.req.param("id") as string, {
      body: typeof body.body === "string" ? body.body : undefined,
      tokens:
        body.tokens !== undefined ? (body.tokens as JsonValue) : undefined,
      costUsd:
        typeof body.costUsd === "number" || body.costUsd === null
          ? (body.costUsd as number | null)
          : undefined,
      errorKind:
        typeof body.errorKind === "string" || body.errorKind === null
          ? (body.errorKind as string | null)
          : undefined,
    });
    if (!updated) throw new NotFoundError("message not found");
    return c.json(updated, 200);
  });

  // ─── Delete ────────────────────────────────────────────────────────────────
  app.delete("/:id", async (c) => {
    const threadId = c.req.param("threadId") as string;
    await requireThread(c, threadService, threadId);

    const existing = await messageService.findById(c.req.param("id") as string);
    if (!existing || existing.threadId !== threadId)
      throw new NotFoundError("message not found");

    const deleted = await messageService.delete(c.req.param("id") as string);
    if (!deleted) throw new NotFoundError("message not found");
    return c.json(deleted, 200);
  });

  // ─── Reply (queue API) ─────────────────────────────────────────────────────
  app.post("/:id/reply", async (c) => {
    const threadId = c.req.param("threadId") as string;
    await requireThread(c, threadService, threadId);

    const existing = await messageService.findById(c.req.param("id") as string);
    if (!existing || existing.threadId !== threadId)
      throw new NotFoundError("message not found");
    if (existing.role !== "user")
      throw new BadRequestError("can only reply to user messages");
    if (existing.repliedAt !== null)
      throw new ConflictError("message already has a reply");

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // empty body → validation below catches missing body
    }

    const replyBody = typeof body.body === "string" ? body.body : undefined;
    if (replyBody === undefined) throw new BadRequestError("body is required");

    const result = await messageService.reply(c.req.param("id") as string, {
      body: replyBody,
      tokens:
        body.tokens !== undefined ? (body.tokens as JsonValue) : undefined,
      costUsd: typeof body.costUsd === "number" ? body.costUsd : undefined,
    });
    if (!result) throw new NotFoundError("message not found");
    return c.json(result, 201);
  });

  return app;
}

async function requireThread(
  c: { get(key: "agentId"): string | null },
  threadService: ThreadServiceLike,
  threadId: string,
): Promise<void> {
  const thread = await threadService.findById(threadId);
  if (!thread) throw new NotFoundError("thread not found");
  const callerAgentId = c.get("agentId");
  if (callerAgentId !== null && callerAgentId !== thread.agentId) {
    throw new ForbiddenError("agent token may not access this thread");
  }
}
