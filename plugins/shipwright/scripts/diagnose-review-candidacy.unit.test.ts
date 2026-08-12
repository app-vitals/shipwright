// Unit tests for diagnose-review-candidacy.ts — argv parsing, fetch
// orchestration, and output formatting for the RCO-1.4 on-demand candidacy
// diagnostic script.
//
// No real network calls: fetchPrInfo/queryPrRecord/queryTaskStatus/
// isBundleComplete/fetchPrReviews are all injected fakes, per this repo's
// test isolation convention (no mock.module(), no global.fetch overrides).

import { describe, expect, test } from "bun:test";
import type { LinkedTaskInfo } from "../../../agent/src/check-helpers.ts";
import type { PrReviewData } from "../../../agent/src/check-patch.ts";
import type { PrInfo, PrRecord } from "../../../agent/src/check-review.ts";
import {
  type DiagnoseDeps,
  diagnoseReviewCandidacy,
  formatTraceOutput,
  parseTargetArg,
} from "./diagnose-review-candidacy.ts";

// ─── Fixture helpers ────────────────────────────────────────────────────────

function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 66,
    title: "Add feature X",
    author: { login: "danmcaulay" },
    headRefName: "feat/x",
    headRefOid: "abc123def456",
    repo: "ok-wow/ok-wow-agency",
    isDraft: false,
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

async function defaultFetchPrReviews(): Promise<PrReviewData> {
  return {
    headRefOid: "abc123def456",
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
  };
}

function makeDeps(overrides: Partial<DiagnoseDeps> = {}): DiagnoseDeps {
  return {
    fetchPrInfo: async () => makePr(),
    queryPrRecord: async () => null,
    queryTaskStatus: async () => null,
    isBundleComplete: async () => true,
    fetchPrReviews: defaultFetchPrReviews,
    ...overrides,
  };
}

// ─── parseTargetArg ─────────────────────────────────────────────────────────

describe("parseTargetArg", () => {
  test("parses a well-formed org/repo#pr argument", () => {
    expect(parseTargetArg("ok-wow/ok-wow-agency#66")).toEqual({
      org: "ok-wow",
      repo: "ok-wow-agency",
      prNumber: 66,
    });
  });

  test("throws a clear error when the '#' separator is missing", () => {
    expect(() => parseTargetArg("ok-wow/ok-wow-agency66")).toThrow();
  });

  test("throws a clear error when the org/repo has no slash", () => {
    expect(() => parseTargetArg("ok-wow-agency#66")).toThrow();
  });

  test("throws a clear error when the PR number is not numeric", () => {
    expect(() => parseTargetArg("ok-wow/ok-wow-agency#abc")).toThrow();
  });

  test("throws a clear error on an empty string", () => {
    expect(() => parseTargetArg("")).toThrow();
  });
});

// ─── diagnoseReviewCandidacy ────────────────────────────────────────────────

