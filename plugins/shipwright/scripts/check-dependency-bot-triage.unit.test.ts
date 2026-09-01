/**
 * plugins/shipwright/scripts/check-dependency-bot-triage.unit.test.ts
 *
 * Unit tests for check-dependency-bot-triage.ts
 *
 * Design: the script exports a `run(deps)` function with injectable deps for
 * listing open dependency-bot PRs (dependabot + renovate) per repo and
 * reading the local triage state file. Mirrors the skill's own Step 3 dedup
 * logic: an open PR is "untriaged" when no entry in
 * state/dependency-bot-reviews.json matches it by (pr number, repo) with a
 * non-terminal status (anything other than "merged" or "closed"), or when a
 * matching non-terminal entry's triagedCommitSha no longer matches the PR's
 * live head SHA.
 */

import { describe, expect, test } from "bun:test";
import { run } from "./check-dependency-bot-triage.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DependencyBotPr {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
}

type TriageStatus = "pending" | "staged" | "posted" | "merged" | "closed";
type Bot = "dependabot" | "renovate";

interface DependencyBotReviewEntry {
  pr: number;
  repo: string;
  org: string;
  title: string;
  branch: string;
  status: TriageStatus;
  bot: Bot;
  triagedCommitSha: string | null;
  firstSeen: string | null;
  lastTriagedAt: string | null;
  recommendation: string | null;
  stagedFile: string | null;
  postedAt: string | null;
  mergedAt: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReviewEntry(
  overrides: Partial<DependencyBotReviewEntry> = {},
): DependencyBotReviewEntry {
  return {
    pr: 42,
    repo: "example-repo",
    org: "acme",
    title: "Bump axios 1.6→1.7",
    branch: "dependabot/npm_and_yarn/axios-1.7.0",
    status: "pending",
    bot: "dependabot",
    triagedCommitSha: null,
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
  prsByRepo?: Record<string, DependencyBotPr[]>;
  reviewState?: DependencyBotReviewEntry[];
  repos?: string[];
}

function makeDeps({
  prsByRepo = {},
  reviewState = [],
  repos = ["acme/example-repo"],
}: MakeDepsOptions = {}) {
  return {
    resolveRepos: () => repos,
    listDependencyBotPrs: async (repo: string): Promise<DependencyBotPr[]> => {
      return prsByRepo[repo] ?? [];
    },
    readTriageState: (): DependencyBotReviewEntry[] => reviewState,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("check-dependency-bot-triage", () => {
  test("exits 1 when there are no open dependency-bot PRs in any repo", async () => {
    const result = await run(
      makeDeps({
        prsByRepo: { "acme/example-repo": [] },
        reviewState: [],
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when all open dependency-bot PRs already have a non-terminal, up-to-date triage entry", async () => {
    const pr: DependencyBotPr = {
      number: 42,
      title: "Bump axios 1.6→1.7",
      headRefName: "dependabot/npm_and_yarn/axios-1.7.0",
      headRefOid: "sha-abc123",
    };
    const entry = makeReviewEntry({
      pr: 42,
      repo: "example-repo",
      status: "staged",
      triagedCommitSha: "sha-abc123",
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

  test("exits 0 when at least one open dependency-bot PR has no corresponding non-terminal entry", async () => {
    const pr: DependencyBotPr = {
      number: 43,
      title: "Bump webpack 4→5",
      headRefName: "dependabot/npm_and_yarn/webpack-5.0.0",
      headRefOid: "sha-def456",
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
    const pr: DependencyBotPr = {
      number: 42,
      title: "Bump axios 1.6→1.7",
      headRefName: "dependabot/npm_and_yarn/axios-1.7.0",
      headRefOid: "sha-abc123",
    };
    const entry = makeReviewEntry({
      pr: 42,
      repo: "example-repo",
      status: "merged",
      triagedCommitSha: "sha-abc123",
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
    const pr: DependencyBotPr = {
      number: 42,
      title: "Bump axios 1.6→1.7",
      headRefName: "dependabot/npm_and_yarn/axios-1.7.0",
      headRefOid: "sha-abc123",
    };
    const entry = makeReviewEntry({
      pr: 42,
      repo: "example-repo",
      status: "closed",
      triagedCommitSha: "sha-abc123",
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
    const pr: DependencyBotPr = {
      number: 42,
      title: "Bump axios 1.6→1.7",
      headRefName: "dependabot/npm_and_yarn/axios-1.7.0",
      headRefOid: "sha-abc123",
    };
    const entry = makeReviewEntry({
      pr: 42,
      repo: "other-repo", // different repo, same PR number
      status: "staged",
      triagedCommitSha: "sha-abc123",
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
    const pr: DependencyBotPr = {
      number: 1,
      title: "Bump lodash",
      headRefName: "dependabot/npm_and_yarn/lodash-4.17.21",
      headRefOid: "sha-111",
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
    const prA: DependencyBotPr = {
      number: 1,
      title: "Bump a",
      headRefName: "dependabot/npm_and_yarn/a-1.0.0",
      headRefOid: "sha-a1",
    };
    const prB: DependencyBotPr = {
      number: 2,
      title: "Bump b",
      headRefName: "dependabot/npm_and_yarn/b-2.0.0",
      headRefOid: "sha-b1",
    };
    const result = await run(
      makeDeps({
        repos: ["acme/repo-a", "acme/repo-b"],
        prsByRepo: {
          "acme/repo-a": [prA],
          "acme/repo-b": [prB],
        },
        reviewState: [
          makeReviewEntry({
            pr: 1,
            repo: "repo-a",
            status: "posted",
            triagedCommitSha: "sha-a1",
          }),
          makeReviewEntry({
            pr: 2,
            repo: "repo-b",
            status: "pending",
            triagedCommitSha: "sha-b1",
          }),
        ],
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 across multiple repos when one repo has an untriaged PR", async () => {
    const prA: DependencyBotPr = {
      number: 1,
      title: "Bump a",
      headRefName: "dependabot/npm_and_yarn/a-1.0.0",
      headRefOid: "sha-a1",
    };
    const prB: DependencyBotPr = {
      number: 2,
      title: "Bump b",
      headRefName: "dependabot/npm_and_yarn/b-2.0.0",
      headRefOid: "sha-b1",
    };
    const result = await run(
      makeDeps({
        repos: ["acme/repo-a", "acme/repo-b"],
        prsByRepo: {
          "acme/repo-a": [prA],
          "acme/repo-b": [prB],
        },
        reviewState: [
          makeReviewEntry({
            pr: 1,
            repo: "repo-a",
            status: "posted",
            triagedCommitSha: "sha-a1",
          }),
          // repo-b's PR 2 has no matching entry at all — untriaged
        ],
      }),
    );
    expect(result.exit).toBe(0);
  });

  test("prompt output mentions triage", async () => {
    const pr: DependencyBotPr = {
      number: 43,
      title: "Bump webpack 4→5",
      headRefName: "dependabot/npm_and_yarn/webpack-5.0.0",
      headRefOid: "sha-def456",
    };
    const result = await run(
      makeDeps({
        prsByRepo: { "acme/example-repo": [pr] },
        reviewState: [],
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output.toLowerCase()).toContain("triage");
  });

  test("discovers PRs from both dependabot and renovate authors for the same repo without double-counting", async () => {
    // listDependencyBotPrs is the injected boundary standing in for the merged
    // result of the two author-filtered `gh pr list` calls the production
    // Deps implementation performs — this test exercises run()'s consumption
    // of that merged/deduped list across two distinct bot-authored PRs.
    const dependabotPr: DependencyBotPr = {
      number: 10,
      title: "Bump axios 1.6→1.7",
      headRefName: "dependabot/npm_and_yarn/axios-1.7.0",
      headRefOid: "sha-dep-1",
    };
    const renovatePr: DependencyBotPr = {
      number: 11,
      title: "Update dependency react to v19",
      headRefName: "renovate/react-19.x",
      headRefOid: "sha-ren-1",
    };
    const result = await run(
      makeDeps({
        prsByRepo: { "acme/example-repo": [dependabotPr, renovatePr] },
        reviewState: [
          makeReviewEntry({
            pr: 10,
            repo: "example-repo",
            bot: "dependabot",
            status: "posted",
            triagedCommitSha: "sha-dep-1",
          }),
          makeReviewEntry({
            pr: 11,
            repo: "example-repo",
            bot: "renovate",
            status: "posted",
            triagedCommitSha: "sha-ren-1",
          }),
        ],
      }),
    );
    // Both PRs (one from each bot author) are already triaged at their
    // current head SHAs — nothing left to do.
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when both bot authors have untriaged PRs and neither is masked by the other", async () => {
    const dependabotPr: DependencyBotPr = {
      number: 20,
      title: "Bump lodash",
      headRefName: "dependabot/npm_and_yarn/lodash-4.17.21",
      headRefOid: "sha-dep-2",
    };
    const renovatePr: DependencyBotPr = {
      number: 21,
      title: "Update dependency vite to v5",
      headRefName: "renovate/vite-5.x",
      headRefOid: "sha-ren-2",
    };
    const result = await run(
      makeDeps({
        prsByRepo: { "acme/example-repo": [dependabotPr, renovatePr] },
        reviewState: [],
      }),
    );
    expect(result.exit).toBe(0);
  });

  test("re-flags a PR whose stored triagedCommitSha no longer matches the live head SHA (exit 0)", async () => {
    const pr: DependencyBotPr = {
      number: 42,
      title: "Bump axios 1.6→1.7",
      headRefName: "dependabot/npm_and_yarn/axios-1.7.0",
      headRefOid: "sha-new-commit",
    };
    const entry = makeReviewEntry({
      pr: 42,
      repo: "example-repo",
      status: "posted",
      triagedCommitSha: "sha-old-commit", // stale — PR moved since last triage
    });
    const result = await run(
      makeDeps({
        prsByRepo: { "acme/example-repo": [pr] },
        reviewState: [entry],
      }),
    );
    expect(result.exit).toBe(0);
  });

  test("does not re-flag a PR whose stored triagedCommitSha matches the live head SHA (exit 1)", async () => {
    const pr: DependencyBotPr = {
      number: 42,
      title: "Bump axios 1.6→1.7",
      headRefName: "dependabot/npm_and_yarn/axios-1.7.0",
      headRefOid: "sha-current",
    };
    const entry = makeReviewEntry({
      pr: 42,
      repo: "example-repo",
      status: "posted",
      triagedCommitSha: "sha-current", // matches — no new commits since triage
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

  test("re-flags a PR with a null triagedCommitSha even though a non-terminal entry exists", async () => {
    const pr: DependencyBotPr = {
      number: 42,
      title: "Bump axios 1.6→1.7",
      headRefName: "dependabot/npm_and_yarn/axios-1.7.0",
      headRefOid: "sha-current",
    };
    const entry = makeReviewEntry({
      pr: 42,
      repo: "example-repo",
      status: "pending",
      triagedCommitSha: null, // never actually triaged at any commit
    });
    const result = await run(
      makeDeps({
        prsByRepo: { "acme/example-repo": [pr] },
        reviewState: [entry],
      }),
    );
    expect(result.exit).toBe(0);
  });
});
