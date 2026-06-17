/**
 * plugins/shipwright/scripts/check-deploy.unit.test.ts
 *
 * Unit tests for new behaviors in check-deploy.ts:
 * - deploying guard (GitHub active workflow check)
 * - hard authorship filter
 * - --json mode (candidate field)
 * - non-json mode backwards compat
 * - no candidates path
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
    headRefName: "feat/default-branch",
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
  currentUser?: string;
  isSelfReviewAllowed?: boolean;
  clock?: () => string;
}

function makeDeps({
  repos = ["acme/example-repo"],
  prs = {},
  reviews = {},
  ciRuns = {},
  activeDeployRuns = [],
  currentUser = "bodhi-agent",
  isSelfReviewAllowed = true,
  clock,
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
      _org: string,
      _repo: string,
    ): Promise<WorkflowRun[]> => activeDeployRuns,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("check-deploy (new behaviors)", () => {
  // ── Deploying guard ───────────────────────────────────────────────────────────

  test("deploying guard: exits 1 when a Deploy run is in_progress", async () => {
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

  test("deploying guard: exits 1 when a Deploy run is queued (no timestamp — conservative)", async () => {
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

  test("deploying guard: exits 1 when a Deploy run is queued and recent (< 1 hour)", async () => {
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

  test("deploying guard: proceeds when a queued Deploy run is stale (> 1 hour)", async () => {
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

  test("deploying guard: proceeds when no active Deploy runs exist", async () => {
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

  test("deploying guard: proceeds when Deploy run is completed (not active)", async () => {
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

  // ── Authorship filter ─────────────────────────────────────────────────────────

  test("authorship filter: skips PR authored by someone other than currentUser even if APPROVED+CI-green", async () => {
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

  test("authorship filter: allows PR authored by currentUser", async () => {
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

  // ── Candidate field ───────────────────────────────────────────────────────────

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

  // ── Non-json mode backwards compat ────────────────────────────────────────────

  test("non-json mode: output string contains 'deploy' when candidate found", async () => {
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
  });

  test("non-json mode: output is empty string when no candidates", async () => {
    const result = await run(makeDeps());
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  // ── No candidates ─────────────────────────────────────────────────────────────

  test("no candidates: exits 1 with null candidate when repos are empty", async () => {
    const result = await run(makeDeps({ repos: [] }));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
    expect(result.candidate).toBeNull();
  });

  // ── pr_open reconciliation ────────────────────────────────────────────────────

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

  // ── cleanup ───────────────────────────────────────────────────────────────────

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

  // ── Bundle gate ───────────────────────────────────────────────────────────────

  test("bundle gate: skips PR when isBundleComplete returns false", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED", headRefName: "feat/my-feature" });
    const result = await run({
      ...makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
      isBundleComplete: async (_branch: string) => false,
    });
    expect(result.exit).toBe(1);
    expect(result.candidate).toBeNull();
  });

  test("bundle gate: proceeds when isBundleComplete returns true", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED", headRefName: "feat/my-feature" });
    const result = await run({
      ...makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
      isBundleComplete: async (_branch: string) => true,
    });
    expect(result.exit).toBe(0);
    expect(result.candidate).not.toBeNull();
  });

  test("bundle gate: proceeds when isBundleComplete is absent (backward compat)", async () => {
    const pr = makeGhPr({ reviewDecision: "APPROVED" });
    const result = await run(
      makeDeps({
        prs: { "acme/example-repo": [pr] },
        ciRuns: { sha50: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.candidate).not.toBeNull();
  });
});
