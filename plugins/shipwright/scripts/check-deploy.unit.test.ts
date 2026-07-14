/**
 * plugins/shipwright/scripts/check-deploy.unit.test.ts
 *
 * Unit tests for check-deploy.ts
 *
 * Design: the script exports a `run(deps)` function with injectable deps.
 * PR discovery uses GitHub (no todos.json). Approval uses GitHub reviewDecision
 * or self-review via GitHub review comments (no reviews.json).
 *
 * Covers original approval/CI-gating behavior plus newer behaviors:
 * - deploying guard (GitHub active workflow check)
 * - hard authorship filter
 * - --json mode (candidate field)
 * - non-json mode backwards compat
 * - no candidates path
 * - pr_open reconciliation / stale-issue cleanup hooks
 * - bundle completeness gate
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

interface WorkflowRun {
  name: string;
  status: string;
  createdAt?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGhPr(overrides: Partial<GhPr> = {}): GhPr {
  return {
    number: 50,
    headRefOid: "sha50",
    headRefName: "feat/example-branch",
    author: { login: "bodhi-agent" },
    reviewDecision: "APPROVED",
    ...overrides,
  };
}

interface MakeDepsOptions {
  repos?: string[];
  prs?: Record<string, GhPr[]>;
  reviews?: Record<number, GhReview[]>;
  ciRuns?: Record<string, CiRun[]>;
  activeDeployRuns?: WorkflowRun[];
  // Per-repo override, keyed by "org/repo" — takes precedence over
  // activeDeployRuns when set, so multi-repo scenarios can give each repo
  // its own active-run state.
  activeDeployRunsByRepo?: Record<string, WorkflowRun[]>;
  currentUser?: string;
  isSelfReviewAllowed?: boolean;
  clock?: () => string;
  isBundleComplete?: (branch: string) => Promise<boolean>;
}

function makeDeps({
  repos = ["acme/example-repo"],
  prs = {},
  reviews = {},
  ciRuns = {},
  activeDeployRuns = [],
  activeDeployRunsByRepo,
  currentUser = "bodhi-agent",
  isSelfReviewAllowed = true,
  clock,
  isBundleComplete,
}: MakeDepsOptions = {}) {
  return {
    getCurrentUser: () => currentUser,
    isSelfReviewAllowed,
    repos,
    clock,
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
    fetchActiveDeployRuns: async (
      org: string,
      repo: string,
    ): Promise<WorkflowRun[]> => {
      if (activeDeployRunsByRepo) {
        return activeDeployRunsByRepo[`${org}/${repo}`] ?? [];
      }
      return activeDeployRuns;
    },
    ...(isBundleComplete !== undefined ? { isBundleComplete } : {}),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("check-deploy — approval & CI gating", () => {
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

  test("exits 0 when self-review body uses the narrative 'Verdict: APPROVE' label", async () => {
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

  test("exits 0 when clean 'Verdict: APPROVE' review is from a different author than currentUser (identity-agnostic clean-approve fallback)", async () => {
    const pr = makeGhPr({
      author: { login: "bodhi-agent" },
      reviewDecision: null,
    });
    const reviews: GhReview[] = [
      {
        author: { login: "some-other-agent" },
        body: "All 5 acceptance criteria met. Verdict: APPROVE (posted as COMMENT — GitHub disallows self-approval via the API).",
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

  test("exits 1 when self-review has a non-APPROVE verdict label", async () => {
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
        repos: ["acme/example-repo", "acme/other-repo"],
        prs: {
          "acme/example-repo": [pr1],
          "acme/other-repo": [pr2],
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

    const result = await run(deps);
    process.stderr.write = origStderr;

    expect(result.exit).toBe(0);
    expect(stderrLines.some((l) => l.includes("acme/failing-repo"))).toBe(
      true,
    );
  });
});

describe("check-deploy — deploying guard (GitHub active workflow check)", () => {
  test("exits 1 when a Deploy run is in_progress", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        activeDeployRuns: [{ name: "Deploy", status: "in_progress" }],
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
    expect(result.candidate).toBeNull();
  });

  test("exits 1 when a Deploy run is queued (no timestamp — conservative)", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        activeDeployRuns: [{ name: "Deploy", status: "queued" }],
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.candidate).toBeNull();
  });

  test("exits 1 when a Deploy run is queued and recent (< 1 hour)", async () => {
    const createdAt = "2026-06-12T10:00:00Z";
    const now = "2026-06-12T10:30:00Z"; // 30 min later
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        activeDeployRuns: [{ name: "Deploy", status: "queued", createdAt }],
        clock: () => now,
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.candidate).toBeNull();
  });

  test("proceeds when a queued Deploy run is stale (> 1 hour)", async () => {
    const createdAt = "2026-06-12T10:00:00Z";
    const now = "2026-06-12T11:01:00Z"; // 61 min later
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        activeDeployRuns: [{ name: "Deploy", status: "queued", createdAt }],
        clock: () => now,
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.candidate).not.toBeNull();
  });

  test("proceeds when no active Deploy runs exist", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        activeDeployRuns: [],
      }),
    );
    expect(result.exit).toBe(0);
  });

  test("proceeds when Deploy run is completed (not active)", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        activeDeployRuns: [{ name: "Deploy", status: "completed" }],
      }),
    );
    expect(result.exit).toBe(0);
  });

  test("scoped per repo — an active Deploy in one repo does not block a ready PR in another", async () => {
    const busyRepoPr = makeGhPr({
      number: 10,
      headRefOid: "sha-busy",
      reviewDecision: "APPROVED",
    });
    const readyRepoPr = makeGhPr({
      number: 20,
      headRefOid: "sha-ready",
      reviewDecision: "APPROVED",
    });
    const result = await run(
      makeDeps({
        repos: ["acme/busy-repo", "acme/ready-repo"],
        prs: {
          "acme/busy-repo": [busyRepoPr],
          "acme/ready-repo": [readyRepoPr],
        },
        ciRuns: {
          "sha-busy": [{ status: "completed", conclusion: "success" }],
          "sha-ready": [{ status: "completed", conclusion: "success" }],
        },
        activeDeployRunsByRepo: {
          "acme/busy-repo": [{ name: "Deploy", status: "in_progress" }],
          "acme/ready-repo": [],
        },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.candidate).toEqual({
      pr: 20,
      org: "acme",
      repo: "ready-repo",
    });
  });

  test("scoped per repo — exits 1 when the only configured repo is busy, even though the guard no longer short-circuits globally", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run(
      makeDeps({
        repos: ["acme/busy-repo"],
        prs: { "acme/busy-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        activeDeployRunsByRepo: {
          "acme/busy-repo": [{ name: "Deploy", status: "in_progress" }],
        },
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.candidate).toBeNull();
  });
});

describe("check-deploy — hard authorship filter", () => {
  test("skips PR authored by someone other than currentUser even if APPROVED+CI-green", async () => {
    const pr = makeGhPr({
      author: { login: "some-other-user" },
      reviewDecision: "APPROVED",
    });
    const result = await run(
      makeDeps({
        currentUser: "bodhi-agent",
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.candidate).toBeNull();
  });

  test("allows PR authored by currentUser", async () => {
    const pr = makeGhPr({
      author: { login: "bodhi-agent" },
      reviewDecision: "APPROVED",
    });
    const result = await run(
      makeDeps({
        currentUser: "bodhi-agent",
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result.exit).toBe(0);
  });
});

describe("check-deploy — candidate field (--json mode)", () => {
  test("candidate is populated with {pr, org, repo} for qualifying PR", async () => {
    const pr = makeGhPr({
      number: 42,
      author: { login: "bodhi-agent" },
      reviewDecision: "APPROVED",
    });
    const result = await run(
      makeDeps({
        currentUser: "bodhi-agent",
        repos: ["acme/example-repo"],
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.candidate).toEqual({
      pr: 42,
      org: "acme",
      repo: "example-repo",
    });
  });

  test("candidate is null when no qualifying PR exists", async () => {
    const result = await run(makeDeps({ repos: ["acme/example-repo"] }));
    expect(result.exit).toBe(1);
    expect(result.candidate).toBeNull();
  });

  test("candidate org/repo are correctly split for org/repo format", async () => {
    const pr = makeGhPr({
      number: 77,
      headRefOid: "sha77",
      author: { login: "bodhi-agent" },
      reviewDecision: "APPROVED",
    });
    const result = await run(
      makeDeps({
        currentUser: "bodhi-agent",
        repos: ["my-org/my-repo"],
        prs: { "my-org/my-repo": [pr] },
        ciRuns: { sha77: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.candidate).toEqual({
      pr: 77,
      org: "my-org",
      repo: "my-repo",
    });
  });
});

describe("check-deploy — non-json mode backwards compat", () => {
  test("output string contains 'deploy' when candidate found", async () => {
    const pr = makeGhPr({
      author: { login: "bodhi-agent" },
      reviewDecision: "APPROVED",
    });
    const result = await run(
      makeDeps({
        currentUser: "bodhi-agent",
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toBe("Deploy ready PRs via /shipwright:deploy");
    expect(result.output.toLowerCase()).toContain("deploy");
  });

  test("output is empty string when no candidates", async () => {
    const result = await run(makeDeps());
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });
});

describe("check-deploy — no candidates", () => {
  test("exits 1 with null candidate when repos are empty", async () => {
    const result = await run(makeDeps({ repos: [] }));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
    expect(result.candidate).toBeNull();
  });
});

describe("check-deploy — pr_open reconciliation", () => {
  test("reconcileStalePrOpenTasks is called before the main scan", async () => {
    let called = false;
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run({
      ...makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
      reconcileStalePrOpenTasks: async () => {
        called = true;
      },
    });
    expect(called).toBe(true);
    expect(result.exit).toBe(0);
  });

  test("reconcileStalePrOpenTasks error does not block the scan", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run({
      ...makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
      reconcileStalePrOpenTasks: async () => {
        throw new Error("task store unavailable");
      },
    });
    expect(result.exit).toBe(0);
    expect(result.candidate).not.toBeNull();
  });
});

describe("check-deploy — cleanup", () => {
  test("cleanupStaleIssues is called before the main scan", async () => {
    let called = false;
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run({
      ...makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
      cleanupStaleIssues: async () => {
        called = true;
      },
    });
    expect(called).toBe(true);
    expect(result.exit).toBe(0);
  });

  test("cleanupStaleIssues error does not block the scan", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run({
      ...makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
      cleanupStaleIssues: async () => {
        throw new Error("cleanup unavailable");
      },
    });
    expect(result.exit).toBe(0);
    expect(result.candidate).not.toBeNull();
  });

  test("cleanupStaleIssues is called even when reconcile is absent", async () => {
    let cleaned = false;
    const result = await run({
      ...makeDeps({ repos: ["acme/example-repo"] }),
      cleanupStaleIssues: async () => {
        cleaned = true;
      },
    });
    expect(cleaned).toBe(true);
    expect(result.exit).toBe(1);
  });
});

describe("check-deploy — bundle completeness gate", () => {
  test("skips PR when isBundleComplete returns false", async () => {
    const pr = makeGhPr({
      headRefName: "feat/my-branch",
      reviewDecision: "APPROVED",
    });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        isBundleComplete: async (_branch: string) => false,
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.candidate).toBeNull();
  });

  test("proceeds when isBundleComplete returns true", async () => {
    const pr = makeGhPr({
      headRefName: "feat/my-branch",
      reviewDecision: "APPROVED",
    });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        isBundleComplete: async (_branch: string) => true,
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.candidate).not.toBeNull();
  });

  test("proceeds when isBundleComplete throws (permissive on error)", async () => {
    const pr = makeGhPr({
      headRefName: "feat/my-branch",
      reviewDecision: "APPROVED",
    });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        isBundleComplete: async (_branch: string) => {
          throw new Error("task store unavailable");
        },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.candidate).not.toBeNull();
  });

  test("proceeds when isBundleComplete is absent (dep not provided)", async () => {
    const pr = makeGhPr({
      headRefName: "feat/my-branch",
      reviewDecision: "APPROVED",
    });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
        // isBundleComplete is intentionally omitted
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.candidate).not.toBeNull();
  });
});
