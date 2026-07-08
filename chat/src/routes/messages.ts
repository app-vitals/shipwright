/**
 * chat/src/routes/messages.ts
 * Message CRUD + queue API routes.
 *
 * Routes:
 *   GET    /                  list messages in thread
 *   POST   /                  create message
 *   POST   /claim             claim next unclaimed user message (queue API)
 *   GET    /:id/attachment    stream (and clear) an ephemeral attachment
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
 *
 * Schemas passed to createRoute() are for OpenAPI documentation only — handlers
 * keep their existing manual body-parsing/validation logic (not c.req.valid())
 * so that error messages and status codes stay byte-for-byte identical to the
 * pre-conversion plain-Hono implementation.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ChatAuthEnv } from "../auth.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
} from "../errors.ts";
import type { JsonValue, MessageServiceLike } from "../message-service.ts";
import { ErrorSchema, MessageSchema } from "../openapi-schemas.ts";
import type { ThreadServiceLike } from "../thread-service.ts";
import { parseIntParam } from "./utils.ts";

/** Maximum allowed size for message attachment bytes (10 MB). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// ─── Route-local schemas ──────────────────────────────────────────────────────

/** Path param for routes with /:id */
const MessageIdParamSchema = z.object({
  id: z.string().openapi({ example: "clxmessage123456" }),
});

/** Query params for GET / (list) */
const MessageListQuerySchema = z.object({
  limit: z.string().optional().openapi({ example: "50" }),
  offset: z.string().optional().openapi({ example: "0" }),
});

/** Response for GET / (list) */
const MessageListResponseSchema = z
  .object({
    messages: z.array(MessageSchema),
    total: z.number().int().openapi({ example: 10 }),
    limit: z.number().int().openapi({ example: 50 }),
    offset: z.number().int().openapi({ example: 0 }),
  })
  .openapi("MessageListResponse");

/** Request body for POST / (create).
 * Required fields (role, body) are validated by the handler rather than by
 * Zod so custom error messages are returned instead of ZodError objects.
 */
const CreateMessageBodySchema = z
  .object({
    role: z.enum(["user", "assistant"]).optional().openapi({ example: "user" }),
    body: z.string().optional().openapi({ example: "How do I deploy this?" }),
    tokens: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({ example: { input_tokens: 10, output_tokens: 20 } }),
    costUsd: z.number().optional().openapi({ example: 0.02 }),
    attachmentFilename: z
      .string()
      .optional()
      .openapi({ example: "screenshot.png" }),
    attachmentSize: z.number().int().optional().openapi({ example: 1024 }),
    attachmentBytes: z
      .string()
      .optional()
      .openapi({ example: "base64-encoded-bytes" }),
  })
  .openapi("CreateMessageBody");

/** Request body for PATCH /:id. All fields optional; handler applies partial updates. */
const UpdateMessageBodySchema = z
  .object({
    body: z.string().optional().openapi({ example: "Updated text" }),
    tokens: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .openapi({ example: { input_tokens: 10, output_tokens: 20 } }),
    costUsd: z.number().nullable().optional().openapi({ example: 0.03 }),
    errorKind: z.string().nullable().optional().openapi({ example: null }),
  })
  .openapi("UpdateMessageBody");

/** Request body for POST /:id/reply.
 * `body` is required at runtime by the handler (custom error message), but
 * kept optional here per the permissive-schema/manual-validation convention.
 */
const ReplyBodySchema = z
  .object({
    body: z.string().optional().openapi({ example: "Sure, here is the answer." }),
    tokens: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({ example: { input_tokens: 10, output_tokens: 20 } }),
    costUsd: z.number().optional().openapi({ example: 0.02 }),
  })
  .openapi("ReplyBody");

/** Response for POST /:id/reply */
const ReplyResponseSchema = z
  .object({
    userMessage: MessageSchema,
    assistantMessage: MessageSchema,
  })
  .openapi("ReplyResponse");

