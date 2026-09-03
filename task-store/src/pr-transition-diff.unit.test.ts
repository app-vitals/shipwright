/**
 * task-store/src/pr-transition-diff.unit.test.ts
 *
 * Unit tests for the pure diff-computation behind the PullRequest audit trail
 * (PSA-1.2). No I/O — hand-built PR states, table-driven cases.
 */

import { describe, expect, test } from "bun:test";
import type { PullRequest } from "./index.ts";
import { computePrTransitionDiff } from "./pr-transition-diff.ts";

/** Build a minimal PullRequest-shaped object; overrides fill in the fields under test. */
function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: "pr-1",
    repo: "app-vitals/shipwright",
    prNumber: 1,
    staged: false,
    state: "open",
    reviewState: "pending",
    commitSha: null,
    reviewedCommitSha: null,
    patchCycles: 0,
    reviewCycles: 0,
    agentId: null,
    reviewedAt: null,
    patchedAt: null,
    mergedAt: null,
    prCreatedAt: null,
    claimedBy: null,
    claimedAt: null,
    heartbeatAt: null,
    phase: null,
    readyForReviewAt: null,
    readyForPatchAt: null,
    readyForDeployAt: null,
    blocked: false,
    blockedReason: null,
    skipCount: 0,
    lastSkippedAt: null,
    lastCiFailureSignature: null,
    consecutiveCiFailureCount: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as PullRequest;
}

describe("computePrTransitionDiff()", () => {
  test("null before (create path) → no events", () => {
    expect(computePrTransitionDiff(null, pr({ claimedBy: "agent-a" }))).toEqual(
      [],
    );
  });

  test("identical states → no events", () => {
    const before = pr({ claimedBy: "agent-a", reviewState: "in_progress" });
    const after = pr({ claimedBy: "agent-a", reviewState: "in_progress" });
    expect(computePrTransitionDiff(before, after)).toEqual([]);
  });

  test("heartbeatAt-only change → no events", () => {
    const before = pr({ heartbeatAt: "2026-01-01T00:00:00.000Z" });
    const after = pr({ heartbeatAt: "2026-01-02T00:00:00.000Z" });
    expect(computePrTransitionDiff(before, after)).toEqual([]);
  });

  test("multiple real field changes → one entry each", () => {
    const before = pr({ reviewState: "pending", phase: null, claimedBy: null });
    const after = pr({
      reviewState: "in_progress",
      phase: "review",
      claimedBy: "agent-a",
    });

    const changes = computePrTransitionDiff(before, after);
    const byField = Object.fromEntries(changes.map((c) => [c.field, c]));

    expect(changes).toHaveLength(3);
    expect(byField.reviewState).toEqual({
      field: "reviewState",
      oldValue: "pending",
      newValue: "in_progress",
    });
    expect(byField.phase).toEqual({
      field: "phase",
      oldValue: null,
      newValue: "review",
    });
    expect(byField.claimedBy).toEqual({
      field: "claimedBy",
      oldValue: null,
      newValue: "agent-a",
    });
  });

  test("real field change + incidental heartbeatAt change → only the real field's entry", () => {
    const before = pr({
      reviewState: "pending",
      heartbeatAt: "2026-01-01T00:00:00.000Z",
    });
    const after = pr({
      reviewState: "in_progress",
      heartbeatAt: "2026-01-02T00:00:00.000Z",
    });

    const changes = computePrTransitionDiff(before, after);
    expect(changes).toEqual([
      { field: "reviewState", oldValue: "pending", newValue: "in_progress" },
    ]);
  });

  test("null → value transition records oldValue null", () => {
    const changes = computePrTransitionDiff(
      pr({ commitSha: null }),
      pr({ commitSha: "abc123" }),
    );
    expect(changes).toEqual([
      { field: "commitSha", oldValue: null, newValue: "abc123" },
    ]);
  });

  test("value → null transition records newValue null", () => {
    const changes = computePrTransitionDiff(
      pr({ claimedBy: "agent-a" }),
      pr({ claimedBy: null }),
    );
    expect(changes).toEqual([
      { field: "claimedBy", oldValue: "agent-a", newValue: null },
    ]);
  });

  test("numeric and boolean fields are stringified", () => {
    const changes = computePrTransitionDiff(
      pr({ patchCycles: 0, blocked: false }),
      pr({ patchCycles: 1, blocked: true }),
    );
    const byField = Object.fromEntries(changes.map((c) => [c.field, c]));
    expect(byField.patchCycles).toEqual({
      field: "patchCycles",
      oldValue: "0",
      newValue: "1",
    });
    expect(byField.blocked).toEqual({
      field: "blocked",
      oldValue: "false",
      newValue: "true",
    });
  });

  test("system columns (createdAt/updatedAt/id) are never diffed", () => {
    const before = pr();
    const after = pr({
      id: "pr-2",
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
      updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(computePrTransitionDiff(before, after)).toEqual([]);
  });
});
