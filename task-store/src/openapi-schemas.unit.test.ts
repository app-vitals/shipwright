/**
 * task-store/src/openapi-schemas.unit.test.ts
 * Parse/reject tests for all Zod entity schemas in openapi-schemas.ts.
 * Tests validate that good input parses cleanly and bad input produces typed errors.
 */

import { describe, expect, test } from "bun:test";
import {
  type Task,
  TaskSchema,
  type PullRequest,
  PullRequestSchema,
  type TaskToken,
  TaskTokenSchema,
  ErrorSchema,
  OkSchema,
} from "./openapi-schemas.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const now = new Date().toISOString();
const yesterday = new Date(Date.now() - 86400000).toISOString();

const validTask = {
  id: "clx1234567890",
  title: "Implement feature X",
  status: "pending",
  source: "manual",
  session: "session-123",
  repo: "org/repo",
  description: "This is a task description",
  acceptanceCriteria: ["Criterion 1", "Criterion 2"],
  layer: "feature",
  branch: "feat/feature-x",
  dependencies: ["task-1", "task-2"],
  pr: 42,
  hours: 5.5,
  addedAt: yesterday,
  startedAt: yesterday,
  prCreatedAt: yesterday,
  mergedAt: null,
  blockedAt: null,
  blockedReason: null,
  note: "Some notes",
  type: "feature",
  priority: "high",
  cancelledAt: null,
  completedAt: null,
  deployingAt: null,
  deployedAt: null,
  ciFixAttempts: 2,
  mergeCommit: "abc123def456",
  prUrl: "https://github.com/org/repo/pull/42",
  assignee: "user@example.com",
  issue: "GH-123",
  model: "sonnet",
  complexity: 7,
  hitl: true,
  hitlNotifiedAt: yesterday,
  claimedBy: "agent-id-123",
  agentHint: "prefer-sonnet",
  claimedAt: yesterday,
  heartbeatAt: yesterday,
  simplifyTotal: 10,
  simplifyDry: 2,
  simplifyDeadCode: 3,
  simplifyNaming: 1,
  simplifyComplexity: 2,
  simplifyConsistency: 2,
  coverageDelta: 5.5,
  effortLevel: "medium",
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 100,
  cacheCreationTokens: 50,
  costUsd: 0.02,
  metadata: { customKey: "customValue", nested: { deep: true } },
  createdAt: yesterday,
  updatedAt: now,
};

const validPullRequest = {
  id: "clx0987654321",
  repo: "org/repo",
  prNumber: 42,
  taskId: "clx1234567890",
  staged: false,
  state: "open",
  reviewState: "pending",
  commitSha: "abc123def456",
  patchCycles: 1,
  reviewCycles: 0,
  agentId: "agent-id-123",
  reviewedAt: null,
  patchedAt: null,
  mergedAt: null,
  claimedBy: "agent-id-123",
  claimedAt: yesterday,
  heartbeatAt: yesterday,
  phase: "review",
  readyForReviewAt: yesterday,
  readyForPatchAt: null,
  readyForDeployAt: null,
  createdAt: yesterday,
  updatedAt: now,
};

const validTaskToken = {
  id: "clxtoken123456",
  label: "ci-runner",
  agentId: "agent-id-123",
  createdAt: now,
  revokedAt: null,
};

// ─── TaskSchema ───────────────────────────────────────────────────────────────

