/**
 * plugins/shipwright/scripts/check-deploy.test.ts
 *
 * Unit tests for check-deploy.ts
 *
 * Design: the script exports a `run(deps)` function with injectable deps.
 * PR discovery uses GitHub (no todos.json). Approval uses GitHub reviewDecision
 * or self-review via GitHub review comments (no reviews.json).
 */

import { describe, expect, test } from "bun:test";
import { run } from "./check-deploy.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface GhPr {
  number: number;
  headRefOid: string;
  headRefName: string;
  author: { login: string };
  reviewDecision: string | null;
}

interface GhReview {
  author: { login: string };
  body: string;
  state: string;
}

interface CiRun {
  status: string;
  conclusion: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGhPr(overrides: Partial<GhPr> = {}): GhPr {
  return {
    number: 50,
    headRefOid: "sha50",
    headRefName: "feat/default-branch",
    author: { login: "bodhi-agent" },
    reviewDecision: null,
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
}

function makeDeps({
  repos = ["acme/example-repo"],
  prs = {},
  reviews = {},
  ciRuns = {},
  currentUser = "bodhi-agent",
  isSelfReviewAllowed = true,
}: MakeDepsOptions = {}) {
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
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("check-deploy", () => {
  test("exits 1 when no repos are configured", async () => {
    const result = await run(makeDeps({ repos: [] }));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when repos are configured but no open PRs exist", async () => {
    const result = await run(
      makeDeps({ repos: ["acme/example-repo"], prs: {} }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when PR is GitHub-approved and CI is green", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 1 when PR is not approved and no self-review", async () => {
    const pr = makeGhPr({ reviewDecision: null });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result.exit).toBe(1);
  });

  test("exits 0 when self-review: author is current user, allow_self_review=true, APPROVE in review body, CI green", async () => {
    const pr = makeGhPr({
      author: { login: "bodhi-agent" },
      reviewDecision: null,
    });
    const reviews: GhReview[] = [
      { author: { login: "bodhi-agent" }, body: "APPROVE", state: "COMMENTED" },
    ];
    const result = await run(
      makeDeps({
        currentUser: "bodhi-agent",
        isSelfReviewAllowed: true,
        prs: { "acme/example-repo": [pr] },
        reviews: { 50: reviews },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 1 when self-review but allow_self_review=false", async () => {
    const pr = makeGhPr({
      author: { login: "bodhi-agent" },
      reviewDecision: null,
    });
    const reviews: GhReview[] = [
      { author: { login: "bodhi-agent" }, body: "APPROVE", state: "COMMENTED" },
    ];
    const result = await run(
      makeDeps({
        currentUser: "bodhi-agent",
        isSelfReviewAllowed: false,
        prs: { "acme/example-repo": [pr] },
        reviews: { 50: reviews },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result.exit).toBe(1);
  });

  test("exits 0 when self-review body uses markdown bold (**APPROVE**)", async () => {
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
    const result = await run(
      makeDeps({
        currentUser: "bodhi-agent",
        isSelfReviewAllowed: true,
        prs: { "acme/example-repo": [pr] },
        reviews: { 50: reviews },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 1 when self-review allowed but no APPROVE in review body", async () => {
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
    const result = await run(
      makeDeps({
        currentUser: "bodhi-agent",
        isSelfReviewAllowed: true,
        prs: { "acme/example-repo": [pr] },
        reviews: { 50: reviews },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result.exit).toBe(1);
  });

  test("exits 1 when PR is approved but CI is not green (in_progress)", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "in_progress", conclusion: null }] },
      }),
    );
    expect(result.exit).toBe(1);
  });

  test("exits 1 when PR is approved but CI failed", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "failure" }] },
      }),
    );
    expect(result.exit).toBe(1);
  });

  test("exits 1 when PR is approved but no CI run exists", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: {},
      }),
    );
    expect(result.exit).toBe(1);
  });

  test("PRs with no corresponding todo are correctly identified as deploy-ready", async () => {
    // No todos involved — PR is eligible purely based on GitHub state
    const pr = makeGhPr({
      number: 999,
      headRefOid: "sha999",
      reviewDecision: "APPROVED",
    });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha999: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 0 when ready PR found in second repo when first repo has no ready PRs", async () => {
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
    const result = await run(
      makeDeps({
        repos: ["acme/example-repo", "app-vitals/patrol"],
        prs: {
          "acme/example-repo": [pr1],
          "app-vitals/patrol": [pr2],
        },
        ciRuns: { sha20: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
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

    const deps = {
      getCurrentUser: () => "bodhi-agent",
      isSelfReviewAllowed: true,
      repos: ["app-vitals/failing-repo", "acme/example-repo"],
      fetchActiveDeployRuns: async () => [],
      listOpenPrs: async (repo: string): Promise<GhPr[]> => {
        if (repo === "app-vitals/failing-repo") throw new Error("rate limited");
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

    const result = await run(deps);
    process.stderr.write = origStderr;

    expect(result.exit).toBe(0);
    expect(stderrLines.some((l) => l.includes("app-vitals/failing-repo"))).toBe(
      true,
    );
  });

  test("prompt mentions shipwright:deploy", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output.toLowerCase()).toContain("deploy");
  });
});