// ─── Route definitions ────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["messages"],
  summary: "List messages in a thread",
  request: {
    query: MessageListQuerySchema,
  },
  responses: {
    200: {
      description: "List of messages with pagination info",
      content: { "application/json": { schema: MessageListResponseSchema } },
    },
    404: {
      description: "Thread not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const createMessageRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["messages"],
  summary: "Create a message",
  request: {
    body: {
      content: { "application/json": { schema: CreateMessageBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Created message",
      content: { "application/json": { schema: MessageSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Thread not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    413: {
      description: "Attachment exceeds size limit",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const claimRoute = createRoute({
  method: "post",
  path: "/claim",
  tags: ["messages"],
  summary: "Claim the next unclaimed user message in a thread",
  responses: {
    200: {
      description: "Claimed message",
      content: { "application/json": { schema: MessageSchema } },
    },
    404: {
      description: "Thread not found, or no unclaimed messages in thread",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getAttachmentRoute = createRoute({
  method: "get",
  path: "/:id/attachment",
  tags: ["messages"],
  summary: "Stream a message's attachment (ephemeral — cleared after read)",
  request: {
    params: MessageIdParamSchema,
  },
  responses: {
    200: {
      description: "Attachment bytes",
      content: {
        "application/octet-stream": {
          schema: z.string().openapi({ format: "binary" }),
        },
      },
    },
    404: {
      description: "Thread not found, message not found, or no attachment",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getOneRoute = createRoute({
  method: "get",
  path: "/:id",
  tags: ["messages"],
  summary: "Get a message by ID",
  request: {
    params: MessageIdParamSchema,
  },
  responses: {
    200: {
      description: "Message",
      content: { "application/json": { schema: MessageSchema } },
    },
    404: {
      description: "Thread or message not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/:id",
  tags: ["messages"],
  summary: "Update a message",
  request: {
    params: MessageIdParamSchema,
    body: {
      content: { "application/json": { schema: UpdateMessageBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Updated message",
      content: { "application/json": { schema: MessageSchema } },
    },
    404: {
      description: "Thread or message not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/:id",
  tags: ["messages"],
  summary: "Delete a message",
  request: {
    params: MessageIdParamSchema,
  },
  responses: {
    200: {
      description: "Deleted message",
      content: { "application/json": { schema: MessageSchema } },
    },
    404: {
      description: "Thread or message not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const replyRoute = createRoute({
  method: "post",
  path: "/:id/reply",
  tags: ["messages"],
  summary: "Post an agent reply to a user message",
  request: {
    params: MessageIdParamSchema,
    body: {
      content: { "application/json": { schema: ReplyBodySchema } },
    },
  },
  responses: {
    201: {
      description: "User message and the newly created assistant reply",
      content: { "application/json": { schema: ReplyResponseSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Thread or message not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Message already has a reply",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createMessagesRoutes(
  threadService: ThreadServiceLike,
  messageService: MessageServiceLike,
): OpenAPIHono<ChatAuthEnv> {
  const app = new OpenAPIHono<ChatAuthEnv>();

  // ─── List ──────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(listRoute, async (c): Promise<any> => {
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
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(createMessageRoute, async (c): Promise<any> => {
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
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(claimRoute, async (c): Promise<any> => {
    const threadId = c.req.param("threadId") as string;
    await requireThread(c, threadService, threadId);

    const callerAgentId = c.get("agentId");
    const claimedBy = callerAgentId ?? "admin";

    const claimed = await messageService.claim(threadId, claimedBy);
    if (!claimed) throw new NotFoundError("no unclaimed messages in thread");
    return c.json(claimed, 200);
  });

  // ─── Get attachment (ephemeral) ──────────────────────────────────────────────
  // Registered before /:id so "/:id/attachment" matches. Streams the stored
  // bytes once, then drops them — content is not retained after the agent pulls
  // it into its workspace. Registered via createRoute()/app.openapi(); the
  // handler still returns a raw Response, which app.openapi() passes through
  // unchanged (validated only against the documented schema, not enforced).
  app.openapi(getAttachmentRoute, async (c) => {
    const threadId = c.req.param("threadId") as string;
    await requireThread(c, threadService, threadId);

    const message = await messageService.findById(c.req.param("id"));
    if (!message || message.threadId !== threadId)
      throw new NotFoundError("message not found");

    if (message.attachmentBytes === null) {
      throw new NotFoundError("no attachment");
    }

    const bytes = message.attachmentBytes;
    const filename = message.attachmentFilename ?? "attachment";

    // Drop the bytes now that they've been served (ephemeral retention).
    await messageService.clearAttachmentBytes(message.id);

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      },
    });
  });

  // ─── Get ───────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(getOneRoute, async (c): Promise<any> => {
    const threadId = c.req.param("threadId") as string;
    await requireThread(c, threadService, threadId);

    const message = await messageService.findById(c.req.param("id"));
    if (!message || message.threadId !== threadId)
      throw new NotFoundError("message not found");
    return c.json(message, 200);
  });

  // ─── Update ────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(updateRoute, async (c): Promise<any> => {
    const threadId = c.req.param("threadId") as string;
    await requireThread(c, threadService, threadId);

    const existing = await messageService.findById(c.req.param("id"));
    if (!existing || existing.threadId !== threadId)
      throw new NotFoundError("message not found");

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // empty body → no-op
    }

    const updated = await messageService.update(c.req.param("id"), {
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
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(deleteRoute, async (c): Promise<any> => {
    const threadId = c.req.param("threadId") as string;
    await requireThread(c, threadService, threadId);

    const existing = await messageService.findById(c.req.param("id"));
    if (!existing || existing.threadId !== threadId)
      throw new NotFoundError("message not found");

    const deleted = await messageService.delete(c.req.param("id"));
    if (!deleted) throw new NotFoundError("message not found");
    return c.json(deleted, 200);
  });

  // ─── Reply (queue API) ─────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(replyRoute, async (c): Promise<any> => {
    const threadId = c.req.param("threadId") as string;
    await requireThread(c, threadService, threadId);

    const existing = await messageService.findById(c.req.param("id"));
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

    const result = await messageService.reply(c.req.param("id"), {
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
