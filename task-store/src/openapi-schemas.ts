/**
 * task-store/src/openapi-schemas.ts
 * Zod schemas for the task-store API — Task, PullRequest, and TaskToken response shapes.
 * Mirrors the platform admin's openapi-schemas.ts pattern: Zod schemas with OpenAPI metadata.
 *
 * Import z from "@hono/zod-openapi" so .openapi() metadata is available.
 */

import { z } from "@hono/zod-openapi";

import { ORIGIN_KINDS } from "./origin-kinds.ts";
import { MAX_CENSUS_ENTRIES } from "./pull-request-service.ts";
import { TASK_COLUMNS } from "./statuses.ts";
import {
  BY_PR_TARGET_STATUSES,
  MAX_BULK_TASKS,
  MAX_PATCH_BY_PR_NUMBERS,
  UNBLOCK_TARGETS,
} from "./task-service.ts";

/** PrOrigin enum values (POM-1.1), mirrored here rather than imported from
 * the generated Prisma client so this file stays a pure Zod-schema module. */
const PR_ORIGIN_VALUES = [
  "shipwright",
  "ci",
  "dependency_bot",
  "human",
  "unknown",
] as const;

/** PLU-2.5: the registered origin kinds, shared with the write validator. */
const OriginKindSchema = z.enum(ORIGIN_KINDS);

/** `?cursor=` query param shared by every cursor-paginated list route (TPG-1.2). */
const cursorQueryParam = (what: string) =>
  z
    .string()
    .optional()
    .openapi({
      description: `Opaque cursor from a previous response's \`nextCursor\`. Returns the next page of ${what}. Mutually exclusive with \`offset\` (400); a malformed cursor is a 400.`,
    });

/** `nextCursor` response field shared by every cursor-paginated list route (TPG-1.2). */
const nextCursorField = z.string().nullable().openapi({
  example: null,
  description:
    "Opaque cursor for the next page (pass as `?cursor=`); null on the last page.",
});
const ORIGIN_KIND_DESCRIPTION = `Typed origin of the task: one of ${ORIGIN_KINDS.join(", ")}. Writes and the \`?originKind=\` filter share this one list; any other value is 400.`;

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
        "deployed",
        "released",
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
    deployedAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-06T00:00:00.000Z" }),
    releasedAt: z.string().nullable().optional().openapi({ example: null }),
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
    owner: z.string().nullable().optional().openapi({
      example: "dev@example.com",
      description:
        "Requester's email (PLU-2.5). Null when unknown — never invented for scanner/cron tasks. Distinct from `assignee`/`claimedBy`, which identify agents.",
    }),
    planDocumentId: z.string().nullable().optional().openapi({
      example: "doc-plan-1",
      description: "Id of the plan document this task came from.",
    }),
    specDocumentId: z.string().nullable().optional().openapi({
      example: "doc-spec-1",
      description: "Id of the spec document this task implements.",
    }),
    originKind: OriginKindSchema.nullable().optional().openapi({
      example: "skill",
      description: ORIGIN_KIND_DESCRIPTION,
    }),
    originRef: z.string().nullable().optional().openapi({
      example: "plan-session",
      description:
        "Names the origin: a document id, skill name, cron name, etc.",
    }),
    kind: z.enum(["dev", "prd", "initiative", "idea"]).default("dev").openapi({
      example: "dev",
      description:
        "What the task is: `dev` (ordinary work item, the default) `prd` (a product spec awaiting an autonomous plan session), `initiative` (rough work item the team intends to do soon) or `idea` (unprioritized, hidden by default in the UI). Only `dev` tasks are ever part of the `?ready=true` set.",
    }),
    skipCount: z.number().int().default(0).openapi({
      example: 0,
      description:
        "Consecutive skip count for the current lastSkipReason streak. A skip whose reason differs from lastSkipReason resets this to 1 instead of incrementing. Auto-blocks (hitl+blockedReason) once it crosses the threshold (3).",
    }),
    lastSkippedAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-02T00:00:00.000Z" }),
    lastSkipReason: z.string().nullable().optional().openapi({
      example: "dev-task:deferred:unmet-hidden-requirement",
      description:
        'The skip reason associated with the current skipCount streak. POST /tasks/:id/skip\'s optional `reason` field (default `"unspecified"`) is compared against this value: a match increments skipCount, a difference (including from null) resets skipCount to 1 and stores the new reason here.',
    }),
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

const PullRequestEventSchema = z
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

