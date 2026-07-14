/**
 * agent/src/check-deploy.unit.test.ts
 *
 * Unit tests for getDeployCandidates() — native port of
 * plugins/shipwright/scripts/check-deploy.ts's qualification logic.
 *
 * Ported from plugins/shipwright/scripts/check-deploy.test.ts, adjusted to
 * assert on the returned WorkPrCandidate[] array instead of {exit, output}.
 */

import { describe, expect, test } from "bun:test";
import type { TaskStatus } from "./check-helpers.ts";
import {
  type CheckDeployDeps,
  type CiRun,
  type GhPr,
  type GhReview,
  getDeployCandidates,
} from "./check-deploy.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGhPr(overrides: Partial<GhPr> = {}): GhPr {
  return {
    number: 50,
    headRefOid: "sha50",
    headRefName: "feat/example-branch",
    author: { login: "bodhi-agent" },
    reviewDecision: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    mergeStateStatus: null,
    ...overrides,
  };
}

interface MakeDepsOptions {
  repos?: string[];
  prs?: Record<string, GhPr[]>;
  reviews?: Record<number, GhReview[]>;
  ciRuns?: Record<string, CiRun[]>;
  currentUser?: string;
  isSelfReviewAllowed?: boolean;
  taskStatus?: Record<string, { status: TaskStatus; addedAt?: string } | null>;
}

function makeDeps({
  repos = ["acme/example-repo"],
  prs = {},
  reviews = {},
  ciRuns = {},
  currentUser = "bodhi-agent",
  isSelfReviewAllowed = true,
  taskStatus = {},
}: MakeDepsOptions = {}): CheckDeployDeps {
  return {
    getCurrentUser: () => currentUser,
    isSelfReviewAllowed,
    repos,
    fetchActiveDeployRuns: async () => [],
    listOpenPrs: async (repo: string) => prs[repo] ?? [],
    fetchCiRuns: async (
      _org: string,
      _repo: string,
      headSha: string,
    ): Promise<CiRun[]> => ciRuns[headSha] ?? [],
    fetchPrReviews: async (
      _org: string,
      _repo: string,
      pr: number,
    ): Promise<GhReview[]> => reviews[pr] ?? [],
    queryTaskStatus: async (repo: string, prNumber: number) => {
      const key = `${repo}#${prNumber}`;
      return taskStatus[key] ?? null;
    },
  };
}


// ─── Tests ────────────────────────────────────────────────────────────────────

