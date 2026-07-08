/**
 * chat/src/openapi-schemas.ts
 * Zod schemas for the chat API — ChatToken, Thread, Message, and ThreadStats
 * response shapes. Mirrors task-store/src/openapi-schemas.ts pattern: Zod
 * schemas with OpenAPI metadata.
 *
 * Import z from "@hono/zod-openapi" so .openapi() metadata is available.
 */

import { z } from "@hono/zod-openapi";

// ─── Common ───────────────────────────────────────────────────────────────────

export const ErrorSchema = z
  .object({
    error: z.string().openapi({ example: "not found" }),
  })
  .openapi("Error");

export type ErrorResponse = z.infer<typeof ErrorSchema>;

// ─── Chat Token ───────────────────────────────────────────────────────────────

/**
 * Token metadata returned from list/create (never the hash).
 * The `token` field (the SHA-256 hash) is NEVER exposed via the API.
 */
export const ChatTokenSchema = z
  .object({
    id: z.string().openapi({ example: "clxtoken123456" }),
    label: z.string().nullable().optional().openapi({ example: "ci-runner" }),
    agentId: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "agent-id-123" }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    revokedAt: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .openapi({ example: null }),
  })
  .openapi("ChatToken");

export type ChatToken = z.infer<typeof ChatTokenSchema>;

// ─── Thread ───────────────────────────────────────────────────────────────────

export const ThreadSchema = z
  .object({
    id: z.string().openapi({ example: "clxthread123456" }),
    agentId: z.string().openapi({ example: "agent-id-123" }),
    memberId: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "member-id-123" }),
    title: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "Deployment question" }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    updatedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-06T12:00:00.000Z" }),
  })
  .openapi("Thread");

export type Thread = z.infer<typeof ThreadSchema>;

// ─── Message ──────────────────────────────────────────────────────────────────

/**
 * A single message within a thread. `attachmentBytes` (the raw bytea column)
 * is deliberately omitted — mirrors how TaskTokenSchema omits the raw token
 * hash — this is API-facing metadata, not the binary payload itself.
 */
export const MessageSchema = z
  .object({
    id: z.string().openapi({ example: "clxmessage123456" }),
    threadId: z.string().openapi({ example: "clxthread123456" }),
    role: z.enum(["user", "assistant"]).openapi({ example: "user" }),
    body: z.string().openapi({ example: "How do I deploy this?" }),
    tokens: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .openapi({ example: { input_tokens: 10, output_tokens: 20 } }),
    costUsd: z.number().nullable().optional().openapi({ example: 0.02 }),
    attachmentFilename: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "screenshot.png" }),
    attachmentSize: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 1024 }),
    claimed: z.boolean().default(false).openapi({ example: false }),
    claimedAt: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .openapi({ example: null }),
    claimedBy: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "agent-id-123" }),
    repliedAt: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .openapi({ example: null }),
    errorKind: z.string().nullable().optional().openapi({ example: null }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
  })
  .openapi("Message");

export type Message = z.infer<typeof MessageSchema>;

// ─── Thread Stats ─────────────────────────────────────────────────────────────

export const ThreadStatsSchema = z
  .object({
    messageCount: z.number().int().openapi({ example: 5 }),
    totalInputTokens: z.number().int().openapi({ example: 100 }),
    totalOutputTokens: z.number().int().openapi({ example: 200 }),
    totalCostUsd: z.number().openapi({ example: 0.05 }),
  })
  .openapi("ThreadStats");

export type ThreadStats = z.infer<typeof ThreadStatsSchema>;
