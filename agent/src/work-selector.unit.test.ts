/**
 * agent/src/work-selector.unit.test.ts
 *
 * Unit tests for the selectNextWorkItem() pure helper.
 * No I/O — pure logic only.
 */

import { describe, expect, it } from "bun:test";
import {
  selectNextWorkItem,
  type WorkPrCandidate,
  type WorkTaskCandidate,
} from "./work-selector.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<WorkTaskCandidate> = {}): WorkTaskCandidate {
  return {
    id: "task-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makePr(
  overrides: Partial<WorkPrCandidate> = {},
): WorkPrCandidate {
  return {
    id: "pr-1",
    age: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("selectNextWorkItem", () => {
  it("returns null when both lists are empty", () => {
    expect(selectNextWorkItem([], [])).toBeNull();
  });

  it("returns the oldest task when only tasks are ready", () => {
    const older = makeTask({ id: "t-older", createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = makeTask({ id: "t-newer", createdAt: "2026-01-02T00:00:00.000Z" });
    const result = selectNextWorkItem([newer, older], []);
    expect(result).toEqual({ type: "task", task: older });
  });

  it("returns the oldest PR when only PRs are ready", () => {
    const older = makePr({ id: "pr-older", age: "2026-01-01T00:00:00.000Z" });
    const newer = makePr({ id: "pr-newer", age: "2026-01-02T00:00:00.000Z" });
    const result = selectNextWorkItem([], [newer, older]);
    expect(result).toEqual({ type: "pr", pr: older });
  });

  it("picks the oldest item across both entity types — strict FIFO, no phase bias", () => {
    const task = makeTask({ id: "t1", createdAt: "2026-01-02T00:00:00.000Z" });
    const olderPr = makePr({ id: "pr1", age: "2026-01-01T00:00:00.000Z" });
    const result = selectNextWorkItem([task], [olderPr]);
    expect(result).toEqual({ type: "pr", pr: olderPr });
  });

  it("picks the older task over a newer PR", () => {
    const olderTask = makeTask({ id: "t1", createdAt: "2026-01-01T00:00:00.000Z" });
    const newerPr = makePr({ id: "pr1", age: "2026-01-02T00:00:00.000Z" });
    const result = selectNextWorkItem([olderTask], [newerPr]);
    expect(result).toEqual({ type: "task", task: olderTask });
  });

  it("selects a PR candidate purely on age, with no local claim re-validation", () => {
    // Regression guard: getReviewCandidates/getPatchCandidates/getDeployCandidates
    // (LPF-2.2) now only ever return unclaimed PRs (server-side ?ready=true
    // filtering), so a WorkPrCandidate no longer carries a claimedBy field at
    // all. The selector must not re-derive or check claim status locally — a
    // PR candidate is selectable purely on age, the same trust level task
    // candidates already get.
    const older = makePr({ id: "pr-older", age: "2026-01-01T00:00:00.000Z" });
    const newer = makePr({ id: "pr-newer", age: "2026-01-02T00:00:00.000Z" });
    const result = selectNextWorkItem([], [newer, older]);
    expect(result).toEqual({ type: "pr", pr: older });
  });

  it("selects strictly by age across a larger mixed fixture set", () => {
    const t1 = makeTask({ id: "t1", createdAt: "2026-03-01T00:00:00.000Z" });
    const t2 = makeTask({ id: "t2", createdAt: "2026-01-15T00:00:00.000Z" });
    const pr1 = makePr({ id: "pr1", age: "2026-02-01T00:00:00.000Z" });
    const pr2 = makePr({ id: "pr2", age: "2026-01-10T00:00:00.000Z" });
    const result = selectNextWorkItem([t1, t2], [pr1, pr2]);
    // pr2 (2026-01-10) is the oldest overall now that claim-filtering is
    // removed — previously this fixture set claimedBy'd pr2 to force t2 to
    // win; that's no longer a thing the selector does.
    expect(result).toEqual({ type: "pr", pr: pr2 });
  });

  it("carries the phase field through unchanged to the winning PR", () => {
    const pr = makePr({ id: "pr1", age: "2026-01-01T00:00:00.000Z", phase: "review" });
    const result = selectNextWorkItem([], [pr]);
    expect(result).toEqual({ type: "pr", pr: expect.objectContaining({ phase: "review" }) });
  });

  it("ranks by age regardless of phase — older review-phase beats newer deploy-phase", () => {
    const olderReview = makePr({ id: "pr-older", age: "2026-01-01T00:00:00.000Z", phase: "review" });
    const newerDeploy = makePr({ id: "pr-newer", age: "2026-01-02T00:00:00.000Z", phase: "deploy" });
    const result = selectNextWorkItem([], [newerDeploy, olderReview]);
    expect(result).toEqual({ type: "pr", pr: olderReview });
    expect(result?.type === "pr" && result.pr.phase).toBe("review");
  });

  it("handles PR without phase set (undefined) in ranking correctly", () => {
    const older = makePr({ id: "pr-older", age: "2026-01-01T00:00:00.000Z" });
    const newer = makePr({ id: "pr-newer", age: "2026-01-02T00:00:00.000Z", phase: "patch" });
    const result = selectNextWorkItem([], [newer, older]);
    expect(result).toEqual({ type: "pr", pr: older });
    expect(result?.type === "pr" && result.pr.phase).toBeUndefined();
  });
});
