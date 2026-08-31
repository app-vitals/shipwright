/**
 * agent/src/check-deploy.unit.test.ts
 *
 * Unit tests for getDeployCandidates() — native port of
 * plugins/shipwright/scripts/check-deploy.ts's qualification logic.
 *
 * Ported from plugins/shipwright/scripts/check-deploy.unit.test.ts, adjusted to
 * assert on the returned WorkPrCandidate[] array instead of {exit, output}.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckDeployDeps,
  type CiRun,
  type GhPr,
  type GhReview,
  buildProductionDeps,
  getDeployCandidates,
  isHeldByLabel,
} from "./check-deploy.ts";
import type { LinkedTaskInfo } from "./check-helpers.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGhPr(overrides: Partial<GhPr> = {}): GhPr {
  return {
    number: 50,
    title: "Deploy-ready feature",
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
  isSelfReviewAllowed?: boolean | (() => boolean);
  taskStatus?: Record<string, LinkedTaskInfo | null>;
  getScopedRepos?: () => string[];
  hasScopeSynced?: () => boolean;
  isBundleComplete?: (branch: string) => Promise<boolean>;
  isAutoMergeAnyAuthorRepo?: (repo: string) => boolean;
  getAutoMergeHoldLabel?: () => string;
}

function makeDeps({
  repos = ["acme/example-repo"],
  prs = {},
  reviews = {},
  ciRuns = {},
  currentUser = "bodhi-agent",
  isSelfReviewAllowed = true,
  taskStatus = {},
  getScopedRepos = () => repos,
  hasScopeSynced = () => true,
  isBundleComplete,
  isAutoMergeAnyAuthorRepo = () => false,
  getAutoMergeHoldLabel = () => "",
}: MakeDepsOptions = {}): CheckDeployDeps {
  return {
    getCurrentUser: async () => currentUser,
    isSelfReviewAllowed:
      typeof isSelfReviewAllowed === "function"
        ? isSelfReviewAllowed
        : () => isSelfReviewAllowed,
    repos,
    getScopedRepos,
    hasScopeSynced,
    isAutoMergeAnyAuthorRepo,
    getAutoMergeHoldLabel,
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
    ...(isBundleComplete ? { isBundleComplete } : {}),
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
      title: "Deploy-ready feature",
      commitSha: "sha50",
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

  test("logs via console.warn and continues to next repo when gh query throws for a repo", async () => {
    // LPF-5.1: repo-tolerant collection now goes through mapReposTolerant,
    // which logs the per-repo failure via console.warn (a handled/swallowed
    // condition) rather than process.stderr.write.
    const pr = makeGhPr({
      number: 50,
      headRefOid: "sha50",
      reviewDecision: "APPROVED",
    });

    const warnCalls: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };

    const deps: CheckDeployDeps = {
      getCurrentUser: async () => "bodhi-agent",
      isSelfReviewAllowed: () => true,
      repos: ["acme/failing-repo", "acme/example-repo"],
      getScopedRepos: () => ["acme/failing-repo", "acme/example-repo"],
      hasScopeSynced: () => true,
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
    console.warn = origWarn;

    expect(result).toHaveLength(1);
    expect(
      warnCalls.some(([message]) =>
        String(message).includes("acme/failing-repo"),
      ),
    ).toBe(true);
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
    expect(result.map((c) => c.commitSha)).toEqual(["sha1", "sha2", "sha3"]);
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
      getCurrentUser: async () => "bodhi-agent",
      isSelfReviewAllowed: () => true,
      repos: ["acme/busy-repo", "acme/free-repo"],
      getScopedRepos: () => ["acme/busy-repo", "acme/free-repo"],
      hasScopeSynced: () => true,
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
    expect(result[0].commitSha).toBe("sha2");
  });

  // ─── stale-queued-run handling (isActiveRun) ──────────────────────────────

  test("a queued Deploy run with no createdAt is treated conservatively as active (blocks the repo)", async () => {
    const pr1 = makeGhPr({ number: 1, headRefOid: "sha1" });
    const deps: CheckDeployDeps = {
      getCurrentUser: async () => "bodhi-agent",
      isSelfReviewAllowed: () => true,
      repos: ["acme/example-repo"],
      getScopedRepos: () => ["acme/example-repo"],
      hasScopeSynced: () => true,
      clock: () => "2026-06-01T00:00:00.000Z",
      fetchActiveDeployRuns: async () => [
        { name: "Deploy", status: "queued" }, // no createdAt
      ],
      listOpenPrs: async () => [pr1],
      fetchCiRuns: async () => [{ status: "completed", conclusion: "success" }],
      fetchPrReviews: async () => [],
    };
    const result = await getDeployCandidates(deps);
    expect(result).toEqual([]);
  });

  test("a queued Deploy run older than 1 hour is treated as stale/ghost and does not block the repo", async () => {
    const pr1 = makeGhPr({
      number: 1,
      headRefOid: "sha1",
      reviewDecision: "APPROVED",
    });
    const deps: CheckDeployDeps = {
      getCurrentUser: async () => "bodhi-agent",
      isSelfReviewAllowed: () => true,
      repos: ["acme/example-repo"],
      getScopedRepos: () => ["acme/example-repo"],
      hasScopeSynced: () => true,
      clock: () => "2026-06-01T02:00:00.000Z",
      fetchActiveDeployRuns: async () => [
        {
          name: "Deploy",
          status: "queued",
          createdAt: "2026-06-01T00:00:00.000Z", // 2h old, older than 1h threshold
        },
      ],
      listOpenPrs: async () => [pr1],
      fetchCiRuns: async () => [{ status: "completed", conclusion: "success" }],
      fetchPrReviews: async () => [],
    };
    const result = await getDeployCandidates(deps);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("acme/example-repo#1");
  });

  test("a queued Deploy run under 1 hour old still blocks the repo", async () => {
    const pr1 = makeGhPr({
      number: 1,
      headRefOid: "sha1",
      reviewDecision: "APPROVED",
    });
    const deps: CheckDeployDeps = {
      getCurrentUser: async () => "bodhi-agent",
      isSelfReviewAllowed: () => true,
      repos: ["acme/example-repo"],
      getScopedRepos: () => ["acme/example-repo"],
      hasScopeSynced: () => true,
      clock: () => "2026-06-01T00:30:00.000Z",
      fetchActiveDeployRuns: async () => [
        {
          name: "Deploy",
          status: "queued",
          createdAt: "2026-06-01T00:00:00.000Z", // 30min old, under 1h threshold
        },
      ],
      listOpenPrs: async () => [pr1],
      fetchCiRuns: async () => [{ status: "completed", conclusion: "success" }],
      fetchPrReviews: async () => [],
    };
    const result = await getDeployCandidates(deps);
    expect(result).toEqual([]);
  });

  // ─── per-PR error handling ─────────────────────────────────────────────────

  test("logs to stderr and excludes only the failing PR when a per-PR query throws (other PRs still qualify)", async () => {
    const goodPr = makeGhPr({
      number: 1,
      headRefOid: "sha1",
      reviewDecision: "APPROVED",
    });
    const badPr = makeGhPr({
      number: 2,
      headRefOid: "sha2",
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
      getCurrentUser: async () => "bodhi-agent",
      isSelfReviewAllowed: () => true,
      repos: ["acme/example-repo"],
      getScopedRepos: () => ["acme/example-repo"],
      hasScopeSynced: () => true,
      fetchActiveDeployRuns: async () => [],
      listOpenPrs: async () => [goodPr, badPr],
      fetchCiRuns: async (_org, _repo, headSha: string) => {
        if (headSha === "sha2") throw new Error("gh api rate limited");
        return [{ status: "completed", conclusion: "success" }];
      },
      fetchPrReviews: async () => [],
    };

    const result = await getDeployCandidates(deps);
    process.stderr.write = origStderr;

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("acme/example-repo#1");
    expect(
      stderrLines.some(
        (l) =>
          l.includes("gh query failed for PR 2") &&
          l.includes("gh api rate limited"),
      ),
    ).toBe(true);
  });

  // ─── age field sourcing ────────────────────────────────────────────────────

  test("age is sourced from the linked task's createdAt when a task is linked", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryTaskStatus = async () => ({
      status: "in_progress",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    const result = await getDeployCandidates(deps);
    expect(result[0].age).toBe("2026-05-01T00:00:00.000Z");
  });

  test("age falls back to PR createdAt when no task is linked (queryTaskStatus resolves null)", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryTaskStatus = async () => null;
    const result = await getDeployCandidates(deps);
    expect(result[0].age).toBe("2026-06-01T00:00:00.000Z");
  });

  test("queryPrRecord's readyForDeployAt is never used for age sourcing", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryTaskStatus = async () => ({
      status: "in_progress",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    deps.queryPrRecord = async () => ({
      readyForDeployAt: "2026-05-20T00:00:00.000Z",
    });
    const result = await getDeployCandidates(deps);
    expect(result[0].age).not.toBe("2026-05-20T00:00:00.000Z");
    expect(result[0].age).toBe("2026-05-01T00:00:00.000Z");
  });

  // ─── claim gating (LPF-2.2) ────────────────────────────────────────────────

  test("excludes a PR whose task-store record has claimedBy set, even though it is otherwise approved with green CI", async () => {
    // Regression guard for the LPF-2.2 trap: a record with claimedBy set
    // means another agent currently holds the claim on this PR — excluded,
    // mirroring check-review.ts.
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryPrRecord = async () => ({ claimedBy: "agent-other" });
    const result = await getDeployCandidates(deps);
    expect(result).toEqual([]);
  });

  test("does NOT exclude a PR when queryPrRecord resolves null (no record yet — e.g. self-authored PR skipped by claim() under allow_self_review: false)", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryPrRecord = async () => null;
    const result = await getDeployCandidates(deps);
    expect(result).toHaveLength(1);
  });

  test("does NOT exclude a PR when queryPrRecord throws (transient task-store error) — falls back to createdAt", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryPrRecord = async () => {
      throw new Error("task-store unavailable");
    };
    const result = await getDeployCandidates(deps);
    expect(result).toHaveLength(1);
  });

  test("excludes a PR whose PR-record has blocked:true, even when there is no linked task at all (PRB-2.4, PRB-3.1 Step 5a.7 escalation)", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryTaskStatus = async () => null;
    deps.queryPrRecord = async () => ({ blocked: true });
    const result = await getDeployCandidates(deps);
    expect(result).toEqual([]);
  });

  test("does NOT exclude a PR whose PR-record has blocked:false and no linked task", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryTaskStatus = async () => null;
    deps.queryPrRecord = async () => ({ blocked: false });
    const result = await getDeployCandidates(deps);
    expect(result).toHaveLength(1);
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

  // ─── task hitl:true exclusion (CBD-2.2) ─────────────────────────────────

  test("APPROVED + green CI + linked task hitl:true is excluded from candidates, even with status pr_open (not blocked)", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
    });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryTaskStatus = async () => ({ status: "pr_open", hitl: true });
    const result = await getDeployCandidates(deps);
    expect(result).toEqual([]);
  });

  test("APPROVED + green CI + linked task hitl:false is still an eligible candidate", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
    });
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.queryTaskStatus = async () => ({ status: "pr_open", hitl: false });
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

  // ─── agent-scope filtering (WL-4.3) ──────────────────────────────────────

  test("excludes a repo returned by the local-clone scan (deps.repos) but absent from getScopedRepos()", async () => {
    const inScopePr = makeGhPr({
      number: 50,
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
    });
    const outOfScopePr = makeGhPr({
      number: 60,
      headRefOid: "sha60",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
    });
    const result = await getDeployCandidates(
      makeDeps({
        repos: ["acme/in-scope", "acme/out-of-scope"],
        prs: {
          "acme/in-scope": [inScopePr],
          "acme/out-of-scope": [outOfScopePr],
        },
        ciRuns: {
          sha50: [{ status: "completed", conclusion: "success" }],
          sha60: [{ status: "completed", conclusion: "success" }],
        },
        getScopedRepos: () => ["acme/in-scope"],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("acme/in-scope#50");
    expect(result[0].commitSha).toBe("sha50");
  });

  test("re-evaluates getScopedRepos() on every call — a scope change between two calls changes the result on the second call", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
    });
    let scope: string[] = [];
    const deps = makeDeps({
      repos: ["acme/newly-added"],
      prs: { "acme/newly-added": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      getScopedRepos: () => scope,
    });

    const first = await getDeployCandidates(deps);
    expect(first).toEqual([]);

    scope = ["acme/newly-added"];
    const second = await getDeployCandidates(deps);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe("acme/newly-added#50");
  });

  test("fails open (does not filter) when hasScopeSynced() is false, even if getScopedRepos() would otherwise exclude everything", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
    });
    const result = await getDeployCandidates(
      makeDeps({
        repos: ["acme/never-synced"],
        prs: { "acme/never-synced": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        getScopedRepos: () => [],
        hasScopeSynced: () => false,
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("acme/never-synced#50");
  });

  test("filters normally when hasScopeSynced() is true, even if the synced scope is a deliberately empty list", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
    });
    const result = await getDeployCandidates(
      makeDeps({
        repos: ["acme/some-repo"],
        prs: { "acme/some-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        getScopedRepos: () => [],
        hasScopeSynced: () => true,
      }),
    );
    expect(result).toEqual([]);
  });

  test("excludes a PR when isBundleComplete resolves false for its branch", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      headRefName: "feat/bundle-incomplete",
    });
    const result = await getDeployCandidates(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        isBundleComplete: async (branch: string) =>
          branch !== "feat/bundle-incomplete",
      }),
    );
    expect(result).toEqual([]);
  });

  test("includes a PR when isBundleComplete resolves true for its branch", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      headRefName: "feat/bundle-complete",
    });
    const result = await getDeployCandidates(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        isBundleComplete: async (branch: string) =>
          branch === "feat/bundle-complete",
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("acme/example-repo#50");
  });

  // ─── AM-1: scoped any-author auto-merge + hold-label support ─────────────

  test("AC1: a non-agent-authored, approved, CI-green PR in a repo ON auto_merge_any_author_repos becomes a candidate", async () => {
    const pr = makeGhPr({
      author: { login: "some-human" },
      reviewDecision: "APPROVED",
    });
    const result = await getDeployCandidates(
      makeDeps({
        currentUser: "bodhi-agent",
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        isAutoMergeAnyAuthorRepo: (repo) => repo === "acme/example-repo",
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("acme/example-repo#50");
  });

  test("AC2 (regression): the same non-agent-authored PR shape in a repo NOT on auto_merge_any_author_repos is still excluded", async () => {
    const pr = makeGhPr({
      author: { login: "some-human" },
      reviewDecision: "APPROVED",
    });
    const result = await getDeployCandidates(
      makeDeps({
        currentUser: "bodhi-agent",
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        isAutoMergeAnyAuthorRepo: (repo) => repo === "acme/some-other-repo",
      }),
    );
    expect(result).toEqual([]);
  });

  test("AC2 (regression): non-agent-authored PR is excluded when isAutoMergeAnyAuthorRepo is entirely absent from deps", async () => {
    const pr = makeGhPr({
      author: { login: "some-human" },
      reviewDecision: "APPROVED",
    });
    const deps = makeDeps({
      currentUser: "bodhi-agent",
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.isAutoMergeAnyAuthorRepo = undefined;
    const result = await getDeployCandidates(deps);
    expect(result).toEqual([]);
  });

  test("AC3: a PR carrying the hold label is excluded from candidacy even when approved + CI green", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      labels: [{ name: "do-not-merge" }],
    });
    const result = await getDeployCandidates(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        getAutoMergeHoldLabel: () => "do-not-merge",
      }),
    );
    expect(result).toEqual([]);
  });

  test("AC3: a PR without the hold label is unaffected when auto_merge_hold_label is set", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      labels: [{ name: "some-other-label" }],
    });
    const result = await getDeployCandidates(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        getAutoMergeHoldLabel: () => "do-not-merge",
      }),
    );
    expect(result).toHaveLength(1);
  });

  test("AC3: hold label matching is exact-string (case-sensitive), mirroring check-review.ts's automated-label precedent", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      labels: [{ name: "Do-Not-Merge" }],
    });
    const result = await getDeployCandidates(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        getAutoMergeHoldLabel: () => "do-not-merge",
      }),
    );
    expect(result).toHaveLength(1);
  });

  test("AC5 (regression): candidate selection across the agent's full repo set is unchanged when both new fields are unset", async () => {
    // Representative of every production repo this agent tracks — none of
    // them has opted into either new policy field.
    for (const repo of [
      "acme/repo-alpha",
      "acme/repo-beta",
      "acme/repo-gamma",
      "acme/repo-delta",
    ]) {
      // Same-author, approved, CI-green PR: still a candidate.
      const agentPr = makeGhPr({
        number: 1,
        headRefOid: "sha-agent",
        author: { login: "bodhi-agent" },
        reviewDecision: "APPROVED",
      });
      const agentResult = await getDeployCandidates(
        makeDeps({
          repos: [repo],
          currentUser: "bodhi-agent",
          prs: { [repo]: [agentPr] },
          ciRuns: {
            "sha-agent": [{ status: "completed", conclusion: "success" }],
          },
          isAutoMergeAnyAuthorRepo: () => false,
          getAutoMergeHoldLabel: () => "",
        }),
      );
      expect(agentResult).toHaveLength(1);
      expect(agentResult[0].id).toBe(`${repo}#1`);

      // Non-agent-authored, approved, CI-green PR: still excluded (hard
      // authorship filter unchanged when the repo has not opted in).
      const humanPr = makeGhPr({
        number: 2,
        headRefOid: "sha-human",
        author: { login: "some-human" },
        reviewDecision: "APPROVED",
      });
      const humanResult = await getDeployCandidates(
        makeDeps({
          repos: [repo],
          currentUser: "bodhi-agent",
          prs: { [repo]: [humanPr] },
          ciRuns: {
            "sha-human": [{ status: "completed", conclusion: "success" }],
          },
          isAutoMergeAnyAuthorRepo: () => false,
          getAutoMergeHoldLabel: () => "",
        }),
      );
      expect(humanResult).toEqual([]);

      // A PR carrying some arbitrary label is unaffected when no hold label
      // is configured.
      const labeledPr = makeGhPr({
        number: 3,
        headRefOid: "sha-labeled",
        author: { login: "bodhi-agent" },
        reviewDecision: "APPROVED",
        labels: [{ name: "do-not-merge" }],
      });
      const labeledResult = await getDeployCandidates(
        makeDeps({
          repos: [repo],
          currentUser: "bodhi-agent",
          prs: { [repo]: [labeledPr] },
          ciRuns: {
            "sha-labeled": [{ status: "completed", conclusion: "success" }],
          },
          isAutoMergeAnyAuthorRepo: () => false,
          getAutoMergeHoldLabel: () => "",
        }),
      );
      expect(labeledResult).toHaveLength(1);
      expect(labeledResult[0].id).toBe(`${repo}#3`);
    }
  });

  test("AC5 (regression): behavior unchanged when isAutoMergeAnyAuthorRepo/getAutoMergeHoldLabel are entirely absent from deps", async () => {
    const agentPr = makeGhPr({ reviewDecision: "APPROVED" });
    const deps = makeDeps({
      currentUser: "bodhi-agent",
      prs: { "acme/example-repo": [agentPr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });
    deps.isAutoMergeAnyAuthorRepo = undefined;
    deps.getAutoMergeHoldLabel = undefined;
    const result = await getDeployCandidates(deps);
    expect(result).toHaveLength(1);
  });
});

// ─── buildProductionDeps ────────────────────────────────────────────────────
//
// Exercises the closures buildProductionDeps wires up against a fake ghJson
// (no real `gh` process) — same injection pattern as
// check-patch.unit.test.ts's buildProductionDeps suite. Downstream helpers
// they delegate to (createBundleCompleteQuery, createPrRecordQuery,
// createTaskStatusQuery) are already covered by their own dedicated tests in
// check-helpers.unit.test.ts and are not re-verified here.
describe("buildProductionDeps", () => {
  let savedWorkspacePath: string | undefined;
  let savedAgentHome: string | undefined;

  beforeEach(() => {
    savedWorkspacePath = process.env.WORKSPACE_PATH;
    savedAgentHome = process.env.AGENT_HOME;
    // Point resolveWorkspacePath() at a directory with no repos/ subfolder,
    // so resolveAllRepos() deterministically returns [] — these tests call
    // the deps' functions directly rather than exercising the repo scan.
    process.env.WORKSPACE_PATH = "/tmp/check-deploy-buildProductionDeps-stub";
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.AGENT_HOME;
  });

  afterEach(() => {
    if (savedWorkspacePath !== undefined) {
      process.env.WORKSPACE_PATH = savedWorkspacePath;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.WORKSPACE_PATH;
    }
    if (savedAgentHome !== undefined) {
      process.env.AGENT_HOME = savedAgentHome;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.AGENT_HOME;
    }
  });

  test("repos reflects an empty scan when WORKSPACE_PATH has no repos/ subfolder", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>() => [] as unknown as T,
    });
    expect(deps.repos).toEqual([]);
  });

  test("repos reflects a real repos/ scan under WORKSPACE_PATH", async () => {
    const scratchDir = mkdtempSync(
      join(tmpdir(), "check-deploy-buildProductionDeps-"),
    );
    try {
      const repoDir = join(scratchDir, "repos", "example-repo");
      mkdirSync(join(repoDir, ".git"), { recursive: true });
      writeFileSync(
        join(repoDir, ".git", "config"),
        `[remote "origin"]\n\turl = https://github.com/acme/example-repo.git\n`,
      );
      process.env.WORKSPACE_PATH = scratchDir;

      const deps = await buildProductionDeps({
        ghJson: async <T>() => [] as unknown as T,
      });

      expect(deps.repos).toEqual(["acme/example-repo"]);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  test("listOpenPrs queries gh pr list with the expected --json field set for the given repo", async () => {
    const seenArgs: string[][] = [];
    const deps = await buildProductionDeps({
      ghJson: async <T>(args: string[]) => {
        seenArgs.push(args);
        return [
          {
            number: 7,
            title: "Ship it",
            headRefOid: "sha7",
            headRefName: "feat/ship-it",
            author: { login: "bodhi-agent" },
            reviewDecision: "APPROVED",
            createdAt: "2026-05-01T00:00:00Z",
            mergeStateStatus: "CLEAN",
          },
        ] as unknown as T;
      },
    });

    const prs = await deps.listOpenPrs("acme/example-repo");

    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(7);
    expect(seenArgs[0]).toEqual([
      "pr",
      "list",
      "--state",
      "open",
      "--repo",
      "acme/example-repo",
      "--json",
      "number,title,headRefOid,headRefName,author,reviewDecision,createdAt,mergeStateStatus,labels",
    ]);
  });

  test("fetchPrReviews unwraps the reviews array from gh pr view", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>(args: string[]) => {
        expect(args).toContain("--repo");
        expect(args).toContain("acme/widgets");
        return {
          reviews: [
            {
              author: { login: "reviewer1" },
              body: "APPROVE",
              state: "APPROVED",
            },
          ],
        } as unknown as T;
      },
    });

    const reviews = await deps.fetchPrReviews("acme", "widgets", 42);
    expect(reviews).toEqual([
      { author: { login: "reviewer1" }, body: "APPROVE", state: "APPROVED" },
    ]);
  });

  test("fetchCiRuns filters workflow_runs down to name 'CI' (case-insensitive) and maps status/conclusion", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>(args: string[]) => {
        expect(args[1]).toContain(
          "repos/acme/widgets/actions/runs?head_sha=deadbeef",
        );
        return {
          workflow_runs: [
            { name: "CI", status: "completed", conclusion: "success" },
            { name: "Deploy", status: "completed", conclusion: "success" },
          ],
        } as unknown as T;
      },
    });

    const runs = await deps.fetchCiRuns("acme", "widgets", "deadbeef");
    expect(runs).toEqual([{ status: "completed", conclusion: "success" }]);
  });

  // Regression test: a repo whose CI workflow's `name:` field is lowercase
  // `ci` (a valid, common convention — see .github/workflows/ci.yml's `name:`
  // key) was silently excluded from deploy candidacy forever, since the old
  // filter did an exact-case match against "CI". isCiGreen() always returned
  // false for such a repo regardless of actual CI status.
  test("fetchCiRuns matches a lowercase workflow name ('ci')", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>() => {
        return {
          workflow_runs: [
            { name: "ci", status: "completed", conclusion: "success" },
            { name: "build-image", status: "completed", conclusion: "success" },
          ],
        } as unknown as T;
      },
    });

    const runs = await deps.fetchCiRuns("acme", "widgets", "deadbeef");
    expect(runs).toEqual([{ status: "completed", conclusion: "success" }]);
  });

  test("fetchActiveDeployRuns merges in_progress and queued runs, filters to name 'Deploy' (case-insensitive), and maps created_at", async () => {
    const calls: string[][] = [];
    const deps = await buildProductionDeps({
      ghJson: async <T>(args: string[]) => {
        calls.push(args);
        if (args[1]?.includes("status=in_progress")) {
          return {
            workflow_runs: [
              {
                name: "Deploy",
                status: "in_progress",
                conclusion: null,
                created_at: "2026-05-01T00:00:00Z",
              },
              {
                name: "CI",
                status: "in_progress",
                conclusion: null,
                created_at: "2026-05-01T00:00:00Z",
              },
            ],
          } as unknown as T;
        }
        return {
          workflow_runs: [
            {
              name: "Deploy",
              status: "queued",
              conclusion: null,
              created_at: "2026-05-01T00:05:00Z",
            },
          ],
        } as unknown as T;
      },
    });

    const runs = await deps.fetchActiveDeployRuns("acme", "widgets");
    expect(runs).toEqual([
      {
        name: "Deploy",
        status: "in_progress",
        createdAt: "2026-05-01T00:00:00Z",
      },
      { name: "Deploy", status: "queued", createdAt: "2026-05-01T00:05:00Z" },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toContain("status=in_progress");
    expect(calls[1][1]).toContain("status=queued");
  });

  // Regression test: a repo whose deploy workflow's `name:` field is
  // lowercase `deploy` was silently excluded from the busy-repo guard.
  test("fetchActiveDeployRuns matches a lowercase workflow name ('deploy')", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>(args: string[]) => {
        if (args[1]?.includes("status=in_progress")) {
          return {
            workflow_runs: [
              {
                name: "deploy",
                status: "in_progress",
                conclusion: null,
                created_at: "2026-05-01T00:00:00Z",
              },
            ],
          } as unknown as T;
        }
        return { workflow_runs: [] } as unknown as T;
      },
    });

    const runs = await deps.fetchActiveDeployRuns("acme", "widgets");
    expect(runs).toEqual([
      {
        name: "deploy",
        status: "in_progress",
        createdAt: "2026-05-01T00:00:00Z",
      },
    ]);
  });

  test("clock returns a parseable ISO string", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>() => [] as unknown as T,
    });
    const now = deps.clock ? deps.clock() : "";
    expect(Number.isNaN(new Date(now).getTime())).toBe(false);
  });

  test("getScopedRepos/hasScopeSynced default to the shared agentReposRef when not overridden", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>() => [] as unknown as T,
    });

    expect(typeof deps.getScopedRepos).toBe("function");
    expect(typeof deps.hasScopeSynced).toBe("function");
    expect(() => deps.getScopedRepos()).not.toThrow();
    expect(() => deps.hasScopeSynced()).not.toThrow();
  });

  test("an explicit opts.getScopedRepos/hasScopeSynced override the agentReposRef default", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>() => [] as unknown as T,
      getScopedRepos: () => ["acme/widgets"],
      hasScopeSynced: () => true,
    });

    expect(deps.getScopedRepos()).toEqual(["acme/widgets"]);
    expect(deps.hasScopeSynced()).toBe(true);
  });

  test("isBundleComplete/queryPrRecord/queryTaskStatus are wired and callable (delegate to check-helpers query builders)", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>() => [] as unknown as T,
    });

    expect(typeof deps.isBundleComplete).toBe("function");
    expect(typeof deps.queryPrRecord).toBe("function");
    expect(typeof deps.queryTaskStatus).toBe("function");
  });

  test("isSelfReviewAllowed reflects readAllowSelfReview's default (false) when no policy file is present", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>() => [] as unknown as T,
    });
    expect(typeof deps.isSelfReviewAllowed).toBe("function");
    expect(deps.isSelfReviewAllowed()).toBe(false);
  });

  test("isAutoMergeAnyAuthorRepo reflects readAutoMergeAnyAuthorRepos' default ([]) when no policy file is present (AM-1)", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>() => [] as unknown as T,
    });
    expect(typeof deps.isAutoMergeAnyAuthorRepo).toBe("function");
    expect(deps.isAutoMergeAnyAuthorRepo?.("acme/example-repo")).toBe(false);
  });

  test("isAutoMergeAnyAuthorRepo reflects a repo present in state/agent-policy.md's auto_merge_any_author_repos list (AM-1)", async () => {
    const scratchDir = mkdtempSync(
      join(tmpdir(), "check-deploy-buildProductionDeps-am1-"),
    );
    try {
      mkdirSync(join(scratchDir, "state"), { recursive: true });
      writeFileSync(
        join(scratchDir, "state", "agent-policy.md"),
        "auto_merge_any_author_repos: [acme/opted-in-repo]",
      );
      process.env.WORKSPACE_PATH = scratchDir;

      const deps = await buildProductionDeps({
        ghJson: async <T>() => [] as unknown as T,
      });

      expect(deps.isAutoMergeAnyAuthorRepo?.("acme/opted-in-repo")).toBe(true);
      expect(deps.isAutoMergeAnyAuthorRepo?.("acme/other-repo")).toBe(false);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  test("getAutoMergeHoldLabel reflects readAutoMergeHoldLabel's default ('') when no policy file is present (AM-1)", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>() => [] as unknown as T,
    });
    expect(typeof deps.getAutoMergeHoldLabel).toBe("function");
    expect(deps.getAutoMergeHoldLabel?.()).toBe("");
  });

  test("getAutoMergeHoldLabel reflects state/agent-policy.md's auto_merge_hold_label field (AM-1)", async () => {
    const scratchDir = mkdtempSync(
      join(tmpdir(), "check-deploy-buildProductionDeps-am1-label-"),
    );
    try {
      mkdirSync(join(scratchDir, "state"), { recursive: true });
      writeFileSync(
        join(scratchDir, "state", "agent-policy.md"),
        "auto_merge_hold_label: do-not-merge",
      );
      process.env.WORKSPACE_PATH = scratchDir;

      const deps = await buildProductionDeps({
        ghJson: async <T>() => [] as unknown as T,
      });

      expect(deps.getAutoMergeHoldLabel?.()).toBe("do-not-merge");
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

describe("isHeldByLabel", () => {
  function pr(labels?: { name: string }[]): GhPr {
    return {
      number: 1,
      headRefOid: "sha1",
      headRefName: "feat/x",
      author: { login: "bodhi-agent" },
      reviewDecision: null,
      mergeStateStatus: null,
      labels,
    };
  }

  test("returns false when holdLabel is an empty string, regardless of the PR's labels", () => {
    expect(isHeldByLabel(pr([{ name: "do-not-merge" }]), "")).toBe(false);
  });

  test("returns false when the PR has no labels field at all", () => {
    expect(isHeldByLabel(pr(undefined), "do-not-merge")).toBe(false);
  });

  test("returns false when the PR's labels don't include holdLabel", () => {
    expect(isHeldByLabel(pr([{ name: "some-other-label" }]), "do-not-merge")).toBe(
      false,
    );
  });

  test("returns true when the PR carries a label matching holdLabel exactly", () => {
    expect(isHeldByLabel(pr([{ name: "do-not-merge" }]), "do-not-merge")).toBe(
      true,
    );
  });

  test("matches case-sensitively (exact string match, mirroring check-review.ts's automated-label precedent)", () => {
    expect(isHeldByLabel(pr([{ name: "Do-Not-Merge" }]), "do-not-merge")).toBe(
      false,
    );
  });
});

describe("getDeployCandidates isSelfReviewAllowed live-read behavior (PLR-1.1)", () => {
  // isSelfReviewAllowed is a live getter (() => boolean), invoked fresh on
  // every getDeployCandidates() call — not memoized. A stub that flips its
  // return value between calls must be observed to flip the resulting
  // candidacy across two separate invocations, proving the consumer calls
  // the getter each time instead of caching the first result (mirrors an
  // agent-policy.md edit taking effect without a process restart).
  test("isSelfReviewAllowed getter is invoked fresh on every call, not memoized", async () => {
    const pr = makeGhPr({
      author: { login: "bodhi-agent" },
      reviewDecision: null,
    });
    const reviews: GhReview[] = [
      { author: { login: "bodhi-agent" }, body: "APPROVE", state: "COMMENTED" },
    ];
    const values = [false, true];
    const deps = makeDeps({
      currentUser: "bodhi-agent",
      isSelfReviewAllowed: () => values.shift() as boolean,
      prs: { "acme/example-repo": [pr] },
      reviews: { 50: reviews },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
    });

    const firstResult = await getDeployCandidates(deps);
    expect(firstResult).toEqual([]);

    const secondResult = await getDeployCandidates(deps);
    expect(secondResult).toHaveLength(1);
  });
});

describe("getDeployCandidates isAutoMergeAnyAuthorRepo/getAutoMergeHoldLabel live-read behavior (AM-1, mirrors PLR-1.1)", () => {
  test("isAutoMergeAnyAuthorRepo getter is invoked fresh on every call, not memoized", async () => {
    const pr = makeGhPr({
      author: { login: "some-human" },
      reviewDecision: "APPROVED",
    });
    const values = [false, true];
    const deps = makeDeps({
      currentUser: "bodhi-agent",
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      isAutoMergeAnyAuthorRepo: () => values.shift() as boolean,
    });

    const firstResult = await getDeployCandidates(deps);
    expect(firstResult).toEqual([]);

    const secondResult = await getDeployCandidates(deps);
    expect(secondResult).toHaveLength(1);
  });

  test("getAutoMergeHoldLabel getter is invoked fresh on every call, not memoized", async () => {
    const pr = makeGhPr({
      reviewDecision: "APPROVED",
      labels: [{ name: "do-not-merge" }],
    });
    const values = ["do-not-merge", ""];
    const deps = makeDeps({
      prs: { "acme/example-repo": [pr] },
      ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      getAutoMergeHoldLabel: () => values.shift() as string,
    });

    const firstResult = await getDeployCandidates(deps);
    expect(firstResult).toEqual([]);

    const secondResult = await getDeployCandidates(deps);
    expect(secondResult).toHaveLength(1);
  });
});
