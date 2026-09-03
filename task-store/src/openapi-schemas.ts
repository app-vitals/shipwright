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
    skipCount: z.number().int().default(0).openapi({
      example: 0,
      description:
        "Consecutive skip count. Auto-blocks (hitl+blockedReason) once it crosses the threshold (3).",
    }),
    lastSkippedAt: z
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

// ─── PR Finding ───────────────────────────────────────────────────────────────
// Defined ahead of PullRequestSchema so PullRequestSchema's `findings` field
// can reference it directly (no z.lazy — there's no circular reference here,
// and zod-to-openapi can't introspect a z.lazy() wrapper without an explicit
// `type` annotation via .openapi()).

export const PrFindingSchema = z
  .object({
    id: z.string().openapi({ example: "clxfinding123456" }),
    prRecordId: z.string().openapi({ example: "clx0987654321" }),
    ref: z.string().openapi({ example: "src/foo.ts:42" }),
    disposition: z
      .enum(["resolved", "superseded", "rejected"])
      .openapi({ example: "resolved" }),
    source: z.enum(["review", "patch"]).openapi({ example: "review" }),
    evidence: z.string().openapi({
      example: "Fixed the null check in the follow-up commit.",
    }),
    at: z.string().openapi({ example: "2026-08-17T12:00:00.000Z" }),
    agentId: z.string().nullable().openapi({
      example: "agent-abc123",
      description: "Agent instance that triaged this finding, if any.",
    }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-08-17T12:00:00.000Z" }),
  })
  .openapi("PrFinding");

export type PrFinding = z.infer<typeof PrFindingSchema>;

// Defined ahead of PullRequestSchema so PullRequestSchema's `events` field can
// reference it directly, mirroring the PrFindingSchema pattern above.

export const PullRequestEventSchema = z
  .object({
    id: z.string().openapi({ example: "clxevent123456" }),
    prRecordId: z.string().openapi({ example: "clx0987654321" }),
    field: z.string().openapi({ example: "reviewState" }),
    oldValue: z.string().nullable().openapi({ example: "pending" }),
    newValue: z.string().nullable().openapi({ example: "in_progress" }),
    actor: z.string().nullable().openapi({ example: "agent-abc123" }),
    method: z.string().openapi({ example: "claim" }),
    at: z.string().openapi({ example: "2026-08-17T12:00:00.000Z" }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-08-17T12:00:00.000Z" }),
  })
  .openapi("PullRequestEvent");

export type PullRequestEvent = z.infer<typeof PullRequestEventSchema>;

export const TaskEventSchema = z
  .object({
    id: z.string().openapi({ example: "clxevent123456" }),
    taskId: z.string().openapi({ example: "clx0987654321" }),
    field: z.string().openapi({ example: "status" }),
    oldValue: z.string().nullable().openapi({ example: "pending" }),
    newValue: z.string().nullable().openapi({ example: "in_progress" }),
    actor: z.string().nullable().openapi({ example: "agent-abc123" }),
    method: z.string().openapi({ example: "claim" }),
    at: z.string().openapi({ example: "2026-08-17T12:00:00.000Z" }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-08-17T12:00:00.000Z" }),
  })
  .openapi("TaskEvent");

export type TaskEvent = z.infer<typeof TaskEventSchema>;

// ─── Pull Request ─────────────────────────────────────────────────────────────

export const PullRequestSchema = z
  .object({
    id: z.string().openapi({ example: "clx0987654321" }),
    repo: z.string().openapi({ example: "org/repo" }),
    prNumber: z.number().int().openapi({ example: 42 }),
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
    reviewedCommitSha: z.string().nullable().optional().openapi({
      example: "abc123def456",
      description:
        "The review pipeline's exclusive commit-tracking field, separate from the shared commitSha field written by claim()/patch()/deploy for their own multi-phase bookkeeping.",
    }),
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
    prCreatedAt: z.string().nullable().optional().openapi({
      example: "2026-01-01T00:00:00.000Z",
      description:
        "ISO timestamp of the GitHub PR's actual creation time. Set once via POST /prs/claim (first claim only); read-only thereafter.",
    }),
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
    blocked: z.boolean().default(false).openapi({ example: false }),
    blockedReason: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "no linked task" }),
    skipCount: z.number().int().default(0).openapi({
      example: 0,
      description:
        "Consecutive skip count. Auto-blocks (blocked+blockedReason) once it crosses the threshold (3). POST /prs/:id/skip/reset resets this to 0 and, only when blockedReason matches the skip-auto-block message pattern (contains 'consecutive skips'), also clears blocked/blockedReason — a block set by a different mechanism (e.g. the CI-failure-streak auto-block) is left untouched.",
    }),
    lastSkippedAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-02T00:00:00.000Z" }),
    lastCiFailureSignature: z.string().nullable().optional().openapi({
      example: "npm-test-failed-foo.unit.test.ts",
      description:
        "Signature of the most recent CI failure reported via POST /prs/:id/patch's ciFailureSignature field. Used to detect consecutive patch cycles hitting the same CI failure.",
    }),
    consecutiveCiFailureCount: z.number().int().default(0).openapi({
      example: 0,
      description:
        "Count of consecutive patch() calls whose ciFailureSignature matched lastCiFailureSignature. Auto-blocks (blocked+blockedReason) once it crosses the threshold (3).",
    }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    updatedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-06T12:00:00.000Z" }),
    findings: z.array(PrFindingSchema).optional().openapi({
      description:
        "Review/patch findings recorded against this PR, if the caller's query included them (GET /prs/:id and list responses always include this array).",
    }),
    events: z.array(PullRequestEventSchema).optional().openapi({
      description:
        "Field-level state transition audit trail for this PR, if the caller's query included them (GET /prs/:id and list responses always include this array).",
    }),
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

// ─── Task route schemas ───────────────────────────────────────────────────────

/** Path param for routes with /:id */
export const TaskIdParamSchema = z.object({
  id: z.string().openapi({ example: "clx1234567890" }),
});

/** Query params for GET /tasks */
export const TaskListQuerySchema = z.object({
  status: z.string().optional().openapi({ example: "pending" }),
  state: z
    .enum(["open", "closed", "in_progress", "ready", "blocked"])
    .optional()
    .openapi({ example: "open" }),
  source: z.string().optional().openapi({ example: "entropy-fix" }),
  session: z.string().optional().openapi({ example: "session-123" }),
  repo: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .openapi({
      example: "org/repo",
      description:
        "Filter by repo (`org/repo` format). Repeatable — pass `?repo=` multiple times to match any repo in the list (e.g. `?repo=org/a&repo=org/b`). A single `?repo=` behaves identically to before (exact match).",
    }),
  org: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .openapi({
      example: "org",
      description:
        "Filter by org — matches any repo whose `org/repo` string starts with `<org>/`. Repeatable — pass `?org=` multiple times to match any of several orgs. Combines with `repo` as an AND filter.",
    }),
  assignee: z.string().optional().openapi({ example: "user@example.com" }),
  claimedBy: z.string().optional().openapi({ example: "agent-id-123" }),
  branch: z.string().optional().openapi({ example: "feat/feature-x" }),
  pr: z.string().optional().openapi({ example: "42" }),
  limit: z.string().optional().openapi({ example: "50" }),
  offset: z.string().optional().openapi({ example: "0" }),
  ready: z.enum(["true", "false"]).optional().openapi({ example: "true" }),
  hitl: z.enum(["true", "false"]).optional().openapi({ example: "true" }),
  sort: z.enum(["asc", "desc"]).optional().openapi({ example: "asc" }),
  updatedSince: z.string().optional().openapi({
    example: "2026-01-01T00:00:00.000Z",
    description:
      "Only return tasks with updatedAt >= this ISO timestamp. A conservative pre-filter, not a precise sync anchor.",
  }),
});

/** Response for GET /tasks */
export const TaskListResponseSchema = z
  .object({
    tasks: z.array(TaskSchema),
    total: z.number().int().openapi({ example: 10 }),
    scopeDegraded: z.boolean().openapi({
      example: false,
      description:
        "True only when the agent token's repo-scope resolver call itself failed upstream (network error, timeout, non-2xx, malformed JSON) — distinct from a legitimate empty repo scope. Always false for admin tokens.",
    }),
  })
  .openapi("TaskListResponse");

/** Request body for POST /tasks.
 * Required fields (title, status, repo) are validated by the handler rather
 * than by Zod so custom error messages are returned instead of ZodError objects.
 * All fields are optional here; the handler enforces presence at runtime.
 */
export const CreateTaskBodySchema = z
  .object({
    title: z
      .string()
      .min(1)
      .optional()
      .openapi({ example: "Implement feature X" }),
    status: z.string().min(1).optional().openapi({ example: "pending" }),
    repo: z.string().nullable().optional().openapi({ example: "org/repo" }),
    session: z.string().optional().openapi({ example: "session-123" }),
    description: z.string().optional().openapi({ example: "Task description" }),
    layer: z.string().optional().openapi({ example: "service" }),
    branch: z.string().optional().openapi({ example: "feat/feature-x" }),
    dependencies: z.array(z.string()).optional().openapi({ example: [] }),
    acceptanceCriteria: z.array(z.string()).optional().openapi({ example: [] }),
    assignee: z.string().optional().openapi({ example: "user@example.com" }),
    priority: z.string().optional().openapi({ example: "high" }),
    type: z.string().optional().openapi({ example: "feature" }),
    source: z.string().optional().openapi({ example: "manual" }),
  })
  .passthrough()
  .openapi("CreateTaskBody");

/** Request body for PATCH /tasks/:id */
export const UpdateTaskBodySchema = z
  .record(z.string(), z.unknown())
  .openapi("UpdateTaskBody");

/** Single item in a bulk insert array.
 * Required fields (title, status, repo) are optional here so the handler can
 * return custom error messages rather than raw ZodError objects.
 */
const BulkInsertItemSchema = z
  .object({
    title: z
      .string()
      .min(1)
      .optional()
      .openapi({ example: "Implement feature X" }),
    status: z.string().min(1).optional().openapi({ example: "pending" }),
    repo: z.string().nullable().optional().openapi({ example: "org/repo" }),
  })
  .passthrough();

/** Request body for POST /tasks/bulk */
export const BulkInsertBodySchema = z
  .array(BulkInsertItemSchema)
  .openapi("BulkInsertBody");

/** Response for POST /tasks/bulk */
export const BulkInsertResponseSchema = z
  .object({
    inserted: z.number().int().openapi({ example: 3 }),
    updated: z.number().int().openapi({ example: 1 }),
    skipped: z.array(z.string()).openapi({
      example: ["entropy-dead_exports-other-repo-2026-W29"],
      description:
        "IDs of tasks skipped because they already exist (Prisma P2002 unique constraint collision).",
    }),
  })
  .openapi("BulkInsertResponse");

/** Response for GET /tasks/distinct */
export const DistinctResponseSchema = z
  .object({
    sessions: z.array(z.string()).openapi({ example: ["session-1"] }),
    repos: z.array(z.string()).openapi({ example: ["org/repo"] }),
    orgs: z.array(z.string()).openapi({ example: ["org"] }),
  })
  .openapi("DistinctResponse");

/** Request body for POST /tasks/:id/claim (admin tokens supply claimedBy) */
export const ClaimBodySchema = z
  .object({
    claimedBy: z.string().optional().openapi({ example: "agent-id-123" }),
  })
  .openapi("ClaimBody");

/** Request body for POST /tasks/:id/fail */
export const FailBodySchema = z
  .object({
    reason: z.string().optional().openapi({ example: "build failed" }),
  })
  .openapi("FailBody");

// ─── PR Route Schemas ─────────────────────────────────────────────────────────

export const PrIdParamSchema = z
  .object({
    id: z.string().openapi({ example: "clx0987654321" }),
  })
  .openapi("PrIdParam");

export const PrListQuerySchema = z
  .object({
    repo: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .openapi({
        example: "org/repo",
        description:
          "Filter by repo. Repeatable (?repo=a&repo=b) to match any of several repos.",
      }),
    org: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .openapi({
        example: "org",
        description:
          "Filter by org — matches repos whose 'org/repo' starts with '<org>/'. Repeatable (?org=a&org=b) to match any of several orgs. Composable with repo (AND).",
      }),
    prNumber: z
      .string()
      .optional()
      .openapi({ example: "42", description: "PR number (parsed as integer)" }),
    state: z
      .enum(["open", "merged", "closed"])
      .optional()
      .openapi({ example: "open" }),
    reviewState: z
      .enum(["pending", "in_progress", "posted", "approved"])
      .optional()
      .openapi({ example: "pending" }),
    staged: z
      .enum(["true", "false"])
      .optional()
      .openapi({ example: "false", description: "Filter by staged flag" }),
    limit: z
      .string()
      .optional()
      .openapi({ example: "50", description: "Max records to return" }),
    offset: z
      .string()
      .optional()
      .openapi({ example: "0", description: "Pagination offset" }),
    ready: z.enum(["true", "false"]).optional().openapi({
      example: "true",
      description:
        "When true, return only unclaimed PRs (claimedBy IS NULL) — mirrors /tasks?ready=true. Composable with other filters (repo, state, reviewState); does not itself apply state/reviewState eligibility rules the way claim-next does.",
    }),
    blocked: z.enum(["true", "false"]).optional().openapi({
      example: "true",
      description:
        "When true, return only PRs considered blocked: pr.blocked===true OR (linked task exists AND task.status==='blocked'). Task.hitl is not consulted — post-redesign, Type A tasks (the only ones that keep hitl:true) never have a linked PR. Composable with other filters (e.g. state=open).",
    }),
    sort: z.enum(["asc", "desc"]).optional().openapi({
      example: "asc",
      description:
        "Order results by createdAt. Default is ascending (asc), preserving current behavior for existing callers. Unrelated to claim-next's own deterministic ordering.",
    }),
    updatedSince: z.string().optional().openapi({
      example: "2026-01-01T00:00:00.000Z",
      description:
        "Only return PRs with updatedAt >= this ISO timestamp. A conservative pre-filter, not a precise sync anchor.",
    }),
  })
  .openapi("PrListQuery");

export const PrListResponseSchema = z
  .object({
    prs: z
      .array(PullRequestSchema)
      .openapi({ description: "Array of pull requests" }),
    total: z.number().int().openapi({ example: 1 }),
    limit: z.number().int().openapi({ example: 50 }),
    offset: z.number().int().openapi({ example: 0 }),
  })
  .openapi("PrListResponse");

/** Query params for GET /prs/:id/events */
export const PrEventsQuerySchema = z
  .object({
    limit: z
      .string()
      .optional()
      .openapi({ example: "50", description: "Max records to return" }),
    offset: z
      .string()
      .optional()
      .openapi({ example: "0", description: "Pagination offset" }),
  })
  .openapi("PrEventsQuery");

/** Response for GET /prs/:id/events */
export const PrEventsResponseSchema = z
  .object({
    events: z.array(PullRequestEventSchema).openapi({
      description:
        "This PR's PullRequestEvent audit trail, ordered by `at` ascending (oldest first).",
    }),
    total: z.number().int().openapi({ example: 1 }),
    limit: z.number().int().openapi({ example: 50 }),
    offset: z.number().int().openapi({ example: 0 }),
  })
  .openapi("PrEventsResponse");

/** Query params for GET /tasks/:id/events */
export const TaskEventsQuerySchema = z
  .object({
    limit: z
      .string()
      .optional()
      .openapi({ example: "50", description: "Max records to return" }),
    offset: z
      .string()
      .optional()
      .openapi({ example: "0", description: "Pagination offset" }),
  })
  .openapi("TaskEventsQuery");

/** Response for GET /tasks/:id/events */
export const TaskEventsResponseSchema = z
  .object({
    events: z.array(TaskEventSchema).openapi({
      description:
        "This task's TaskEvent audit trail, ordered by `at` ascending (oldest first).",
    }),
    total: z.number().int().openapi({ example: 1 }),
    limit: z.number().int().openapi({ example: 50 }),
    offset: z.number().int().openapi({ example: 0 }),
  })
  .openapi("TaskEventsResponse");

export const ClaimPrBodySchema = z
  .object({
    repo: z.string().openapi({
      example: "org/repo",
      description: "Repository in org/repo format",
    }),
    prNumber: z
      .number()
      .int()
      .openapi({ example: 42, description: "Pull request number" }),
    commitSha: z.string().openapi({
      example: "abc123def456",
      description: "Commit SHA to associate",
    }),
    claimedBy: z.string().optional().openapi({
      example: "agent-id-123",
      description: "Agent claiming this PR (admin tokens only)",
    }),
    phase: z.enum(["review", "patch", "deploy"]).optional().openapi({
      example: "patch",
      description:
        "Pipeline phase this claim is for (defaults to 'review' when omitted)",
    }),
    prCreatedAt: z.string().optional().openapi({
      example: "2026-01-01T00:00:00.000Z",
      description:
        "ISO timestamp of the GitHub PR's actual creation time. Only applied on first claim (record creation); ignored on subsequent claims since the field is immutable once set.",
    }),
  })
  .openapi("ClaimPrBody");

export const ClaimNextBodySchema = z
  .object({
    agentId: z.string().optional().openapi({
      example: "agent-id-123",
      description:
        "Agent ID (admin tokens only; agent tokens use token identity)",
    }),
    maxConcurrent: z
      .number()
      .int()
      .optional()
      .openapi({ example: 1, description: "Maximum concurrent PRs to claim" }),
  })
  .openapi("ClaimNextBody");

export const UpdatePrBodySchema = z
  .record(z.string(), z.unknown())
  .openapi("UpdatePrBody");

export const PatchPrBodySchema = z
  .object({
    commitSha: z.string().optional().openapi({
      example: "abc123def456",
      description:
        "Current head commit SHA. When provided and it differs from the record's stored commitSha, reviewState resets to pending and commitSha is updated. When it matches, reviewState is left untouched (no-op patch cycle). When omitted, reviewState unconditionally resets to pending (legacy behavior).",
    }),
    ciFailureSignature: z.string().optional().openapi({
      example: "npm-test-failed-foo.unit.test.ts",
      description:
        "Signature identifying the current CI failure (e.g. which check + which test). When it matches the record's stored lastCiFailureSignature, consecutiveCiFailureCount increments; when it differs (or none is stored), the count resets to 1 and the new signature is stored. Crossing CI_FAILURE_BLOCK_THRESHOLD (3) auto-sets blocked:true plus a descriptive blockedReason. When omitted (e.g. merge-conflict/review-fix patch calls unrelated to CI), both fields are left untouched.",
    }),
  })
  .openapi("PatchPrBody");

export const ClaimNextResponseSchema = z
  .object({
    pr: PullRequestSchema,
    phase: z.enum(["review", "patch", "deploy"]).openapi({ example: "review" }),
  })
  .openapi("ClaimNextResponse");

/** Request body for POST /prs/:id/findings. */
export const CreateFindingBodySchema = z
  .object({
    ref: z.string().openapi({
      example: "src/foo.ts:42",
      description: "Identifier for the finding (e.g. file:line or a slug).",
    }),
    disposition: z.enum(["resolved", "superseded", "rejected"]).openapi({
      example: "resolved",
      description:
        "Triage outcome. source:'patch' may only submit 'rejected' — server-enforced (400 otherwise); source:'review' may submit any value.",
    }),
    source: z.enum(["review", "patch"]).openapi({
      example: "review",
      description: "Which pipeline phase is recording this finding.",
    }),
    evidence: z.string().openapi({
      example: "Fixed the null check in the follow-up commit.",
    }),
    at: z.string().optional().openapi({
      example: "2026-08-17T12:00:00.000Z",
      description:
        "ISO timestamp of when the finding was triaged. Defaults to the current time when omitted.",
    }),
    agentId: z.string().optional().openapi({
      example: "agent-abc123",
      description: "Agent instance that triaged this finding.",
    }),
  })
  .openapi("CreateFindingBody");