describe("diagnoseReviewCandidacy", () => {
  const target = { org: "ok-wow", repo: "ok-wow-agency", prNumber: 66 };

  test("eligible PR: no exclusion applies", async () => {
    const deps = makeDeps({
      fetchPrInfo: async () => makePr({ headRefOid: "sha111" }),
      queryPrRecord: async () => null,
    });
    const result = await diagnoseReviewCandidacy(target, deps);
    expect(result.trace).toEqual({ check: "eligible" });
    expect(result.pr.number).toBe(66);
  });

  test("excluded: claimed by another agent", async () => {
    const record: PrRecord = {
      commitSha: null,
      reviewState: "pending",
      claimedBy: "agent-other",
    };
    const deps = makeDeps({
      fetchPrInfo: async () => makePr({ headRefOid: "sha111" }),
      queryPrRecord: async () => record,
    });
    const result = await diagnoseReviewCandidacy(target, deps);
    expect(result.trace).toEqual({
      check: "claimed",
      claimedBy: "agent-other",
    });
  });

  test("excluded: already-reviewed-terminal", async () => {
    const record: PrRecord = {
      commitSha: "sha111",
      reviewedCommitSha: "sha111",
      reviewState: "posted",
    };
    const deps = makeDeps({
      fetchPrInfo: async () => makePr({ headRefOid: "sha111" }),
      queryPrRecord: async () => record,
    });
    const result = await diagnoseReviewCandidacy(target, deps);
    expect(result.trace).toEqual({
      check: "already-reviewed-terminal",
      reviewedCommitSha: "sha111",
      headRefOid: "sha111",
      reviewState: "posted",
    });
  });

  test("excluded: task-blocked via linked task hitl:true", async () => {
    const linkedTask: LinkedTaskInfo = { status: "pr_open", hitl: true };
    const deps = makeDeps({
      fetchPrInfo: async () => makePr({ headRefOid: "sha111" }),
      queryTaskStatus: async () => linkedTask,
    });
    const result = await diagnoseReviewCandidacy(target, deps);
    expect(result.trace).toEqual({
      check: "task-blocked",
      hitl: true,
      taskStatus: "pr_open",
    });
  });

  test("excluded: already-reviewed-live via live GitHub review data", async () => {
    const deps = makeDeps({
      fetchPrInfo: async () => makePr({ headRefOid: "sha111" }),
      fetchPrReviews: async () => ({
        headRefOid: "sha111",
        reviews: {
          nodes: [
            {
              author: { login: "some-reviewer" },
              state: "APPROVED",
              submittedAt: "2026-07-15T10:00:00.000Z",
              commit: { oid: "sha111" },
              body: "LGTM",
            },
          ],
        },
        reviewThreads: { nodes: [] },
        comments: { nodes: [] },
      }),
    });
    const result = await diagnoseReviewCandidacy(target, deps);
    expect(result.trace).toEqual({
      check: "already-reviewed-live",
      classifiedState: "approved",
      hasFreshAuthorReply: false,
    });
  });

  test("uses fetchPrInfo with the parsed org/repo/prNumber", async () => {
    const calls: Array<[string, string, number]> = [];
    const deps = makeDeps({
      fetchPrInfo: async (org, repo, prNumber) => {
        calls.push([org, repo, prNumber]);
        return makePr({ headRefOid: "sha111" });
      },
    });
    await diagnoseReviewCandidacy(target, deps);
    expect(calls).toEqual([["ok-wow", "ok-wow-agency", 66]]);
  });
});

// ─── formatTraceOutput ──────────────────────────────────────────────────────

describe("formatTraceOutput", () => {
  test("formats an eligible trace", () => {
    const pr = makePr();
    const output = formatTraceOutput(pr, { check: "eligible" });
    expect(output).toContain("ok-wow/ok-wow-agency#66");
    expect(output).toContain("ELIGIBLE");
  });

  test("formats a claimed trace with the claimedBy field", () => {
    const pr = makePr();
    const output = formatTraceOutput(pr, {
      check: "claimed",
      claimedBy: "agent-other",
    });
    expect(output).toContain("claimed");
    expect(output).toContain("agent-other");
  });

  test("formats an already-reviewed-terminal trace with field values", () => {
    const pr = makePr();
    const output = formatTraceOutput(pr, {
      check: "already-reviewed-terminal",
      reviewedCommitSha: "sha111",
      headRefOid: "sha111",
      reviewState: "posted",
    });
    expect(output).toContain("already-reviewed-terminal");
    expect(output).toContain("sha111");
    expect(output).toContain("posted");
  });

  test("eligible and excluded outputs are distinguishable", () => {
    const pr = makePr();
    const eligible = formatTraceOutput(pr, { check: "eligible" });
    const excluded = formatTraceOutput(pr, {
      check: "task-blocked",
      hitl: true,
      taskStatus: "pr_open",
    });
    expect(eligible).not.toEqual(excluded);
    expect(eligible).toContain("ELIGIBLE");
    expect(excluded).not.toContain("ELIGIBLE");
  });
});