const TaskEventSchema = z
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
        "The review pipeline's exclusive commit-tracking field, separate from the shared commitSha field written by claim()/patch()/merge for their own multi-phase bookkeeping.",
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
      .enum(["review", "patch", "merge"])
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
    readyForMergeAt: z
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
    origin: z.enum(PR_ORIGIN_VALUES).nullable().optional().openapi({
      example: "shipwright",
      description:
        "Where this PR record first learned about the PR — first-write-wins (see PullRequestService.stampOrigin()). Null means the row has never been stamped (POM-1.1's accepted gap: a PR that never passes through the pr_open transition, POST /prs/claim, or the census sweep has no origin at all).",
    }),
    authorLogin: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "octocat" }),
    headRef: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "feat/some-branch" }),
    title: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "Add the origin metrics dimension" }),
    commitCount: z.number().int().nullable().optional().openapi({
      example: 12,
      description:
        "Total commit count on this PR (CPP-1.1). Written unconditionally by POST /prs/census whenever supplied — mirrors authorLogin/headRef/title, not origin's first-write-wins semantic.",
    }),
    commitsDocsRefresh: z.number().int().nullable().optional().openapi({
      example: 1,
      description:
        "Commits attributed to the docs-refresher subagent (CPP-1.1).",
    }),
    commitsReviewPatch: z.number().int().nullable().optional().openapi({
      example: 3,
      description: "Commits attributed to the review/patch cycle (CPP-1.1).",
    }),
    commitsCiFix: z.number().int().nullable().optional().openapi({
      example: 2,
      description: "Commits attributed to CI-fix cycles (CPP-1.1).",
    }),
    commitsImplementation: z.number().int().nullable().optional().openapi({
      example: 6,
      description:
        "Commits attributed to the initial implementation (CPP-1.1).",
    }),
    skipCount: z.number().int().default(0).openapi({
      example: 0,
      description:
        "Consecutive skip count. Auto-blocks (blocked+blockedReason) once it crosses the threshold (3). POST /prs/:id/skip/reset resets this to 0 and, only when blockedReason matches the skip-auto-block message pattern (contains 'consecutive skips') or starts with the patch no-progress escalation prefix ('patch dispatch made no progress'), also clears blocked/blockedReason — a block set by a different mechanism (e.g. the CI-failure-streak auto-block) is left untouched.",
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
    blockedHeadSha: z.string().nullable().optional().openapi({
      description:
        "Head commit SHA at the moment this PR was blocked — set by recordSkip() on a skip auto-block (PSL-3.1) or written directly via PATCH /prs/:id by an escalation. Null until then.",
    }),
    blockedReviewId: z.string().nullable().optional().openapi({
      description:
        "Id of the latest review-source finding known when recordSkip() auto-blocked this PR (PSL-3.1). Null if none existed.",
    }),
    blockedAt: z.string().nullable().optional().openapi({
      description:
        "ISO timestamp of the most recent skip auto-block (PSL-3.1).",
    }),
    lastAutoBlockReason: z.string().nullable().optional().openapi({
      description:
        "blockedReason of the most recent skip auto-block; preserved across POST /prs/:id/skip/reset (PSL-3.1).",
    }),
    lastAutoBlockedAt: z.string().nullable().optional().openapi({
      description:
        "ISO timestamp of the most recent skip auto-block; preserved across POST /prs/:id/skip/reset (PSL-3.1).",
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

// ─── Session ──────────────────────────────────────────────────────────────────

// PlanDocument is declared here (ahead of its own section below) because
// SessionSchema embeds it.
const PLAN_DOCUMENT_KIND_VALUES = ["spec", "plan"] as const;
const PLAN_DOCUMENT_STATE_VALUES = [
  "draft",
  "pr_open",
  "merged",
  "abandoned",
] as const;

export const PlanDocumentSchema = z
  .object({
    id: z.string().openapi({ example: "clxdoc1234567890" }),
    accountId: z.string().openapi({ example: "default" }),
    session: z.string().openapi({ example: "shipwright-may-launch" }),
    kind: z.enum(PLAN_DOCUMENT_KIND_VALUES).openapi({ example: "spec" }),
    number: z.number().int().openapi({
      example: 2,
      description: "Specs: 1, 2, 3… within the session. Plans: always 1.",
    }),
    repo: z.string().openapi({ example: "org/repo" }),
    path: z
      .string()
      .openapi({ example: "planning/shipwright-may-launch/SPEC-0002.md" }),
    title: z.string().nullable().openapi({ example: "Planning documents" }),
    owner: z.string().nullable().openapi({ example: "dev@example.com" }),
    repos: z.array(z.string()).openapi({ example: ["org/repo"] }),
    prUrl: z
      .string()
      .nullable()
      .openapi({ example: "https://github.com/org/repo/pull/12" }),
    state: z.enum(PLAN_DOCUMENT_STATE_VALUES).openapi({ example: "draft" }),
    commitSha: z.string().nullable().openapi({ example: null }),
    plannedAt: z
      .string()
      .datetime()
      .nullable()
      .openapi({ example: null, description: "Specs only." }),
    originTaskId: z.string().nullable().openapi({ example: null }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-11-17T12:00:00.000Z" }),
    updatedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-11-17T12:00:00.000Z" }),
  })
  .openapi("PlanDocument");

/**
 * A Session row's own fields flattened together with its computed
 * session-rollup (SESH-2.1's computeSessionRollup) fields — never nested
 * under a `rollup` key. Mirrors SessionListItem in session-service.ts.
 */
export const SessionSchema = z
  .object({
    slug: z.string().openapi({ example: "shipwright-may-launch" }),
    accountId: z.string().openapi({
      example: "default",
      description:
        "The account this session belongs to. Sessions are keyed by [accountId, slug]; two accounts may use the same slug independently.",
    }),
    title: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "May launch prep" }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    updatedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-06T12:00:00.000Z" }),
    archivedAt: z.string().nullable().optional().openapi({ example: null }),
    archivedBy: z.string().nullable().optional().openapi({ example: null }),
    owner: z.string().nullable().openapi({
      example: "dev@example.com",
      description: "Owner email, set from the session's first document.",
    }),
    homeRepo: z.string().nullable().openapi({
      example: "org/repo",
      description: "The org/repo the session's planning files live in.",
    }),
    documents: z.array(PlanDocumentSchema).openapi({
      description:
        "The session's planning documents. Agent tokens only see documents whose home repo or a target repo is in their scope.",
    }),
    state: z
      .enum(["waiting", "active", "closed", "empty"])
      .openapi({ example: "active" }),
    waitingSince: z
      .string()
      .nullable()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    lastActivityAt: z
      .string()
      .nullable()
      .openapi({ example: "2026-01-06T12:00:00.000Z" }),
    counts: z
      .object({
        total: z.number().int(),
        open: z.number().int(),
        closed: z.number().int(),
      })
      .openapi({ example: { total: 3, open: 2, closed: 1 } }),
    agentIds: z.array(z.string()).openapi({ example: ["agent-1"] }),
    repos: z.array(z.string()).openapi({
      example: ["org/repo"],
      description:
        "Union of the session's task repos and its declared repos (PATCH `repos`).",
    }),
    waitingTasks: z
      .array(
        z.object({
          id: z.string(),
          kind: z.enum(["hitl", "blocked", "pr_blocked"]),
        }),
      )
      .openapi({ example: [{ id: "task-1", kind: "hitl" }] }),
    archived: z.boolean().openapi({ example: false }),
  })
  .openapi("Session");

export type Session = z.infer<typeof SessionSchema>;

/** Path param for GET /sessions/:slug */
export const SessionSlugParamSchema = z
  .object({
    slug: z.string().openapi({ example: "shipwright-may-launch" }),
  })
  .openapi("SessionSlugParam");

/** Query for GET/PATCH /sessions/:slug — which account's session to address. */
export const SessionAccountQuerySchema = z
  .object({
    accountId: z.string().optional().openapi({
      example: "default",
      description:
        "Admin tokens only: the account whose session to address (default: 'default'). Ignored for agent tokens, which are pinned to their own account.",
    }),
  })
  .openapi("SessionAccountQuery");

/** Query params for GET /sessions */
export const SessionListQuerySchema = z
  .object({
    state: z
      .enum(["waiting", "active", "closed", "empty", "archived", "all"])
      .optional()
      .openapi({
        example: "waiting",
        description:
          "Omitted: archived===false AND state!=='closed'. A named state (waiting/active/closed/empty) matches rollup.state alone (not additionally archived-filtered). 'archived': archived===true (rollup state ignored). 'all': no filtering.",
      }),
    sort: z.enum(["waitingSince", "lastActivityAt"]).optional().openapi({
      example: "waitingSince",
      description:
        "'waitingSince': waiting sessions first (oldest waitingSince first), then non-waiting sessions by lastActivityAt desc. Default (or 'lastActivityAt'): all sessions by lastActivityAt desc, nulls last.",
    }),
    agentId: z.string().optional().openapi({
      example: "agent-id-123",
      description: "Only sessions whose rollup.agentIds includes this agent.",
    }),
    repo: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .openapi({
        example: "org/repo",
        description:
          "Only sessions whose rollup.repos includes any of the given repo(s). Repeatable (?repo=a&repo=b).",
      }),
    org: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .openapi({
        example: "org",
        description:
          "Only sessions with a repo whose `org/repo` string starts with `<org>/`. Repeatable — pass `?org=` multiple times to match any of several orgs (e.g. `?org=a&org=b`).",
      }),
    q: z.string().optional().openapi({
      example: "launch",
      description: "Case-insensitive substring match against slug OR title.",
    }),
    owner: z.string().optional().openapi({
      example: "a@example.com",
      description: "Only sessions whose owner equals this email exactly.",
    }),
    accountId: z.string().optional().openapi({
      example: "default",
      description:
        "Admin tokens only: restrict to one account's sessions. Omitted: every account's sessions, each labeled by `accountId`. Ignored for agent tokens, which are pinned to their own account.",
    }),
    limit: z.string().optional().openapi({ example: "50" }),
    offset: z.string().optional().openapi({ example: "0" }),
    cursor: cursorQueryParam("sessions"),
  })
  .openapi("SessionListQuery");

/** Response for GET /sessions */
export const SessionListResponseSchema = z
  .object({
    sessions: z.array(SessionSchema),
    total: z.number().int().openapi({ example: 10 }),
    limit: z.number().int().openapi({ example: 50 }),
    offset: z.number().int().openapi({ example: 0 }),
    nextCursor: nextCursorField,
  })
  .openapi("SessionListResponse");

/** Request body for PATCH /sessions/:slug — admin-only rename/archive. */
export const SessionPatchBodySchema = z
  .object({
    title: z.string().nullable().optional().openapi({
      example: "May launch prep",
      description:
        "Omitted: title untouched. A string: set. null: clears the title.",
    }),
    archived: z.boolean().optional().openapi({
      example: true,
      description:
        "Omitted: archive fields untouched. true: stamps archivedAt/archivedBy. false: clears both.",
    }),
    owner: z.string().nullable().optional().openapi({
      example: "dev@example.com",
      description: "Omitted: untouched. A string: set. null: clears.",
    }),
    homeRepo: z.string().nullable().optional().openapi({
      example: "org/repo",
      description: "Omitted: untouched. A string: set. null: clears.",
    }),
    repos: z
      .array(z.string())
      .optional()
      .openapi({
        example: ["org/repo"],
        description:
          "Declared target repos, stored as `declaredRepos` and unioned into the response's `repos`. Omitted: untouched. An array replaces the stored list.",
      }),
  })
  .openapi("SessionPatchBody");

// ─── Planning lock + scope preflight (PLU-2.4) ────────────────────────────────

/** Optional body for POST/DELETE /sessions/:slug/lock. */
export const SessionLockBodySchema = z
  .object({
    holder: z.string().min(1).optional().openapi({
      example: "agent-1",
      description:
        "Who holds the lock. Defaults to the calling token's agent id (or 'admin' for admin tokens). Release must name the same holder.",
    }),
  })
  .openapi("SessionLockBody");

/** A held planning lock. */
export const SessionLockSchema = z
  .object({
    holder: z.string().openapi({ example: "agent-1" }),
    acquiredAt: z.string().openapi({ example: "2026-11-17T10:00:00.000Z" }),
    expiresAt: z.string().openapi({ example: "2026-11-17T10:15:00.000Z" }),
  })
  .openapi("SessionLock");

/** 409 body when the planning lock is already held and unexpired. */
export const SessionLockConflictSchema = z
  .object({
    error: z.string().openapi({
      example: "planning lock held by agent-1 since 2026-11-17T10:00:00.000Z",
    }),
    holder: z.string().openapi({ example: "agent-1" }),
    acquiredAt: z.string().openapi({ example: "2026-11-17T10:00:00.000Z" }),
    expiresAt: z.string().openapi({ example: "2026-11-17T10:15:00.000Z" }),
  })
  .openapi("SessionLockConflict");

/** Response for DELETE /sessions/:slug/lock. */
export const SessionLockReleaseSchema = z
  .object({ released: z.literal(true) })
  .openapi("SessionLockRelease");

/** Query for GET /sessions/preflight/scope. */
export const ScopePreflightQuerySchema = z
  .object({
    repo: z.union([z.string(), z.array(z.string())]).openapi({
      example: "org/repo",
      description: "A repo (org/repo) to check. Repeatable (?repo=a&repo=b).",
    }),
  })
  .openapi("ScopePreflightQuery");

/** Response for GET /sessions/preflight/scope. */
export const ScopePreflightResponseSchema = z
  .object({
    covered: z.array(z.string()).openapi({ example: ["org/a"] }),
    uncovered: z.array(z.string()).openapi({ example: ["org/b"] }),
  })
  .openapi("ScopePreflightResponse");

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
  owner: z.string().optional().openapi({
    example: "dev@example.com",
    description:
      "Only tasks whose owner (requester email) equals this exactly.",
  }),
  originKind: OriginKindSchema.optional().openapi({
    example: "cron",
    description: `Only tasks with this origin kind. ${ORIGIN_KIND_DESCRIPTION}`,
  }),
  originRef: z.string().optional().openapi({
    example: "test-readiness",
    description:
      "Only tasks with this origin ref (exact match). For cron tasks this is the SystemCronDefinition id.",
  }),
  claimedBy: z.string().optional().openapi({ example: "agent-id-123" }),
  branch: z.string().optional().openapi({ example: "feat/feature-x" }),
  pr: z.string().optional().openapi({ example: "42" }),
  limit: z.string().optional().openapi({ example: "50" }),
  offset: z.string().optional().openapi({ example: "0" }),
  column: z.enum(TASK_COLUMNS).optional().openapi({
    example: "blocked",
    description:
      "Only tasks the admin board places in this column (planning, ideas, queued, in_progress, blocked) — identical to bucketTaskColumn, including dependency-blocked, hitl and PR-blocked tasks. Composes with limit/cursor/offset; `total` is the exact column size. Paginated list only; an unknown value is a 400.",
  }),
  cursor: z.string().optional().openapi({
    description:
      "Opaque keyset cursor from a previous response's `nextCursor`. Returns rows after that (createdAt, id) position. Mutually exclusive with `offset` (400); a malformed cursor is a 400. Paginated list only.",
  }),
  ready: z.enum(["true", "false"]).optional().openapi({ example: "true" }),
  accountId: z.string().optional().openapi({
    example: "default",
    description:
      "Admin tokens only: narrow results to one account. Ignored for agent tokens, which are always pinned to their own account.",
  }),
  hitl: z.enum(["true", "false"]).optional().openapi({ example: "true" }),
  kind: z.enum(["dev", "prd", "initiative", "idea"]).optional().openapi({
    example: "prd",
    description:
      "Filter by TaskKind. Combines with every other filter as an AND. Note `?kind=<prd|initiative|idea>&ready=true` is always empty — ready.ts excludes every non-dev kind structurally.",
  }),
  scopeAgentIds: z.string().optional().openapi({
    example: "agent-a,agent-b",
    description:
      "Admin tokens only: comma-separated agent ids. With `scopeRepos`, restricts the list to tasks whose `assignee` is in these ids OR whose `repo` is in `scopeRepos` (assignee only, not claimedBy). The scope is active when either param is present; an empty scope returns no tasks. ANDs with every other filter. Agent tokens get a 400 — they cannot widen their own visibility.",
  }),
  scopeRepos: z.string().optional().openapi({
    example: "org/a,org/b",
    description:
      "Admin tokens only: comma-separated repos (`org/repo`). See `scopeAgentIds`.",
  }),
  sort: z.enum(["asc", "desc"]).optional().openapi({ example: "asc" }),
  updatedSince: z.string().optional().openapi({
    example: "2026-01-01T00:00:00.000Z",
    description:
      "Only return tasks with updatedAt >= this ISO timestamp. A conservative pre-filter, not a precise sync anchor.",
  }),
  createdFrom: z.string().optional().openapi({
    example: "2026-11-01T00:00:00.000Z",
    description:
      "Only return tasks with createdAt >= this ISO timestamp (inclusive). Applies to the paginated list only, not `?state=ready|blocked`.",
  }),
  createdTo: z.string().optional().openapi({
    example: "2026-11-08T00:00:00.000Z",
    description:
      "Only return tasks with createdAt <= this ISO timestamp (inclusive). Applies to the paginated list only, not `?state=ready|blocked`.",
  }),
});

/** Response for GET /tasks */
export const TaskListResponseSchema = z
  .object({
    tasks: z.array(TaskSchema),
    total: z.number().int().openapi({ example: 10 }),
    nextCursor: z.string().nullable().openapi({
      example: null,
      description:
        "Opaque cursor for the next page (pass as `?cursor=`); null on the last page and for `?ready=true` / `?state=blocked`.",
    }),
    scopeDegraded: z.boolean().openapi({
      example: false,
      description:
        "True only when the agent token's repo-scope resolver call itself failed upstream (network error, timeout, non-2xx, malformed JSON) — distinct from a legitimate empty repo scope. Always false for admin tokens.",
    }),
  })
  .openapi("TaskListResponse");

/** Accepted forms for a client-supplied `pr` (normalized to the integer PR number server-side). */
const PrInputSchema = z.unknown().optional().openapi({
  example: 42,
  description:
    'PR number. Accepts a positive integer, an integer string (`"42"`), or a github.com pull-request URL (`https://github.com/<owner>/<repo>/pull/<n>`); stored as the integer. Any other value is rejected with 400 by the handler (not the schema, so the error message names the accepted forms).',
});

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
    pr: PrInputSchema,
    dependencies: z.array(z.string()).optional().openapi({ example: [] }),
    acceptanceCriteria: z.array(z.string()).optional().openapi({ example: [] }),
    assignee: z.string().optional().openapi({ example: "user@example.com" }),
    priority: z.string().optional().openapi({ example: "high" }),
    type: z.string().optional().openapi({ example: "feature" }),
    source: z.string().optional().openapi({ example: "manual" }),
    owner: z.string().nullable().optional().openapi({
      example: "dev@example.com",
    }),
    planDocumentId: z.string().nullable().optional().openapi({
      example: "doc-plan-1",
    }),
    specDocumentId: z.string().nullable().optional().openapi({
      example: "doc-spec-1",
    }),
    originKind: OriginKindSchema.nullable().optional().openapi({
      example: "skill",
      description: ORIGIN_KIND_DESCRIPTION,
    }),
    originRef: z.string().nullable().optional().openapi({
      example: "plan-session",
    }),
    kind: z.enum(["dev", "prd", "initiative", "idea"]).optional().openapi({
      example: "dev",
      description: "What the task is (TKD-1.1). Defaults to `dev`.",
    }),
  })
  .passthrough()
  .openapi("CreateTaskBody");

