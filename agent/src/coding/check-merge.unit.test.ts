/**
 * agent/src/coding/check-merge.unit.test.ts
 *
 * Unit tests for getMergeCandidates() — the merge-phase candidate provider
 * (MPD-1.3).
 */

import { describe, expect, test } from "bun:test";
import type { LinkedTaskInfo } from "./check-helpers.ts";
import type { CiRun, GhPr, GhReview } from "./check-merge.ts";
import {
  type CheckMergeDeps,
  getMergeCandidates,
  type PrRecord,
} from "./check-merge.ts";

const GREEN_CI_RUN: CiRun = {
  name: "ci",
  status: "completed",
  conclusion: "success",
  createdAt: "2026-05-01T00:00:00.000Z",
  workflow_id: 1,
  run_number: 1,
};

const REPO = "acme/example-repo";

function makeGhPr(overrides: Partial<GhPr> = {}): GhPr {
  return {
    number: 50,
    title: "Mergeable feature",
    headRefOid: "sha50",
    headRefName: "feat/example-branch",
    author: { login: "bodhi-agent" },
    reviewDecision: "APPROVED",
    createdAt: "2026-05-01T00:00:00.000Z",
    mergeStateStatus: null,
    ...overrides,
  };
}

interface Opts {
  prs?: GhPr[];
  reviews?: Record<number, GhReview[]>;
  selfReview?: boolean;
  ci?: CiRun[];
  task?: LinkedTaskInfo | null | "throw";
  record?: PrRecord | null;
  bundleComplete?: boolean;
  scoped?: string[];
}

function makeDeps(o: Opts = {}): CheckMergeDeps {
  return {
    getCurrentUser: async () => "bodhi-agent",
    isSelfReviewAllowed: async () => o.selfReview ?? true,
    getRepos: () => [REPO],
    getScopedRepos: () => o.scoped ?? [REPO],
    listOpenPrs: async () => o.prs ?? [makeGhPr()],
    fetchPrReviews: async (_o, _r, pr) => o.reviews?.[pr] ?? [],
    fetchCiRuns: async () => o.ci ?? [GREEN_CI_RUN],
    queryTaskStatus: async () => {
      if (o.task === "throw") throw new Error("boom");
      return o.task ?? null;
    },
    isBundleComplete: async () => o.bundleComplete ?? true,
    queryPrRecord: async () => o.record ?? null,
  };
}

describe("getMergeCandidates", () => {
  test("returns a merge-tagged candidate for a natively approved, green PR", async () => {
    const result = await getMergeCandidates(makeDeps());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: `${REPO}#50`,
      phase: "merge",
      commitSha: "sha50",
      authorLogin: "bodhi-agent",
      headRefName: "feat/example-branch",
    });
  });

  test("excludes unapproved PRs", async () => {
    const deps = makeDeps({ prs: [makeGhPr({ reviewDecision: null })] });
    expect(await getMergeCandidates(deps)).toEqual([]);
  });

  test("accepts a self-review APPROVE comment when self-review is allowed", async () => {
    const deps = makeDeps({
      prs: [makeGhPr({ reviewDecision: null })],
      reviews: {
        50: [
          {
            author: { login: "bodhi-agent" },
            body: "APPROVE",
            state: "COMMENTED",
          },
        ],
      },
    });
    expect(await getMergeCandidates(deps)).toHaveLength(1);
  });

  test("rejects a self-review APPROVE when self-review is disallowed", async () => {
    const deps = makeDeps({
      selfReview: false,
      prs: [makeGhPr({ reviewDecision: null })],
      reviews: {
        50: [
          {
            author: { login: "bodhi-agent" },
            body: "APPROVE",
            state: "COMMENTED",
          },
        ],
      },
    });
    expect(await getMergeCandidates(deps)).toEqual([]);
  });

  test("excludes PRs authored by someone else even when approved", async () => {
    const deps = makeDeps({ prs: [makeGhPr({ author: { login: "other" } })] });
    expect(await getMergeCandidates(deps)).toEqual([]);
  });

  test("excludes PRs with non-green CI", async () => {
    const deps = makeDeps({
      ci: [{ ...GREEN_CI_RUN, status: "in_progress", conclusion: null }],
    });
    expect(await getMergeCandidates(deps)).toEqual([]);
  });

  test("excludes DIRTY PRs", async () => {
    const deps = makeDeps({ prs: [makeGhPr({ mergeStateStatus: "DIRTY" })] });
    expect(await getMergeCandidates(deps)).toEqual([]);
  });

  test("excludes PRs whose linked task is blocked", async () => {
    const deps = makeDeps({ task: { status: "blocked" } });
    expect(await getMergeCandidates(deps)).toEqual([]);
  });

  test("logs the blocking task ids and skipReason when excluding a task-blocked PR (TLH-1.2)", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.join(" "));
    };
    try {
      const deps = makeDeps({
        task: {
          status: "pr_open",
          hitl: true,
          blockingTasks: [{ id: "T-9", status: "pr_open", hitl: true }],
        },
      });
      await getMergeCandidates(deps);
    } finally {
      console.log = orig;
    }
    const line = logs.find((l) => l.startsWith("[check-merge]"));
    expect(line).toContain('"taskIds":["T-9"]');
    expect(line).toContain(
      '"skipReason":"task-blocked:T-9(hitl,status=pr_open)"',
    );
  });

  test("excludes PRs whose linked task is hitl:true while pr_open", async () => {
    const deps = makeDeps({ task: { status: "pr_open", hitl: true } });
    expect(await getMergeCandidates(deps)).toEqual([]);
  });

  test("fails closed when the task-status lookup throws", async () => {
    const deps = makeDeps({ task: "throw" });
    expect(await getMergeCandidates(deps)).toEqual([]);
  });

  test("uses linked task createdAt as age, else PR createdAt", async () => {
    const withTask = await getMergeCandidates(
      makeDeps({
        task: { status: "pr_open", createdAt: "2026-01-01T00:00:00.000Z" },
      }),
    );
    expect(withTask[0].age).toBe("2026-01-01T00:00:00.000Z");
    const noTask = await getMergeCandidates(makeDeps());
    expect(noTask[0].age).toBe("2026-05-01T00:00:00.000Z");
  });

  test("excludes PRs with an incomplete bundle", async () => {
    expect(
      await getMergeCandidates(makeDeps({ bundleComplete: false })),
    ).toEqual([]);
  });

  test("excludes PRs with a claimedBy record", async () => {
    const deps = makeDeps({ record: { claimedBy: "agent-2" } });
    expect(await getMergeCandidates(deps)).toEqual([]);
  });

  test("excludes PRs whose PR record is blocked", async () => {
    const deps = makeDeps({ record: { blocked: true } });
    expect(await getMergeCandidates(deps)).toEqual([]);
  });

  test("excludes repos outside the configured scope", async () => {
    expect(await getMergeCandidates(makeDeps({ scoped: [] }))).toEqual([]);
  });
});