describe("TaskSchema", () => {
  test("parses valid task with all fields", () => {
    const result = TaskSchema.safeParse(validTask);
    expect(result.success).toBe(true);
    if (result.success) {
      const task: Task = result.data;
      expect(task.id).toBe("clx1234567890");
      expect(task.title).toBe("Implement feature X");
      expect(task.status).toBe("pending");
      expect(task.repo).toBe("org/repo");
    }
  });

  test("parses task with minimal fields", () => {
    const minimal = {
      id: "clx1234567890",
      title: "Minimal task",
      status: "in_progress",
      createdAt: now,
      updatedAt: now,
    };
    const result = TaskSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      const task: Task = result.data;
      expect(task.title).toBe("Minimal task");
    }
  });

  test("parses task with nullable fields as null", () => {
    const withNulls = {
      ...validTask,
      mergedAt: null,
      blockedReason: null,
      agentHint: null,
    };
    const result = TaskSchema.safeParse(withNulls);
    expect(result.success).toBe(true);
  });

  test("accepts all valid TaskStatus enum values", () => {
    const statuses = [
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
    ];
    for (const status of statuses) {
      const result = TaskSchema.safeParse({
        ...validTask,
        status,
      });
      expect(result.success).toBe(true);
    }
  });

  test("rejects invalid TaskStatus", () => {
    const result = TaskSchema.safeParse({
      ...validTask,
      status: "invalid_status",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing id", () => {
    const { id: _, ...noId } = validTask;
    const result = TaskSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  test("rejects missing title", () => {
    const { title: _, ...noTitle } = validTask;
    const result = TaskSchema.safeParse(noTitle);
    expect(result.success).toBe(false);
  });

  test("rejects missing status", () => {
    const { status: _, ...noStatus } = validTask;
    const result = TaskSchema.safeParse(noStatus);
    expect(result.success).toBe(false);
  });

  test("rejects missing createdAt", () => {
    const { createdAt: _, ...noCreatedAt } = validTask;
    const result = TaskSchema.safeParse(noCreatedAt);
    expect(result.success).toBe(false);
  });

  test("rejects missing updatedAt", () => {
    const { updatedAt: _, ...noUpdatedAt } = validTask;
    const result = TaskSchema.safeParse(noUpdatedAt);
    expect(result.success).toBe(false);
  });

  test("rejects non-string id", () => {
    const result = TaskSchema.safeParse({ ...validTask, id: 123 });
    expect(result.success).toBe(false);
  });

  test("rejects non-boolean hitl", () => {
    const result = TaskSchema.safeParse({ ...validTask, hitl: "yes" });
    expect(result.success).toBe(false);
  });

  test("parses acceptanceCriteria as string array", () => {
    const result = TaskSchema.safeParse({
      ...validTask,
      acceptanceCriteria: ["AC1", "AC2", "AC3"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.acceptanceCriteria).toHaveLength(3);
    }
  });

  test("parses dependencies as string array", () => {
    const result = TaskSchema.safeParse({
      ...validTask,
      dependencies: ["dep-1", "dep-2"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependencies).toHaveLength(2);
    }
  });

  test("parses metadata as record", () => {
    const result = TaskSchema.safeParse({
      ...validTask,
      metadata: { key1: "value1", key2: 123, key3: true },
    });
    expect(result.success).toBe(true);
  });

  test("does not expose sensitive fields", () => {
    const withSecret = { ...validTask, apiKey: "secret-key" };
    const result = TaskSchema.safeParse(withSecret);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).apiKey).toBeUndefined();
    }
  });
});

// ─── PullRequestSchema ─────────────────────────────────────────────────────────

describe("PullRequestSchema", () => {
  test("parses valid pull request with all fields", () => {
    const result = PullRequestSchema.safeParse(validPullRequest);
    expect(result.success).toBe(true);
    if (result.success) {
      const pr: PullRequest = result.data;
      expect(pr.id).toBe("clx0987654321");
      expect(pr.repo).toBe("org/repo");
      expect(pr.prNumber).toBe(42);
      expect(pr.state).toBe("open");
    }
  });

  test("parses pull request with minimal fields", () => {
    const minimal = {
      id: "clx0987654321",
      repo: "org/repo",
      prNumber: 42,
      createdAt: now,
      updatedAt: now,
    };
    const result = PullRequestSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  test("parses pull request with nullable fields", () => {
    const withNulls = {
      ...validPullRequest,
      taskId: null,
      commitSha: null,
      mergedAt: null,
    };
    const result = PullRequestSchema.safeParse(withNulls);
    expect(result.success).toBe(true);
  });

  test("accepts all valid PrState enum values", () => {
    const states = ["open", "merged", "closed"];
    for (const state of states) {
      const result = PullRequestSchema.safeParse({
        ...validPullRequest,
        state,
      });
      expect(result.success).toBe(true);
    }
  });

  test("rejects invalid PrState", () => {
    const result = PullRequestSchema.safeParse({
      ...validPullRequest,
      state: "invalid_state",
    });
    expect(result.success).toBe(false);
  });

  test("accepts all valid PrReviewState enum values", () => {
    const states = ["pending", "in_progress", "posted", "approved"];
    for (const state of states) {
      const result = PullRequestSchema.safeParse({
        ...validPullRequest,
        reviewState: state,
      });
      expect(result.success).toBe(true);
    }
  });

  test("rejects invalid PrReviewState", () => {
    const result = PullRequestSchema.safeParse({
      ...validPullRequest,
      reviewState: "invalid_review_state",
    });
    expect(result.success).toBe(false);
  });

  test("accepts all valid PrPhase enum values", () => {
    const phases = ["review", "patch", "deploy"];
    for (const phase of phases) {
      const result = PullRequestSchema.safeParse({
        ...validPullRequest,
        phase,
      });
      expect(result.success).toBe(true);
    }
  });

  test("parses pull request with null phase", () => {
    const result = PullRequestSchema.safeParse({
      ...validPullRequest,
      phase: null,
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing id", () => {
    const { id: _, ...noId } = validPullRequest;
    const result = PullRequestSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  test("rejects missing repo", () => {
    const { repo: _, ...noRepo } = validPullRequest;
    const result = PullRequestSchema.safeParse(noRepo);
    expect(result.success).toBe(false);
  });

  test("rejects missing prNumber", () => {
    const { prNumber: _, ...noPrNumber } = validPullRequest;
    const result = PullRequestSchema.safeParse(noPrNumber);
    expect(result.success).toBe(false);
  });

  test("rejects non-integer prNumber", () => {
    const result = PullRequestSchema.safeParse({
      ...validPullRequest,
      prNumber: "42",
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-boolean staged", () => {
    const result = PullRequestSchema.safeParse({
      ...validPullRequest,
      staged: 1,
    });
    expect(result.success).toBe(false);
  });

  test("parses patchCycles and reviewCycles as integers", () => {
    const result = PullRequestSchema.safeParse({
      ...validPullRequest,
      patchCycles: 5,
      reviewCycles: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.patchCycles).toBe(5);
      expect(result.data.reviewCycles).toBe(3);
    }
  });
});

// ─── TaskTokenSchema ──────────────────────────────────────────────────────────

describe("TaskTokenSchema", () => {
  test("parses valid token metadata", () => {
    const result = TaskTokenSchema.safeParse(validTaskToken);
    expect(result.success).toBe(true);
    if (result.success) {
      const token: TaskToken = result.data;
      expect(token.id).toBe("clxtoken123456");
      expect(token.label).toBe("ci-runner");
      expect(token.agentId).toBe("agent-id-123");
    }
  });

  test("parses token without label", () => {
    const { label: _, ...noLabel } = validTaskToken;
    const result = TaskTokenSchema.safeParse(noLabel);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.label).toBeUndefined();
    }
  });

  test("parses token with null label", () => {
    const result = TaskTokenSchema.safeParse({
      ...validTaskToken,
      label: null,
    });
    expect(result.success).toBe(true);
  });

  test("parses token without agentId", () => {
    const { agentId: _, ...noAgentId } = validTaskToken;
    const result = TaskTokenSchema.safeParse(noAgentId);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentId).toBeUndefined();
    }
  });

  test("parses token with null agentId", () => {
    const result = TaskTokenSchema.safeParse({
      ...validTaskToken,
      agentId: null,
    });
    expect(result.success).toBe(true);
  });

  test("parses token with revokedAt as ISO string", () => {
    const result = TaskTokenSchema.safeParse({
      ...validTaskToken,
      revokedAt: now,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.revokedAt).toBe(now);
    }
  });

  test("parses token with null revokedAt", () => {
    const result = TaskTokenSchema.safeParse({
      ...validTaskToken,
      revokedAt: null,
    });
    expect(result.success).toBe(true);
  });

  test("does not expose token hash", () => {
    const withHash = { ...validTaskToken, token: "sha256_hash_value" };
    const result = TaskTokenSchema.safeParse(withHash);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).token).toBeUndefined();
    }
  });

  test("rejects missing id", () => {
    const { id: _, ...noId } = validTaskToken;
    const result = TaskTokenSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  test("rejects missing createdAt", () => {
    const { createdAt: _, ...noCreatedAt } = validTaskToken;
    const result = TaskTokenSchema.safeParse(noCreatedAt);
    expect(result.success).toBe(false);
  });

  test("rejects non-string id", () => {
    const result = TaskTokenSchema.safeParse({ ...validTaskToken, id: 123 });
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

// ─── OkSchema ──────────────────────────────────────────────────────────────────

describe("OkSchema", () => {
  test("parses valid ok response", () => {
    const result = OkSchema.safeParse({ ok: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(true);
    }
  });

  test("rejects missing ok field", () => {
    const result = OkSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects non-literal true ok value", () => {
    const result = OkSchema.safeParse({ ok: false });
    expect(result.success).toBe(false);
  });
});