/** Request body for PATCH /tasks/:id */
export const UpdateTaskBodySchema = z
  .object({
    pr: PrInputSchema,
    kind: z.enum(["dev", "prd", "initiative", "idea"]).optional().openapi({
      example: "initiative",
      description:
        "Change what the task is (INI-1.1) — e.g. promote an `idea` to an `initiative`, or an `initiative` to `dev`.",
    }),
  })
  .passthrough()
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
    pr: PrInputSchema,
  })
  .passthrough();

/** Request body for POST /tasks/bulk.
 * The batch-size cap (MAX_BULK_TASKS in task-service.ts) is enforced by the
 * service rather than by Zod here, for the same reason the required fields
 * above are — a custom BadRequestError message instead of a raw ZodError —
 * but it is advertised in the generated spec via `maxItems` below.
 */
export const BulkInsertBodySchema = z
  .array(BulkInsertItemSchema)
  .openapi("BulkInsertBody", {
    maxItems: MAX_BULK_TASKS,
    description: `Tasks to insert, at most ${MAX_BULK_TASKS} per call (TSW-1.3: the whole array runs in one transaction, and the cap bounds that transaction's budget). An over-cap batch is rejected with 400 — split it.`,
  });

/** Response for POST /tasks/bulk */
export const BulkInsertResponseSchema = z
  .object({
    inserted: z.number().int().openapi({ example: 3 }),
    updated: z.number().int().openapi({ example: 1 }),
    skipped: z.array(z.string()).openapi({
      example: [],
      description:
        "Always empty on success (TSW-1.3). bulk() is atomic — a single task id collision (P2002) now hard-fails the whole batch with 409 instead of skipping that task and continuing. This field is retained only for response-shape backward compatibility.",
    }),
  })
  .openapi("BulkInsertResponse");

