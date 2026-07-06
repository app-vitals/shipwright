/**
 * task-store/src/openapi-schemas.ts
 * Zod schemas for the task-store API — Task, PullRequest, and TaskToken response shapes.
 * Mirrors admin/src/openapi-schemas.ts pattern: Zod schemas with OpenAPI metadata.
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

export const OkSchema = z
  .object({
    ok: z.literal(true),
  })
  .openapi("Ok");

export type OkResponse = z.infer<typeof OkSchema>;

// ─── Task ─────────────────────────────────────────────────────────────────────

export const TaskSchema = z
  .object({
    id: z.string().openapi({ example: "clx1234567890" }),
    title: z.string().openapi({ example: "Implement feature X" }),
    status: z
      .enum([
        "pending",
        "in_progress",
        "pr_open",
        "approved",
        "merged",
        "done",
        "deploying",
        "deployed",
        "blocked",
        "cancelled",
      ])
      .openapi({ example: "pending" }),
    source: z.string().nullable().optional().openapi({ example: "manual" }),
    session: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "session-123" }),
    repo: z.string().nullable().optional().openapi({ example: "org/repo" }),
    description: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "Task description" }),
    acceptanceCriteria: z
      .array(z.string())
      .optional()
      .openapi({ example: ["Criterion 1", "Criterion 2"] }),
    layer: z.string().nullable().optional().openapi({ example: "feature" }),
    branch: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "feat/feature-x" }),
    dependencies: z
      .array(z.string())
      .optional()
      .openapi({ example: ["task-1", "task-2"] }),
    pr: z.number().int().nullable().optional().openapi({ example: 42 }),
    hours: z.number().nullable().optional().openapi({ example: 5.5 }),
    addedAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    startedAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-02T00:00:00.000Z" }),
    prCreatedAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-03T00:00:00.000Z" }),
    mergedAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-04T00:00:00.000Z" }),
    blockedAt: z.string().nullable().optional().openapi({ example: null }),
    blockedReason: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "Waiting on dependency" }),
    note: z.string().nullable().optional().openapi({ example: "Some notes" }),
    type: z.string().nullable().optional().openapi({ example: "feature" }),
    priority: z.string().nullable().optional().openapi({ example: "high" }),
    cancelledAt: z.string().nullable().optional().openapi({ example: null }),
    completedAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-05T00:00:00.000Z" }),
    deployingAt: z.string().nullable().optional().openapi({ example: null }),
    deployedAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-06T00:00:00.000Z" }),
    ciFixAttempts: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 2 }),
    mergeCommit: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "abc123def456" }),
    prUrl: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "https://github.com/org/repo/pull/42" }),
    assignee: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "user@example.com" }),
    issue: z.string().nullable().optional().openapi({ example: "GH-123" }),
    model: z.string().nullable().optional().openapi({ example: "sonnet" }),
    complexity: z.number().int().nullable().optional().openapi({ example: 7 }),
    hitl: z.boolean().nullable().optional().openapi({ example: true }),
    hitlNotifiedAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-02T00:00:00.000Z" }),
    claimedBy: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "agent-id-123" }),
    agentHint: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "prefer-sonnet" }),
    claimedAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-02T00:00:00.000Z" }),
    heartbeatAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-06T12:00:00.000Z" }),
    simplifyTotal: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 10 }),
    simplifyDry: z.number().int().nullable().optional().openapi({ example: 2 }),
    simplifyDeadCode: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 3 }),
    simplifyNaming: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 1 }),
    simplifyComplexity: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 2 }),
    simplifyConsistency: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 2 }),
    coverageDelta: z.number().nullable().optional().openapi({ example: 5.5 }),
    effortLevel: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "medium" }),
    inputTokens: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 1000 }),
    outputTokens: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 500 }),
    cacheReadTokens: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 100 }),
    cacheCreationTokens: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 50 }),
    costUsd: z.number().nullable().optional().openapi({ example: 0.02 }),
    metadata: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .openapi({ example: { customKey: "customValue" } }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    updatedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-06T12:00:00.000Z" }),
  })
  .openapi("Task");

export type Task = z.infer<typeof TaskSchema>;

// ─── Pull Request ─────────────────────────────────────────────────────────────

export const PullRequestSchema = z
  .object({
    id: z.string().openapi({ example: "clx0987654321" }),
    repo: z.string().openapi({ example: "org/repo" }),
    prNumber: z.number().int().openapi({ example: 42 }),
    taskId: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "clx1234567890" }),
    staged: z.boolean().default(false).openapi({ example: false }),
    state: z
      .enum(["open", "merged", "closed"])
      .default("open")
      .openapi({ example: "open" }),
    reviewState: z
      .enum(["pending", "in_progress", "posted", "approved"])
      .default("pending")
      .openapi({ example: "pending" }),
    commitSha: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "abc123def456" }),
    patchCycles: z.number().int().default(0).openapi({ example: 1 }),
    reviewCycles: z.number().int().default(0).openapi({ example: 0 }),
    agentId: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "agent-id-123" }),
    reviewedAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-03T00:00:00.000Z" }),
    patchedAt: z.string().nullable().optional().openapi({ example: null }),
    mergedAt: z.string().nullable().optional().openapi({ example: null }),
    claimedBy: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "agent-id-123" }),
    claimedAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-02T00:00:00.000Z" }),
    heartbeatAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-06T12:00:00.000Z" }),
    phase: z
      .enum(["review", "patch", "deploy"])
      .nullable()
      .optional()
      .openapi({ example: "review" }),
    readyForReviewAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-02T00:00:00.000Z" }),
    readyForPatchAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: null }),
    readyForDeployAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: null }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    updatedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-06T12:00:00.000Z" }),
  })
  .openapi("PullRequest");

export type PullRequest = z.infer<typeof PullRequestSchema>;

// ─── Task Token ───────────────────────────────────────────────────────────────

/**
 * Token metadata returned from list/create (never the hash).
 * The `token` field (the SHA-256 hash) is NEVER exposed via the API.
 */
export const TaskTokenSchema = z
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
  .openapi("TaskToken");

export type TaskToken = z.infer<typeof TaskTokenSchema>;