describe("getDeployCandidates", () => {
  test("returns empty array when no repos are configured", async () => {
    const result = await getDeployCandidates(makeDeps({ repos: [] }));
    expect(result).toEqual([]);
  });

  test("returns empty array when repos are configured but no open PRs exist", async () => {
    const result = await getDeployCandidates(
      makeDeps({ repos: ["acme/example-repo"], prs: {} }),
    );
    expect(result).toEqual([]);
  });

  test("returns a candidate when PR is GitHub-approved and CI is green", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await getDeployCandidates(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "acme/example-repo#50",
      phase: "deploy",
    });
  });

  test("returns empty array when PR is not approved and no self-review", async () => {
    const pr = makeGhPr({ reviewDecision: null });
    const result = await getDeployCandidates(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result).toEqual([]);
  });

  test("returns a candidate when self-review: author is current user, allow_self_review=true, APPROVE in review body, CI green", async () => {
    const pr = makeGhPr({
      author: { login: "bodhi-agent" },
      reviewDecision: null,
    });
    const reviews: GhReview[] = [
      { author: { login: "bodhi-agent" }, body: "APPROVE", state: "COMMENTED" },
    ];
    const result = await getDeployCandidates(
      makeDeps({
        currentUser: "bodhi-agent",
        isSelfReviewAllowed: true,
        prs: { "acme/example-repo": [pr] },
        reviews: { 50: reviews },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result).toHaveLength(1);
  });

  test("returns empty array when self-review but allow_self_review=false", async () => {
    const pr = makeGhPr({
      author: { login: "bodhi-agent" },
      reviewDecision: null,
    });
    const reviews: GhReview[] = [
      { author: { login: "bodhi-agent" }, body: "APPROVE", state: "COMMENTED" },
    ];
    const result = await getDeployCandidates(
      makeDeps({
        currentUser: "bodhi-agent",
        isSelfReviewAllowed: false,
        prs: { "acme/example-repo": [pr] },
        reviews: { 50: reviews },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result).toEqual([]);
  });

  test("returns a candidate when self-review body uses markdown bold (**APPROVE**)", async () => {
    const pr = makeGhPr({
      author: { login: "bodhi-agent" },
      reviewDecision: null,
    });
    const reviews: GhReview[] = [
      {
        author: { login: "bodhi-agent" },
        body: "**APPROVE** — All acceptance criteria met.",
        state: "COMMENTED",
      },
    ];
    const result = await getDeployCandidates(
      makeDeps({
        currentUser: "bodhi-agent",
        isSelfReviewAllowed: true,
        prs: { "acme/example-repo": [pr] },
        reviews: { 50: reviews },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result).toHaveLength(1);
  });

  test("returns empty array when self-review allowed but no APPROVE in review body", async () => {
    const pr = makeGhPr({
      author: { login: "bodhi-agent" },
      reviewDecision: null,
    });
    const reviews: GhReview[] = [
      {
        author: { login: "bodhi-agent" },
        body: "Looks good, some minor nits",
        state: "COMMENTED",
      },
    ];
    const result = await getDeployCandidates(
      makeDeps({
        currentUser: "bodhi-agent",
        isSelfReviewAllowed: true,
        prs: { "acme/example-repo": [pr] },
        reviews: { 50: reviews },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result).toEqual([]);
  });

  test("returns a candidate when self-review body uses the narrative 'Verdict: APPROVE' label", async () => {
    const pr = makeGhPr({
      author: { login: "bodhi-agent" },
      reviewDecision: null,
    });
    const reviews: GhReview[] = [
      {
        author: { login: "bodhi-agent" },
        body: "All 5 acceptance criteria met. Verdict: APPROVE (posted as COMMENT — GitHub disallows self-approval via the API).",
        state: "COMMENTED",
      },
    ];
    const result = await getDeployCandidates(
      makeDeps({
        currentUser: "bodhi-agent",
        isSelfReviewAllowed: true,
        prs: { "acme/example-repo": [pr] },
        reviews: { 50: reviews },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result).toHaveLength(1);
  });

  test("returns empty array when self-review has a non-APPROVE verdict label", async () => {
    const pr = makeGhPr({
      author: { login: "bodhi-agent" },
      reviewDecision: null,
    });
    const reviews: GhReview[] = [
      {
        author: { login: "bodhi-agent" },
        body: "Found a blocking issue. Verdict: CHANGES_REQUESTED",
        state: "COMMENTED",
      },
    ];
    const result = await getDeployCandidates(
      makeDeps({
        currentUser: "bodhi-agent",
        isSelfReviewAllowed: true,
        prs: { "acme/example-repo": [pr] },
        reviews: { 50: reviews },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result).toEqual([]);
  });

  test("returns empty array when PR is approved but CI is not green (in_progress)", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await getDeployCandidates(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "in_progress", conclusion: null }] },
      }),
    );
    expect(result).toEqual([]);
  });

  test("returns empty array when PR is approved but CI failed", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await getDeployCandidates(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "failure" }] },
      }),
    );
    expect(result).toEqual([]);
  });

  test("returns empty array when PR is approved but no CI run exists", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await getDeployCandidates(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: {},
      }),
    );
    expect(result).toEqual([]);
  });

  test("PRs with no corresponding task-store record are correctly identified as deploy-ready", async () => {
    const pr = makeGhPr({
      number: 999,
      headRefOid: "sha999",
      reviewDecision: "APPROVED",
    });
    const result = await getDeployCandidates(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha999: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result).toHaveLength(1);
  });

  test("returns candidates found in a second repo when first repo has no ready PRs (collects across repos)", async () => {
    const pr1 = makeGhPr({
      number: 10,
      headRefOid: "sha10",
      reviewDecision: "REVIEW_REQUIRED",
    });
    const pr2 = makeGhPr({
      number: 20,
      headRefOid: "sha20",
      reviewDecision: "APPROVED",
    });
    const result = await getDeployCandidates(
      makeDeps({
        repos: ["acme/example-repo", "acme/other-repo"],
        prs: {
          "acme/example-repo": [pr1],
          "acme/other-repo": [pr2],
        },
        ciRuns: { sha20: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("acme/other-repo#20");
  });

  test("logs to stderr and continues to next repo when gh query throws for a repo", async () => {
    const pr = makeGhPr({
      number: 50,
      headRefOid: "sha50",
      reviewDecision: "APPROVED",
    });

    const stderrLines: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: patching write for test capture
    process.stderr.write = (chunk: any, ...rest: any[]) => {
      stderrLines.push(String(chunk));
      return origStderr(chunk, ...rest);
    };

    const deps: CheckDeployDeps = {
      getCurrentUser: () => "bodhi-agent",
      isSelfReviewAllowed: true,
      repos: ["acme/failing-repo", "acme/example-repo"],
      fetchActiveDeployRuns: async () => [],
      listOpenPrs: async (repo: string): Promise<GhPr[]> => {
        if (repo === "acme/failing-repo") throw new Error("rate limited");
        return [pr];
      },
      fetchCiRuns: async (
        _org: string,
        _repo: string,
        headSha: string,
      ): Promise<CiRun[]> => {
        return headSha === "sha50"
          ? [{ status: "completed", conclusion: "success" }]
          : [];
      },
      fetchPrReviews: async (): Promise<GhReview[]> => [],
    };

    const result = await getDeployCandidates(deps);
    process.stderr.write = origStderr;

    expect(result).toHaveLength(1);
    expect(stderrLines.some((l) => l.includes("acme/failing-repo"))).toBe(
      true,
    );
  });

  // ─── collect-all behavior (WL-2.2 architectural difference) ──────────────

  test("returns ALL qualifying PRs across multiple repos, not just the first (no early-return)", async () => {
    const pr1 = makeGhPr({
      number: 1,
      headRefOid: "sha1",
      reviewDecision: "APPROVED",
    });
    const pr2 = makeGhPr({
      number: 2,
      headRefOid: "sha2",
      reviewDecision: "APPROVED",
    });
    const pr3 = makeGhPr({
      number: 3,
      headRefOid: "sha3",
      reviewDecision: "APPROVED",
    });
    const result = await getDeployCandidates(
      makeDeps({
        repos: ["acme/repo-a", "acme/repo-b", "acme/repo-c"],
        prs: {
          "acme/repo-a": [pr1],
          "acme/repo-b": [pr2],
          "acme/repo-c": [pr3],
        },
        ciRuns: {
          sha1: [{ status: "completed", conclusion: "success" }],
          sha2: [{ status: "completed", conclusion: "success" }],
          sha3: [{ status: "completed", conclusion: "success" }],
        },
      }),
    );
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.id)).toEqual([
      "acme/repo-a#1",
      "acme/repo-b#2",
      "acme/repo-c#3",
    ]);
  });

  // ─── busy-repo skip ────────────────────────────────────────────────────────

  test("skips a repo with an active Deploy workflow run without blocking other repos", async () => {
    const pr1 = makeGhPr({
      number: 1,
      headRefOid: "sha1",
      reviewDecision: "APPROVED",
    });
    const pr2 = makeGhPr({
      number: 2,
      headRefOid: "sha2",
      reviewDecision: "APPROVED",
    });
    const deps: CheckDeployDeps = {
      getCurrentUser: () => "bodhi-agent",
      isSelfReviewAllowed: true,
      repos: ["acme/busy-repo", "acme/free-repo"],
      fetchActiveDeployRuns: async (_org, repo) =>
        repo === "busy-repo" ? [{ name: "Deploy", status: "in_progress" }] : [],
      listOpenPrs: async (repo: string) =>
        repo === "acme/busy-repo" ? [pr1] : [pr2],
      fetchCiRuns: async () => [{ status: "completed", conclusion: "success" }],
      fetchPrReviews: async () => [],
    };
    const result = await getDeployCandidates(deps);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("acme/free-repo#2");
  });

  // ─── age field sourcing ────────────────────────────────────────────────────

  test("age is sourced from the linked task's addedAt when a task is linked", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED", createdAt: "2026-06-01T00:00:00.000Z" });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryTaskStatus = async () => ({
      status: "in_progress",
      addedAt: "2026-05-01T00:00:00.000Z",
    });
    const result = await getDeployCandidates(deps);
    expect(result[0].age).toBe("2026-05-01T00:00:00.000Z");
  });

  test("age falls back to PR createdAt when no task is linked (queryTaskStatus resolves null)", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED", createdAt: "2026-06-01T00:00:00.000Z" });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryTaskStatus = async () => null;
    const result = await getDeployCandidates(deps);
    expect(result[0].age).toBe("2026-06-01T00:00:00.000Z");
  });

  test("queryPrRecord's readyForDeployAt is never used for age sourcing", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED", createdAt: "2026-06-01T00:00:00.000Z" });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryTaskStatus = async () => ({
      status: "in_progress",
      addedAt: "2026-05-01T00:00:00.000Z",
    });
    deps.queryPrRecord = async () => ({
      readyForDeployAt: "2026-05-20T00:00:00.000Z",
      claimedBy: null,
    });
    const result = await getDeployCandidates(deps);
    expect(result[0].age).not.toBe("2026-05-20T00:00:00.000Z");
    expect(result[0].age).toBe("2026-05-01T00:00:00.000Z");
  });

  // ─── mergeStateStatus DIRTY exclusion ──────────────────────────────────

  test("APPROVED + green CI + mergeStateStatus DIRTY is excluded from candidates", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      mergeStateStatus: "DIRTY",
    });
    const result = await getDeployCandidates(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result).toEqual([]);
  });

  // ─── task-blocked status exclusion ────────────────────────────────────

  test("APPROVED + green CI + clean merge state but linked task status blocked is excluded from candidates", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
    });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryTaskStatus = async () => ({ status: "blocked" });
    const result = await getDeployCandidates(deps);
    expect(result).toEqual([]);
  });

  test("APPROVED + green CI + no linked task found (null) does not exclude the PR", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
    });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryTaskStatus = async () => null;
    const result = await getDeployCandidates(deps);
    expect(result).toHaveLength(1);
  });

  test("APPROVED + green CI + task-status lookup throws excludes the PR (fail-closed) and logs to stderr", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
    });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryTaskStatus = async () => {
      throw new Error("task-store unreachable");
    };

    const stderrLines: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: patching write for test capture
    process.stderr.write = (chunk: any, ...rest: any[]) => {
      stderrLines.push(String(chunk));
      return origStderr(chunk, ...rest);
    };

    const result = await getDeployCandidates(deps);
    process.stderr.write = origStderr;

    expect(result).toEqual([]);
    expect(
      stderrLines.some(
        (l) =>
          l.includes("task-status lookup failed") &&
          l.includes("task-store unreachable"),
      ),
    ).toBe(true);
  });
});