// ─── Session plan write (PWE-3.1) ──────────────────────────────────────────────

/** The plan document part of POST /sessions/:slug/plan. */
const SessionPlanDocumentSchema = z
  .object({
    repo: z.string().min(1).openapi({
      example: "org/home",
      description: "Home repo (org/repo) the plan file lives in.",
    }),
    path: z
      .string()
      .min(1)
      .openapi({ example: "planning/shipwright-may-launch/PLAN.md" }),
    title: z.string().nullable().optional().openapi({ example: null }),
    owner: z.string().nullable().optional().openapi({
      example: "dev@example.com",
      description:
        "Sets the session's owner when it has none (first one wins, as POST /documents).",
    }),
    repos: z
      .array(z.string().min(1))
      .optional()
      .openapi({ example: ["org/repo", "org/other"] }),
  })
  .openapi("SessionPlanDocument");

/** Request body for POST /sessions/:slug/plan. */
export const SessionPlanBodySchema = z
  .object({
    plan: SessionPlanDocumentSchema,
    tasks: z.array(BulkInsertItemSchema).openapi({
      maxItems: MAX_BULK_TASKS,
      description: `Tasks to create, same shape and validation as POST /tasks/bulk (at most ${MAX_BULK_TASKS}). Each is stamped with the session, \`planDocumentId\` and \`originRef\` (both the plan document id) and \`originKind: document\`; a task's own \`session\` must be absent or equal the slug.`,
    }),
    specs: z
      .array(z.number().int().positive())
      .optional()
      .openapi({
        example: [1, 2],
        description:
          "Spec numbers in this session to mark planned (`plannedAt`). An unregistered number is a 400 and rolls back the whole write; an already-planned spec keeps its `plannedAt`.",
      }),
    holder: z.string().min(1).optional().openapi({
      example: "agent-1",
      description:
        "Planning-lock identity. Defaults to the calling token's agent id (or 'admin'). A live lock held by anyone else is a 409.",
    }),
  })
  .openapi("SessionPlanBody");

/** Response for POST /sessions/:slug/plan. */
export const SessionPlanResponseSchema = z
  .object({
    planDocumentId: z.string().openapi({ example: "clx0plan" }),
    inserted: z.number().int().openapi({ example: 3 }),
  })
  .openapi("SessionPlanResponse");

/**
 * Request body for PATCH /tasks/by-pr (MPD-1.2). Shape violations (empty or
 * over-cap prNumbers, non-positive-integer entries, unknown status) are
 * rejected by the app's validation hook as 400.
 */
export const PatchTasksByPrBodySchema = z
  .object({
    repo: z.string().min(1).openapi({ example: "org/repo" }),
    prNumbers: z
      .array(z.number().int().positive())
      .min(1)
      .max(MAX_PATCH_BY_PR_NUMBERS)
      .openapi({
        example: [101, 102],
        description: `PR numbers of \`repo\`, 1 to ${MAX_PATCH_BY_PR_NUMBERS} positive integers.`,
      }),
    status: z.enum(BY_PR_TARGET_STATUSES).openapi({ example: "deployed" }),
    at: z.string().min(1).optional().openapi({
      example: "2026-07-02T00:00:00.000Z",
      description:
        "ISO timestamp stamped into deployedAt/releasedAt. Defaults to now.",
    }),
  })
  .openapi("PatchTasksByPrBody");

