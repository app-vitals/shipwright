/**
 * plugins/shipwright/scripts/check-dependabot-triage.test.ts
 *
 * Unit tests for check-dependabot-triage.ts
 *
 * Design: the script exports a `run(deps)` function with injectable deps for
 * listing open Dependabot PRs per repo and reading the local triage state file.
 * Mirrors the skill's own Step 3 dedup logic: an open PR is "untriaged" when
 * no entry in state/dependabot-reviews.json matches it by (pr number, repo)
 * with a non-terminal status (anything other than "merged" or "closed").
 */

import { describe, expect, test } from "bun:test";
import { run } from "./check-dependabot-triage.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DependabotPr {
  number: number;
  title: string;
  headRefName: string;
}

type TriageStatus = "pending" | "staged" | "posted" | "merged" | "closed";

interface DependabotReviewEntry {
  pr: number;
  repo: string;
  org: string;
  title: string;
  branch: string;
  status: TriageStatus;
  firstSeen: string | null;
  lastTriagedAt: string | null;
  recommendation: string | null;
  stagedFile: string | null;
  postedAt: string | null;
  mergedAt: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReviewEntry(
  overrides: Partial<DependabotReviewEntry> = {},
): DependabotReviewEntry {
  return {
    pr: 42,
    repo: "example-repo",
    org: "acme",
    title: "Bump axios 1.6→1.7",
    branch: "dependabot/npm_and_yarn/axios-1.7.0",
    status: "pending",
    firstSeen: "2026-07-01T00:00:00Z",
    lastTriagedAt: null,
    recommendation: null,
    stagedFile: null,
    postedAt: null,
    mergedAt: null,
    ...overrides,
  };
}

interface MakeDepsOptions {
  prsByRepo?: Record<string, DependabotPr[]>;
  reviewState?: DependabotReviewEntry[];
  repos?: string[];
}

function makeDeps({
  prsByRepo = {},
  reviewState = [],
  repos = ["acme/example-repo"],
}: MakeDepsOptions = {}) {
  return {
    resolveRepos: () => repos,
    listDependabotPrs: async (repo: string): Promise<DependabotPr[]> => {
      return prsByRepo[repo] ?? [];
    },
    readTriageState: (): DependabotReviewEntry[] => reviewState,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("check-dependabot-triage", () => {
  test("exits 1 when there are no open dependabot PRs in any repo", async () => {
    const result = await run(
      makeDeps({
        prsByRepo: { "acme/example-repo": [] },
        reviewState: [],
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when all open dependabot PRs already have a non-terminal triage entry", async () => {
    const pr: DependabotPr = {
      number: 42,
      title: "Bump axios 1.6→1.7",
      headRefName: "dependabot/npm_and_yarn/axios-1.7.0",
    };
    const entry = makeReviewEntry({
      pr: 42,
      repo: "example-repo",
      status: "staged",
    });
    const result = await run(
      makeDeps({
        prsByRepo: { "acme/example-repo": [pr] },
        reviewState: [entry],
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when at least one open dependabot PR has no corresponding non-terminal entry", async () => {
    const pr: DependabotPr = {
      number: 43,
      title: "Bump webpack 4→5",
      headRefName: "dependabot/npm_and_yarn/webpack-5.0.0",
    };
    const result = await run(
      makeDeps({
        prsByRepo: { "acme/example-repo": [pr] },
        reviewState: [],
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("exits 0 when an open PR's only matching state entry has a terminal status (merged)", async () => {
    // Same PR number reopened after a prior merge — the old "merged" entry
    // doesn't count as a non-terminal dedup match, so it's untriaged again.
    const pr: DependabotPr = {
      number: 42,
      title: "Bump axios 1.6→1.7",
      headRefName: "dependabot/npm_and_yarn/axios-1.7.0",
    };
    const entry = makeReviewEntry({
      pr: 42,
      repo: "example-repo",
      status: "merged",
    });
    const result = await run(
      makeDeps({
        prsByRepo: { "acme/example-repo": [pr] },
        reviewState: [entry],
      }),
    );
    expect(result.exit).toBe(0);
  });

  test("exits 0 when an open PR's only matching state entry has a terminal status (closed)", async () => {
    const pr: DependabotPr = {
      number: 42,
      title: "Bump axios 1.6→1.7",
      headRefName: "dependabot/npm_and_yarn/axios-1.7.0",
    };
    const entry = makeReviewEntry({
      pr: 42,
      repo: "example-repo",
      status: "closed",
    });
    const result = await run(
      makeDeps({
        prsByRepo: { "acme/example-repo": [pr] },
        reviewState: [entry],
      }),
    );
    expect(result.exit).toBe(0);
  });

  test("does not match a triage entry from a different repo with the same PR number", async () => {
    const pr: DependabotPr = {
      number: 42,
      title: "Bump axios 1.6→1.7",
      headRefName: "dependabot/npm_and_yarn/axios-1.7.0",
    };
    const entry = makeReviewEntry({
      pr: 42,
      repo: "other-repo", // different repo, same PR number
      status: "staged",
    });
    const result = await run(
      makeDeps({
        prsByRepo: { "acme/example-repo": [pr] },
        reviewState: [entry],
      }),
    );
    expect(result.exit).toBe(0);
  });

  test("treats a missing/empty state file as [] — untriaged PR still triggers exit 0", async () => {
    const pr: DependabotPr = {
      number: 1,
      title: "Bump lodash",
      headRefName: "dependabot/npm_and_yarn/lodash-4.17.21",
    };
    const result = await run(
      makeDeps({
        prsByRepo: { "acme/example-repo": [pr] },
        reviewState: [],
      }),
    );
    expect(result.exit).toBe(0);
  });

  test("exits 1 across multiple repos when every open PR is already triaged", async () => {
    const prA: DependabotPr = {
      number: 1,
      title: "Bump a",
      headRefName: "dependabot/npm_and_yarn/a-1.0.0",
    };
    const prB: DependabotPr = {
      number: 2,
      title: "Bump b",
      headRefName: "dependabot/npm_and_yarn/b-2.0.0",
    };
    const result = await run(
      makeDeps({
        repos: ["acme/repo-a", "acme/repo-b"],
        prsByRepo: {
          "acme/repo-a": [prA],
          "acme/repo-b": [prB],
        },
        reviewState: [
          makeReviewEntry({ pr: 1, repo: "repo-a", status: "posted" }),
          makeReviewEntry({ pr: 2, repo: "repo-b", status: "pending" }),
        ],
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 across multiple repos when one repo has an untriaged PR", async () => {
    const prA: DependabotPr = {
      number: 1,
      title: "Bump a",
      headRefName: "dependabot/npm_and_yarn/a-1.0.0",
    };
    const prB: DependabotPr = {
      number: 2,
      title: "Bump b",
      headRefName: "dependabot/npm_and_yarn/b-2.0.0",
    };
    const result = await run(
      makeDeps({
        repos: ["acme/repo-a", "acme/repo-b"],
        prsByRepo: {
          "acme/repo-a": [prA],
          "acme/repo-b": [prB],
        },
        reviewState: [
          makeReviewEntry({ pr: 1, repo: "repo-a", status: "posted" }),
          // repo-b's PR 2 has no matching entry at all — untriaged
        ],
      }),
    );
    expect(result.exit).toBe(0);
  });

  test("prompt output mentions dependabot triage", async () => {
    const pr: DependabotPr = {
      number: 43,
      title: "Bump webpack 4→5",
      headRefName: "dependabot/npm_and_yarn/webpack-5.0.0",
    };
    const result = await run(
      makeDeps({
        prsByRepo: { "acme/example-repo": [pr] },
        reviewState: [],
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output.toLowerCase()).toContain("dependabot");
  });
});