/** Response for PATCH /tasks/by-pr */
export const PatchTasksByPrResponseSchema = z
  .object({
    updated: z.array(z.string()).openapi({
      description: "Ids of `merged` tasks moved to the requested status.",
    }),
    unchanged: z.array(z.string()).openapi({
      description: "Ids of tasks already at the requested status (no-op).",
    }),
    skipped: z.array(z.object({ id: z.string(), status: z.string() })).openapi({
      description:
        "Matching tasks in any other status; never modified. Carries their current status.",
    }),
  })
  .openapi("PatchTasksByPrResponse");

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

/**
 * Request body for POST /tasks/:id/skip (SRB-1.1). `reason` is optional —
 * when omitted, the route defaults it server-side to "unspecified" before
 * calling TaskService.recordSkip(), so recordSkip() always has a concrete
 * string to compare against the task's current lastSkipReason.
 */
export const SkipBodySchema = z
  .object({
    reason: z.string().optional().openapi({
      example: "dev-task:deferred:unmet-hidden-requirement",
    }),
  })
  .openapi("SkipBody");

/** UBL-1.1: optional body of POST /tasks/:id/unblock. */
export const UnblockBodySchema = z
  .object({
    to: z.enum(UNBLOCK_TARGETS).optional().openapi({
      description:
        "Target status. Omit to infer from task.pr and the PR record (never deployed/released).",
    }),
  })
  .openapi("UnblockBody");

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
    origin: z.string().optional().openapi({
      example: "shipwright,ci",
      description:
        "Comma-separated list of PrOrigin values (shipwright, ci, dependency_bot, human, unknown). Matches rows whose origin is any of the given values.",
    }),
    cursor: cursorQueryParam("pull requests"),
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
    nextCursor: nextCursorField,
  })
  .openapi("PrListResponse");

// ─── Census (POM-1.1) ───────────────────────────────────────────────────────

/** A single entry in a POST /prs/census batch upsert. */
const CensusEntrySchema = z
  .object({
    repo: z.string().openapi({ example: "org/repo" }),
    prNumber: z.number().int().openapi({ example: 42 }),
    origin: z.enum(PR_ORIGIN_VALUES).optional().openapi({
      example: "unknown",
      description:
        "First-write-wins: only applied when the row's existing origin is currently null.",
    }),
    authorLogin: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "octocat" }),
    headRef: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "feat/some-branch" }),
    title: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "Add the origin metrics dimension" }),
    state: z
      .enum(["open", "merged", "closed"])
      .optional()
      .openapi({ example: "merged" }),
    mergedAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-04T00:00:00.000Z" }),
    prCreatedAt: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    commitCount: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 12 }),
    commitsDocsRefresh: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 1 }),
    commitsReviewPatch: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 3 }),
    commitsCiFix: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 2 }),
    commitsImplementation: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 6 }),
  })
  .openapi("CensusEntry");

/** Request body for POST /prs/census — a batch of CensusEntry, max
 * MAX_CENSUS_ENTRIES per call. */
export const CensusBodySchema = z
  .array(CensusEntrySchema)
  .openapi("CensusBody", {
    maxItems: MAX_CENSUS_ENTRIES,
    description: `Entries to upsert, at most ${MAX_CENSUS_ENTRIES} per call — the whole batch runs in one transaction. An over-cap batch is rejected with 400.`,
  });

/** Response for POST /prs/census */
export const CensusResponseSchema = z
  .object({
    prs: z.array(PullRequestSchema).openapi({
      description: "The upserted PullRequest rows, one per input entry.",
    }),
  })
  .openapi("CensusResponse");

/** Query params for GET /prs/census/cursor */
export const CensusCursorQuerySchema = z
  .object({
    repo: z.string().openapi({
      example: "org/repo",
      description: "Repository in org/repo format.",
    }),
  })
  .openapi("CensusCursorQuery");

/** Response for GET /prs/census/cursor */
export const CensusCursorResponseSchema = z
  .object({
    cursor: z.string().nullable().openapi({
      example: "2026-01-04T00:00:00.000Z",
      description:
        "Max mergedAt (ISO string) among rows scoped to `repo` whose origin is not null, or null when no such row exists.",
    }),
  })
  .openapi("CensusCursorResponse");

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
    cursor: cursorQueryParam("events"),
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
    nextCursor: nextCursorField,
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
    cursor: cursorQueryParam("events"),
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
    nextCursor: nextCursorField,
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
    phase: z.enum(["review", "patch", "merge"]).optional().openapi({
      example: "patch",
      description:
        "Pipeline phase this claim is for (defaults to 'review' when omitted)",
    }),
    prCreatedAt: z.string().optional().openapi({
      example: "2026-01-01T00:00:00.000Z",
      description:
        "ISO timestamp of the GitHub PR's actual creation time. Only applied on first claim (record creation); ignored on subsequent claims since the field is immutable once set.",
    }),
    authorLogin: z.string().nullable().optional().openapi({
      example: "octocat",
      description:
        "PR author's GitHub login (POM-1.2). Used server-side to derive `origin` (first-write-wins) and refreshed unconditionally on every claim.",
    }),
    headRef: z.string().nullable().optional().openapi({
      example: "feat/some-branch",
      description:
        "PR's head branch name (POM-1.2). Used server-side to derive `origin` (first-write-wins) and refreshed unconditionally on every claim.",
    }),
    title: z.string().nullable().optional().openapi({
      example: "Add the origin metrics dimension",
      description:
        "PR title (POM-1.2). Refreshed unconditionally on every claim.",
    }),
    authorIsBot: z.boolean().optional().openapi({
      example: true,
      description:
        "True when the caller's GitHub client reports `is_bot: true` for the PR author (POF-1.1), e.g. `gh pr list --json author` normalizing a bot author to `app/<slug>`. Used server-side to derive `origin`, checked ahead of the legacy `authorLogin` string matching.",
    }),
    hasAutomatedLabel: z.boolean().optional().openapi({
      example: false,
      description:
        "True when the PR carries a label indicating CI/automation opened it (POF-1.1). Used server-side to derive `origin='ci'`, independent of `authorLogin`.",
    }),
    hasShipwrightLabel: z.boolean().optional().openapi({
      example: false,
      description:
        "True when the PR carries a label indicating Shipwright itself opened it (POF-1.1). Used server-side to derive `origin='shipwright'` at the same precedence step as a linked Task row — no linked task is required.",
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
    phase: z.enum(["review", "patch", "merge"]).openapi({ example: "review" }),
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

// ─── Verification Check (LVB-5.1) ──────────────────────────────────────────────
// Mirrored here rather than imported from the generated Prisma client so this
// file stays a pure Zod-schema module (mirrors PR_ORIGIN_VALUES above).

const VERIFICATION_CHECK_STATUS_VALUES = [
  "ran_passed",
  "ran_failed",
  "skipped",
  "timed_out",
] as const;

const VERIFICATION_CHECK_REASON_CATEGORY_VALUES = [
  "check_timeout",
  "install_timeout",
  "resource_limit",
  "missing_tool",
  "missing_secret",
  "missing_dependency",
  "not_configured",
  "learned_skip",
] as const;

export const VerificationCheckSchema = z
  .object({
    id: z.string().openapi({ example: "clxvcheck1234567" }),
    taskId: z.string().nullable().openapi({ example: null }),
    prRecordId: z.string().nullable().openapi({ example: "clx0987654321" }),
    repo: z.string().openapi({ example: "org/repo" }),
    checkName: z.string().openapi({ example: "unit" }),
    status: z.enum(VERIFICATION_CHECK_STATUS_VALUES).openapi({
      example: "ran_passed",
      description:
        "Outcome of the check attempt. A 'ran_failed' row must never carry a reasonCategory — that field means the agent could not attempt/complete the check in its own environment, never that the code has a real problem.",
    }),
    reasonCategory: z
      .enum(VERIFICATION_CHECK_REASON_CATEGORY_VALUES)
      .nullable()
      .openapi({
        example: null,
        description:
          "A closed set of ENVIRONMENTAL causes, only valid alongside status: 'skipped' or 'timed_out'.",
      }),
    learnedFromCategory: z
      .enum(VERIFICATION_CHECK_REASON_CATEGORY_VALUES)
      .nullable()
      .openapi({
        example: null,
        description:
          "Only valid alongside reasonCategory: 'learned_skip' — the original root-cause category that triggered the learned classification.",
      }),
    durationMs: z.number().int().nullable().openapi({ example: 4200 }),
    at: z.string().openapi({ example: "2026-09-24T12:00:00.000Z" }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-09-24T12:00:00.000Z" }),
  })
  .openapi("VerificationCheck");

export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

/** Request body for POST /verification-checks. */
export const CreateVerificationCheckBodySchema = z
  .object({
    taskId: z.string().optional().openapi({
      example: "clx1234567890",
      description:
        "Exactly one of taskId/prId is required — supplying neither or both is 400.",
    }),
    prId: z.string().optional().openapi({ example: "clx0987654321" }),
    repo: z.string().openapi({ example: "org/repo" }),
    checkName: z.string().openapi({
      example: "unit",
      description:
        "Free-form check name — 'install', 'lint', 'typecheck', 'unit', 'integration', etc.",
    }),
    status: z.enum(VERIFICATION_CHECK_STATUS_VALUES).openapi({
      example: "ran_passed",
    }),
    reasonCategory: z
      .enum(VERIFICATION_CHECK_REASON_CATEGORY_VALUES)
      .optional()
      .openapi({
        example: "missing_tool",
        description:
          "Only valid alongside status: 'skipped' or 'timed_out'. A status:'ran_failed' (or 'ran_passed') request supplying this is 400.",
      }),
    learnedFromCategory: z
      .enum(VERIFICATION_CHECK_REASON_CATEGORY_VALUES)
      .optional()
      .openapi({
        example: "missing_tool",
        description:
          "Only valid alongside reasonCategory: 'learned_skip', and must not itself be 'learned_skip'.",
      }),
    durationMs: z.number().int().optional().openapi({ example: 4200 }),
    at: z.string().optional().openapi({
      example: "2026-09-24T12:00:00.000Z",
      description:
        "ISO timestamp of when the check completed. Defaults to the current time when omitted.",
    }),
  })
  .openapi("CreateVerificationCheckBody");

/** Query params for GET /verification-checks */
export const VerificationCheckListQuerySchema = z
  .object({
    taskId: z.string().optional().openapi({
      example: "clx1234567890",
      description:
        "Selects task mode. Exactly one of ?taskId=, ?prId=, or (?repo=+?checkName=) is required.",
    }),
    prId: z.string().optional().openapi({ example: "clx0987654321" }),
    repo: z.string().optional().openapi({
      example: "org/repo",
      description:
        "Selects repo+checkName mode (LVB-4.4) — paired with ?checkName=, both required together. Returns history for this repo+check across ALL tasks/PRs, ordered by `at` DESCENDING (most recent first) — a deliberate deviation from the taskId/prId modes' ascending order, so a caller can walk backward from the most recent outcome to detect a consecutive skipped/timed_out streak.",
    }),
    checkName: z.string().optional().openapi({
      example: "unit",
      description:
        "Paired with ?repo= — supplying only one of the pair is 400.",
    }),
    limit: z
      .string()
      .optional()
      .openapi({ example: "50", description: "Max records to return" }),
    offset: z
      .string()
      .optional()
      .openapi({ example: "0", description: "Pagination offset" }),
    cursor: cursorQueryParam("verification checks"),
  })
  .openapi("VerificationCheckListQuery");

/** Response for GET /verification-checks */
export const VerificationCheckListResponseSchema = z
  .object({
    checks: z.array(VerificationCheckSchema).openapi({
      description:
        "Verification checks matching the selected mode. Ordered by `at` ascending (oldest first) for taskId/prId modes; ordered by `at` descending (most recent first) for repo+checkName mode.",
    }),
    total: z.number().int().openapi({ example: 1 }),
    limit: z.number().int().openapi({ example: 50 }),
    offset: z.number().int().openapi({ example: 0 }),
    nextCursor: nextCursorField,
  })
  .openapi("VerificationCheckListResponse");

// ─── Coverage Snapshot (CVT-2.1) ───────────────────────────────────────────────

export const CoverageSnapshotSchema = z
  .object({
    id: z.string().openapi({ example: "clxcov1234567890" }),
    accountId: z.string().openapi({ example: "default" }),
    repo: z.string().openapi({ example: "org/repo" }),
    branch: z.string().openapi({ example: "main" }),
    commitSha: z
      .string()
      .openapi({ example: "9fceb02d0ae598e95dc970b74767f19372d61af8" }),
    linesCovered: z.number().int().openapi({ example: 820 }),
    linesTotal: z.number().int().openapi({ example: 1000 }),
    linesPct: z.number().openapi({
      example: 82,
      description: "Computed server-side: linesCovered / linesTotal * 100.",
    }),
    branchesCovered: z.number().int().nullable().openapi({ example: 40 }),
    branchesTotal: z.number().int().nullable().openapi({ example: 50 }),
    branchesPct: z.number().nullable().openapi({ example: 80 }),
    functionsCovered: z.number().int().nullable().openapi({ example: 90 }),
    functionsTotal: z.number().int().nullable().openapi({ example: 100 }),
    functionsPct: z.number().nullable().openapi({ example: 90 }),
    tool: z.string().openapi({ example: "bun" }),
    runUrl: z
      .string()
      .nullable()
      .openapi({ example: "https://github.com/org/repo/actions/runs/1" }),
    measuredAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-11-17T12:00:00.000Z" }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-11-17T12:00:05.000Z" }),
  })
  .openapi("CoverageSnapshot");

export type CoverageSnapshot = z.infer<typeof CoverageSnapshotSchema>;

/** Request body for POST /coverage-snapshots. */
export const CreateCoverageSnapshotBodySchema = z
  .object({
    repo: z.string().openapi({
      example: "org/repo",
      description: "Repository in `owner/repo` form — anything else is 400.",
    }),
    branch: z.string().openapi({ example: "main" }),
    commitSha: z.string().openapi({
      example: "9fceb02d0ae598e95dc970b74767f19372d61af8",
      description:
        "Commit the coverage was measured at. (accountId, repo, commitSha) is unique — a repeat POST updates the row.",
    }),
    linesCovered: z.number().int().openapi({
      example: 820,
      description: "Must be >= 0 and <= linesTotal.",
    }),
    linesTotal: z.number().int().openapi({
      example: 1000,
      description: "Must be > 0.",
    }),
    branchesCovered: z.number().int().optional().openapi({ example: 40 }),
    branchesTotal: z.number().int().optional().openapi({
      example: 50,
      description:
        "Optional; branchesCovered/branchesTotal must be given together with covered <= total.",
    }),
    functionsCovered: z.number().int().optional().openapi({ example: 90 }),
    functionsTotal: z.number().int().optional().openapi({
      example: 100,
      description:
        "Optional; functionsCovered/functionsTotal must be given together with covered <= total.",
    }),
    tool: z.string().openapi({
      example: "bun",
      description: "Tool that produced the measurement (bun, c8, nyc, ...).",
    }),
    runUrl: z.string().optional().openapi({
      example: "https://github.com/org/repo/actions/runs/1",
    }),
    measuredAt: z.string().optional().openapi({
      example: "2026-11-17T12:00:00.000Z",
      description:
        "ISO timestamp of the measurement. Defaults to the current time.",
    }),
    accountId: z.string().optional().openapi({
      example: "default",
      description:
        "Admin tokens only: the account to stamp the snapshot with (defaults to `default`). Ignored for agent tokens, which always write to their own account.",
    }),
  })
  .openapi("CreateCoverageSnapshotBody");

/** Query params for GET /coverage-snapshots */
export const CoverageSnapshotListQuerySchema = z
  .object({
    repo: z.string().optional().openapi({
      example: "org/repo",
      description: "Only snapshots for this repo.",
    }),
    since: z.string().optional().openapi({
      example: "2026-11-01T00:00:00.000Z",
      description: "ISO timestamp; only snapshots measured at or after it.",
    }),
    limit: z
      .string()
      .optional()
      .openapi({ example: "50", description: "Max records to return" }),
    offset: z
      .string()
      .optional()
      .openapi({ example: "0", description: "Pagination offset" }),
    accountId: z.string().optional().openapi({
      example: "default",
      description: "Admin tokens only: narrow to one account.",
    }),
    cursor: cursorQueryParam("snapshots"),
  })
  .openapi("CoverageSnapshotListQuery");

/** Query params for GET /coverage-snapshots/latest */
export const CoverageSnapshotLatestQuerySchema = z
  .object({
    accountId: z.string().optional().openapi({
      example: "default",
      description: "Admin tokens only: narrow to one account.",
    }),
  })
  .openapi("CoverageSnapshotLatestQuery");

/** Response for GET /coverage-snapshots */
export const CoverageSnapshotListResponseSchema = z
  .object({
    snapshots: z.array(CoverageSnapshotSchema).openapi({
      description:
        "Snapshots ordered by `measuredAt` descending (newest first).",
    }),
    total: z.number().int().openapi({ example: 1 }),
    limit: z.number().int().openapi({ example: 50 }),
    offset: z.number().int().openapi({ example: 0 }),
    nextCursor: nextCursorField,
  })
  .openapi("CoverageSnapshotListResponse");

/** Response for GET /coverage-snapshots/latest */
export const CoverageSnapshotLatestResponseSchema = z
  .object({
    snapshots: z.array(CoverageSnapshotSchema).openapi({
      description:
        "Exactly one snapshot per repo — the newest by `measuredAt` — ordered by repo.",
    }),
  })
  .openapi("CoverageSnapshotLatestResponse");

// ─── System Cron (SCR-1.1) ────────────────────────────────────────────────────

export const SystemCronDefinitionSchema = z
  .object({
    id: z.string().openapi({
      example: "dep-audit",
      description:
        "Lowercase slug ([a-z0-9][a-z0-9-]*, max 63 chars). Embedded verbatim in generated task ids.",
    }),
    accountId: z.string().openapi({
      example: "default",
      description:
        "The account this definition belongs to. Tasks it generates inherit it.",
    }),
    name: z.string().openapi({ example: "Dependency audit" }),
    schedule: z.string().openapi({
      example: "0 9 * * 1",
      description:
        "5-field cron expression, interpreted by the external scheduler that calls /fire.",
    }),
    timezone: z.string().openapi({
      example: "UTC",
      description: "IANA timezone the schedule is evaluated in.",
    }),
    enabled: z.boolean().openapi({ example: true }),
    enabledAt: z.string().datetime().nullable().openapi({
      example: "2026-11-14T00:00:00.000Z",
      description:
        "When the definition last went disabled→enabled; null while disabled. The scheduler never fires a slot at or before it.",
    }),
    titleTemplate: z.string().openapi({
      example: "Dependency audit: {repo}",
      description:
        "Task title template. `{repo}` is the only placeholder, replaced by plain substitution with the org/repo string; nothing else is evaluated.",
    }),
    descriptionTemplate: z.string().openapi({
      example: "Audit {repo}'s dependencies and open a PR for safe bumps.",
      description:
        "Task description template — same `{repo}`-only plain substitution as titleTemplate.",
    }),
    repoScope: z.enum(["all", "selected"]).openapi({
      example: "all",
      description:
        "Which repos the cron fans out to: every repo ('all') or only `repos` ('selected').",
    }),
    repos: z.array(z.string()).openapi({
      example: ["acme/widgets"],
      description:
        "org/repo list used when repoScope is 'selected'; always [] when 'all'.",
    }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-11-14T00:00:00.000Z" }),
    updatedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-11-14T00:00:00.000Z" }),
  })
  .openapi("SystemCronDefinition");

/** Path param for /system-crons/:id routes. */
export const SystemCronIdParamSchema = z
  .object({
    id: z.string().openapi({ example: "dep-audit" }),
  })
  .openapi("SystemCronIdParam");

/** Query for GET /system-crons */
export const SystemCronListQuerySchema = z
  .object({
    enabled: z.enum(["true", "false"]).optional().openapi({
      example: "true",
      description: "Only definitions with this enabled state.",
    }),
    accountId: z.string().optional().openapi({
      example: "default",
      description:
        "Restrict to one account's definitions. Omitted: every account's definitions.",
    }),
  })
  .openapi("SystemCronListQuery");

/** Query for the single-definition routes (PATCH, enable, disable, fire). */
export const SystemCronAccountQuerySchema = z
  .object({
    accountId: z.string().optional().openapi({
      example: "default",
      description:
        "Optional: require the definition to belong to this account (404 otherwise).",
    }),
  })
  .openapi("SystemCronAccountQuery");

/** Response for GET /system-crons */
export const SystemCronListResponseSchema = z
  .object({
    systemCrons: z.array(SystemCronDefinitionSchema),
  })
  .openapi("SystemCronListResponse");

/** Request body for POST /system-crons */
export const CreateSystemCronBodySchema = z
  .object({
    id: z.string().openapi({ example: "dep-audit" }),
    name: z.string().openapi({ example: "Dependency audit" }),
    schedule: z.string().openapi({ example: "0 9 * * 1" }),
    timezone: z
      .string()
      .optional()
      .openapi({ example: "UTC", description: "Defaults to UTC." }),
    enabled: z
      .boolean()
      .optional()
      .openapi({ example: true, description: "Defaults to true." }),
    titleTemplate: z.string().openapi({ example: "Dependency audit: {repo}" }),
    descriptionTemplate: z
      .string()
      .openapi({ example: "Audit {repo}'s dependencies." }),
    repoScope: z
      .enum(["all", "selected"])
      .optional()
      .openapi({ example: "all", description: "Defaults to 'all'." }),
    repos: z
      .array(z.string())
      .optional()
      .openapi({
        example: ["acme/widgets"],
        description:
          "org/repo list; required non-empty when repoScope is 'selected', ignored when 'all'. De-duplicated; capped at 500.",
      }),
  })
  .openapi("CreateSystemCronBody");

/** Request body for PATCH /system-crons/:id — every field optional. */
export const PatchSystemCronBodySchema = z
  .object({
    name: z.string().optional(),
    schedule: z.string().optional(),
    timezone: z.string().optional(),
    titleTemplate: z.string().optional(),
    descriptionTemplate: z.string().optional(),
    repoScope: z.enum(["all", "selected"]).optional(),
    repos: z.array(z.string()).optional(),
  })
  .openapi("PatchSystemCronBody");

/** Request body for POST /system-crons/:id/fire */
export const FireSystemCronBodySchema = z
  .object({
    scheduledFor: z.string().openapi({
      example: "2026-11-14T09:00:00Z",
      description:
        "The slot being fired — ISO-8601 with an explicit timezone (`Z` or `±HH:MM`), truncated to whole seconds. Together with the cron id this is the idempotency key.",
    }),
    repos: z
      .array(z.string())
      .min(1)
      .max(MAX_BULK_TASKS)
      .openapi({
        example: ["org/repo-a", "org/repo-b"],
        description: `One task is created per distinct org/repo (max ${MAX_BULK_TASKS}).`,
      }),
  })
  .openapi("FireSystemCronBody");

/** Response for POST /system-crons/:id/fire */
export const FireSystemCronResponseSchema = z
  .object({
    claimed: z.boolean().openapi({
      example: true,
      description:
        "true: this call claimed the slot and created the tasks. false: the slot was already claimed (or lost a concurrent race) — nothing was created.",
    }),
    cronId: z.string().openapi({ example: "dep-audit" }),
    scheduledFor: z.string().openapi({ example: "2026-11-14T09:00:00.000Z" }),
    slot: z.string().openapi({
      example: "20261114T090000Z",
      description:
        "Compact UTC form of scheduledFor (YYYYMMDDTHHMMSSZ) used in task ids.",
    }),
    taskIds: z.array(z.string()).openapi({
      example: [
        "SC-dep-audit-20261114T090000Z-org-repo-a",
        "SC-dep-audit-20261114T090000Z-org-repo-b",
      ],
      description:
        "Ids of tasks created by this call: SC-{cronId}-{slot}-{owner}-{repo}. Always empty when claimed is false.",
    }),
  })
  .openapi("FireSystemCronResponse");

/** Response for GET /system-crons/:id/last-trigger */
export const LastTriggerResponseSchema = z
  .object({
    scheduledFor: z.string().nullable().openapi({
      example: "2026-11-14T09:00:00.000Z",
      description:
        "Max claimed scheduledFor (whole-second UTC ISO) for the definition; null when it has never fired.",
    }),
  })
  .openapi("LastTriggerResponse");

/** Query for GET /system-crons/:id/triggers */
export const SystemCronTriggersQuerySchema = z
  .object({
    accountId: z.string().optional().openapi({
      example: "default",
      description:
        "Optional: require the definition to belong to this account (404 otherwise).",
    }),
    limit: z.coerce.number().int().min(1).max(50).default(5).openapi({
      example: 5,
      description: "Max triggers to return (1-50, default 5).",
    }),
    cursor: cursorQueryParam("triggers"),
  })
  .openapi("SystemCronTriggersQuery");

/** Response for GET /system-crons/:id/triggers */
export const SystemCronTriggersResponseSchema = z
  .object({
    triggers: z
      .array(
        z.object({
          scheduledFor: z
            .string()
            .openapi({ example: "2026-11-14T09:00:00.000Z" }),
          claimedAt: z.string().openapi({
            example: "2026-11-14T09:00:01.234Z",
            description: "When the slot was claimed (trigger row createdAt).",
          }),
          taskCount: z.number().int().openapi({ example: 2 }),
        }),
      )
      .openapi({
        description:
          "Claimed slots, newest first by scheduledFor (createdAt desc tie-break).",
      }),
    nextCursor: nextCursorField,
  })
  .openapi("SystemCronTriggersResponse");

// ─── Planning documents (PLU-2.2) ──────────────────────────────────────────────

/** Request body for POST /documents. */
export const RegisterPlanDocumentBodySchema = z
  .object({
    session: z.string().openapi({ example: "shipwright-may-launch" }),
    kind: z.enum(PLAN_DOCUMENT_KIND_VALUES).openapi({ example: "spec" }),
    number: z.number().int().positive().optional().openapi({
      example: 2,
      description:
        "Required for specs; plans are always number 1 (omit it or send 1).",
    }),
    repo: z.string().openapi({
      example: "org/repo",
      description:
        "Home repo (org/repo) the file lives in. Agent tokens: must be in the token's repo scope (else 403).",
    }),
    path: z
      .string()
      .openapi({ example: "planning/shipwright-may-launch/SPEC-0002.md" }),
    title: z.string().nullable().optional().openapi({ example: "Spec title" }),
    owner: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "dev@example.com" }),
    repos: z
      .array(z.string())
      .optional()
      .openapi({ example: ["org/repo", "org/other"] }),
    prUrl: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "https://github.com/org/repo/pull/12" }),
    state: z.enum(PLAN_DOCUMENT_STATE_VALUES).optional().openapi({
      example: "pr_open",
      description: "Defaults to draft on first registration.",
    }),
    commitSha: z.string().nullable().optional().openapi({ example: null }),
    originTaskId: z.string().nullable().optional().openapi({ example: null }),
  })
  .openapi("RegisterPlanDocumentBody");

/** Request body for PATCH /documents/:id. */
export const PatchPlanDocumentBodySchema = z
  .object({
    plannedAt: z.string().datetime().nullable().optional().openapi({
      example: "2026-11-17T12:00:00.000Z",
      description:
        "ISO timestamp a planning pass consumed this spec; null clears it. Specs only.",
    }),
    prUrl: z.string().nullable().optional().openapi({ example: null }),
    owner: z.string().nullable().optional().openapi({ example: null }),
    state: z.enum(PLAN_DOCUMENT_STATE_VALUES).optional().openapi({
      example: "merged",
    }),
  })
  .openapi("PatchPlanDocumentBody");

/** Query params for GET /documents. Unknown parameters are rejected with 400. */
export const PlanDocumentListQuerySchema = z
  .object({
    session: z
      .string()
      .optional()
      .openapi({ example: "shipwright-may-launch" }),
    kind: z.enum(PLAN_DOCUMENT_KIND_VALUES).optional().openapi({
      example: "spec",
    }),
    owner: z.string().optional().openapi({ example: "dev@example.com" }),
    planned: z.enum(["true", "false"]).optional().openapi({
      example: "false",
      description:
        "`false` returns specs with no plannedAt, excluding abandoned ones; `true` returns documents with plannedAt set.",
    }),
    accountId: z.string().optional().openapi({
      example: "default",
      description:
        "Admin tokens only: narrow to one account. Ignored for agent tokens.",
    }),
  })
  .openapi("PlanDocumentListQuery");

/** Response for GET /documents. */
export const PlanDocumentListResponseSchema = z
  .object({
    documents: z.array(PlanDocumentSchema),
    total: z.number().int().openapi({ example: 1 }),
  })
  .openapi("PlanDocumentListResponse");

/** Path param for PATCH /documents/:id. */
export const PlanDocumentIdParamSchema = z
  .object({ id: z.string().openapi({ example: "clxdoc1234567890" }) })
  .openapi("PlanDocumentIdParam");
