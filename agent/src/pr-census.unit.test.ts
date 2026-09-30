/**
 * agent/src/pr-census.unit.test.ts
 *
 * Unit tests for POM-4.1's repo-wide merged-PR census sweep:
 *   - classifyPrOrigin()'s precedence table (ci -> dependency_bot ->
 *     shipwright -> human -> unknown, NO label arm)
 *   - runPrCensus()'s cursor-init/skip behavior, per-repo gh+POST call
 *     shape, chunking/ordering, per-repo error isolation, the
 *     ENABLED=false short-circuit, and the INTERVAL_MS throttle.
 *
 * Uses fully injected ghJson/task-store-HTTP doubles and an injected Clock
 * (FixedClock) — no real fetch, no gh CLI, no global.fetch/global.*
 * overrides — per this repo's unit-test isolation contract. Modeled on
 * claim-invariant-reconciler.unit.test.ts / worktree-reaper.unit.test.ts's
 * structure.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { FixedClock } from "./clock.ts";
import {
  __resetPrCensusThrottleForTests,
  buildCensusEntry,
  type CensusEntry,
  type CensusTaskRecord,
  classifyCommits,
  classifyPrOrigin,
  type GhCensusPr,
  type PrCensusDeps,
  runPrCensus,
} from "./pr-census.ts";

// ─── Fakes ────────────────────────────────────────────────────────────────────

interface MakeDepsOptions {
  scopedRepos?: string[];
  /** repo -> cursor value returned by getCensusCursor (undefined repo entries default to null — first run). */
  cursorsByRepo?: Record<string, string | null>;
  /** repo -> gh pr list result for that repo's search call. */
  mergedPrsByRepo?: Record<string, GhCensusPr[]>;
  /** repo -> task-store tasks with pr set. */
  tasksByRepo?: Record<string, CensusTaskRecord[]>;
  /** repo -> Error to throw from ghJson (the gh pr list call) for that repo. */
  ghErrors?: Record<string, Error>;
  /** repo -> Error to throw from postCensusBatch for that repo. */
  postErrors?: Record<string, Error>;
  enabled?: boolean;
  intervalMs?: number;
  now?: Date;
}

function makeDeps(opts: MakeDepsOptions = {}): {
  deps: PrCensusDeps;
  ghCalls: Array<{ repo: string; args: string[] }>;
  postCalls: Array<{ repo: string; entries: CensusEntry[] }>;
} {
  const {
    scopedRepos = [],
    cursorsByRepo = {},
    mergedPrsByRepo = {},
    tasksByRepo = {},
    ghErrors = {},
    postErrors = {},
    enabled = true,
    intervalMs,
    now = new Date("2026-09-16T00:00:00.000Z"),
  } = opts;

  const ghCalls: Array<{ repo: string; args: string[] }> = [];
  const postCalls: Array<{ repo: string; entries: CensusEntry[] }> = [];

  const deps: PrCensusDeps = {
    getScopedRepos: () => scopedRepos,
    ghJson: async <T>(args: string[]): Promise<T> => {
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] : "";
      ghCalls.push({ repo, args });
      const err = ghErrors[repo];
      if (err) throw err;
      return (mergedPrsByRepo[repo] ?? []) as unknown as T;
    },
    getCensusCursor: async (repo: string) => cursorsByRepo[repo] ?? null,
    listTasksWithPr: async (repo: string) => tasksByRepo[repo] ?? [],
    postCensusBatch: async (repo: string, entries: CensusEntry[]) => {
      postCalls.push({ repo, entries });
      const err = postErrors[repo];
      if (err) throw err;
    },
    clock: FixedClock(now),
    enabled,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
  };

  return { deps, ghCalls, postCalls };
}

function pr(overrides: Partial<GhCensusPr>): GhCensusPr {
  return {
    number: 1,
    title: "Some PR",
    author: { login: "someone" },
    headRefName: "feat/some-branch",
    createdAt: "2026-09-01T00:00:00.000Z",
    mergedAt: "2026-09-02T00:00:00.000Z",
    commits: [],
    ...overrides,
  };
}

beforeEach(() => {
  __resetPrCensusThrottleForTests();
});

// ─── classifyPrOrigin ───────────────────────────────────────────────────────

describe("classifyPrOrigin", () => {
  test("github-actions[bot] author -> ci", () => {
    expect(
      classifyPrOrigin({
        authorLogin: "github-actions[bot]",
        headRefName: "feat/x",
        hasTaskRowMatch: false,
      }),
    ).toBe("ci");
  });

  test("chore/chart-v1.2.3 head with no matching author -> ci", () => {
    expect(
      classifyPrOrigin({
        authorLogin: "someone",
        headRefName: "chore/chart-v1.2.3",
        hasTaskRowMatch: false,
      }),
    ).toBe("ci");
  });

  test("chore/plugin-version-v9.0.0 head with no matching author -> ci", () => {
    expect(
      classifyPrOrigin({
        authorLogin: "someone",
        headRefName: "chore/plugin-version-v9.0.0",
        hasTaskRowMatch: false,
      }),
    ).toBe("ci");
  });

  test("renovate[bot] -> dependency_bot", () => {
    expect(
      classifyPrOrigin({
        authorLogin: "renovate[bot]",
        headRefName: "renovate/some-dep",
        hasTaskRowMatch: false,
      }),
    ).toBe("dependency_bot");
  });

  test("dependabot[bot] -> dependency_bot", () => {
    expect(
      classifyPrOrigin({
        authorLogin: "dependabot[bot]",
        headRefName: "dependabot/npm/some-dep",
        hasTaskRowMatch: false,
      }),
    ).toBe("dependency_bot");
  });

  test("task-row match -> shipwright", () => {
    expect(
      classifyPrOrigin({
        authorLogin: "some-human",
        headRefName: "feat/sw-1-2-slug",
        hasTaskRowMatch: true,
      }),
    ).toBe("shipwright");
  });

  test("human login with no task match -> human", () => {
    expect(
      classifyPrOrigin({
        authorLogin: "some-human",
        headRefName: "feat/manual-fix",
        hasTaskRowMatch: false,
      }),
    ).toBe("human");
  });

  test("missing author and no task match -> unknown", () => {
    expect(
      classifyPrOrigin({
        authorLogin: null,
        headRefName: "some-branch",
        hasTaskRowMatch: false,
      }),
    ).toBe("unknown");
  });

  test("a task-row match still wins even when the author login is also missing (shipwright beats the unknown catch-all)", () => {
    expect(
      classifyPrOrigin({
        authorLogin: null,
        headRefName: "some-branch",
        hasTaskRowMatch: true,
      }),
    ).toBe("shipwright");
  });

  // NOTE: per the module doc comment's explicit, twice-stated precedence
  // order (shipwright -> ci -> dependency_bot -> human -> unknown), the
  // task-row/shipwright check runs BEFORE the ci/dependency_bot checks — so
  // a task-row match wins over an author login that would otherwise say
  // ci/dependency_bot, not the other way around. A task-row match is a
  // direct DB join and a more trustworthy signal than inferring origin from
  // author login/branch name. This is the interpretation implemented and
  // tested here.
  test("a task-row match takes precedence over a ci-triggering author login", () => {
    expect(
      classifyPrOrigin({
        authorLogin: "github-actions[bot]",
        headRefName: "feat/x",
        hasTaskRowMatch: true,
      }),
    ).toBe("shipwright");
  });

  test("a task-row match takes precedence over a dependency_bot-triggering author login", () => {
    expect(
      classifyPrOrigin({
        authorLogin: "renovate[bot]",
        headRefName: "renovate/some-dep",
        hasTaskRowMatch: true,
      }),
    ).toBe("shipwright");
  });

  // ── POF-1.2: authorIsBot + label signals (mirrors task-store's POF-1.1
  // deriveOrigin() suite — see task-store/src/pull-request-service.unit.test.ts) ──

  test("authorIsBot true with authorLogin 'app/renovate' -> dependency_bot", () => {
    expect(
      classifyPrOrigin({
        hasTaskRowMatch: false,
        authorIsBot: true,
        authorLogin: "app/renovate",
        headRefName: null,
      }),
    ).toBe("dependency_bot");
  });

  test("authorIsBot true with authorLogin 'app/dependabot' -> dependency_bot", () => {
    expect(
      classifyPrOrigin({
        hasTaskRowMatch: false,
        authorIsBot: true,
        authorLogin: "app/dependabot",
        headRefName: null,
      }),
    ).toBe("dependency_bot");
  });

  test("authorIsBot true with the literal 'renovate[bot]' login -> dependency_bot", () => {
    expect(
      classifyPrOrigin({
        hasTaskRowMatch: false,
        authorIsBot: true,
        authorLogin: "renovate[bot]",
        headRefName: null,
      }),
    ).toBe("dependency_bot");
  });

  test("authorIsBot true with a bot identity that isn't Renovate/Dependabot -> ci", () => {
    expect(
      classifyPrOrigin({
        hasTaskRowMatch: false,
        authorIsBot: true,
        authorLogin: "app/some-other-bot",
        headRefName: null,
      }),
    ).toBe("ci");
  });

  test("authorIsBot true with no authorLogin at all -> ci", () => {
    expect(
      classifyPrOrigin({
        hasTaskRowMatch: false,
        authorIsBot: true,
        authorLogin: null,
        headRefName: null,
      }),
    ).toBe("ci");
  });

  test("hasAutomatedLabel true with a human-looking authorLogin -> ci, independent of authorLogin", () => {
    expect(
      classifyPrOrigin({
        hasTaskRowMatch: false,
        hasAutomatedLabel: true,
        authorLogin: "octocat",
        headRefName: null,
      }),
    ).toBe("ci");
  });

  test("hasShipwrightLabel true with no task row and no authorLogin -> shipwright", () => {
    expect(
      classifyPrOrigin({
        hasTaskRowMatch: false,
        hasShipwrightLabel: true,
        authorLogin: null,
        headRefName: null,
      }),
    ).toBe("shipwright");
  });

  test("hasShipwrightLabel true takes precedence over an authorLogin that would otherwise say 'dependency_bot'", () => {
    expect(
      classifyPrOrigin({
        hasTaskRowMatch: false,
        hasShipwrightLabel: true,
        authorIsBot: true,
        authorLogin: "app/renovate",
        headRefName: null,
      }),
    ).toBe("shipwright");
  });

  test("authorIsBot true still yields 'dependency_bot' ahead of hasAutomatedLabel (bot-identity check wins first)", () => {
    expect(
      classifyPrOrigin({
        hasTaskRowMatch: false,
        authorIsBot: true,
        hasAutomatedLabel: true,
        authorLogin: "app/renovate",
        headRefName: null,
      }),
    ).toBe("dependency_bot");
  });

  test("hasTaskRowMatch takes precedence over authorIsBot (a task row always wins)", () => {
    expect(
      classifyPrOrigin({
        hasTaskRowMatch: true,
        authorIsBot: true,
        authorLogin: "app/renovate",
        headRefName: null,
      }),
    ).toBe("shipwright");
  });
});

// ─── classifyCommits ────────────────────────────────────────────────────────

describe("classifyCommits", () => {
  test("all-implementation: no docs/review-patch commits, no ci-fix attempts", () => {
    const result = classifyCommits(
      [
        { messageHeadline: "feat: add the thing" },
        { messageHeadline: "test: cover the thing" },
      ],
      42,
      0,
    );
    expect(result).toEqual({
      commitsDocsRefresh: 0,
      commitsReviewPatch: 0,
      commitsCiFix: 0,
      commitsImplementation: 2,
    });
  });

  test("docs-refresh commit present: counted in commitsDocsRefresh, not implementation", () => {
    const result = classifyCommits(
      [
        { messageHeadline: "feat: add the thing" },
        { messageHeadline: "docs: refresh architecture.md" },
      ],
      42,
      0,
    );
    expect(result).toEqual({
      commitsDocsRefresh: 1,
      commitsReviewPatch: 0,
      commitsCiFix: 0,
      commitsImplementation: 1,
    });
  });

  test("review-patch commit present (prefix interpolates this PR's own number): counted in commitsReviewPatch, not implementation", () => {
    const result = classifyCommits(
      [
        { messageHeadline: "feat: add the thing" },
        { messageHeadline: "fix: address review findings on #42 (nit)" },
      ],
      42,
      0,
    );
    expect(result).toEqual({
      commitsDocsRefresh: 0,
      commitsReviewPatch: 1,
      commitsCiFix: 0,
      commitsImplementation: 1,
    });
  });

  test("a review-patch-shaped headline for a DIFFERENT PR number does not match — falls into implementation", () => {
    const result = classifyCommits(
      [{ messageHeadline: "fix: address review findings on #99" }],
      42,
      0,
    );
    expect(result).toEqual({
      commitsDocsRefresh: 0,
      commitsReviewPatch: 0,
      commitsCiFix: 0,
      commitsImplementation: 1,
    });
  });

  test("ci-fix attributed via the matched task row's ciFixAttempts, not derived from commit messages", () => {
    const result = classifyCommits(
      [
        { messageHeadline: "feat: add the thing" },
        { messageHeadline: "feat: add another thing" },
        { messageHeadline: "feat: yet another thing" },
      ],
      42,
      2,
    );
    expect(result).toEqual({
      commitsDocsRefresh: 0,
      commitsReviewPatch: 0,
      commitsCiFix: 2,
      commitsImplementation: 1,
    });
  });

  test("ciFixAttempts exceeding the available commits is clamped to the remaining budget, keeping the buckets summing to commitCount", () => {
    const result = classifyCommits(
      [{ messageHeadline: "feat: add the thing" }],
      42,
      5,
    );
    // commitsCiFix is clamped to 1 (the whole commit count), NOT copied
    // verbatim as 5 — the four buckets must sum to commitCount.
    expect(result).toEqual({
      commitsDocsRefresh: 0,
      commitsReviewPatch: 0,
      commitsCiFix: 1,
      commitsImplementation: 0,
    });
  });

  test("ciFixAttempts exceeding only the post-message-bucket budget is clamped to that budget, not to commitCount", () => {
    const result = classifyCommits(
      [
        { messageHeadline: "docs: refresh docs/agent.md" },
        { messageHeadline: "fix: address review findings on #42" },
        { messageHeadline: "fix: make CI green" },
      ],
      42,
      9,
    );
    expect(result).toEqual({
      commitsDocsRefresh: 1,
      commitsReviewPatch: 1,
      commitsCiFix: 1, // 3 commits - 1 docs - 1 review-patch = 1 left
      commitsImplementation: 0,
    });
  });

  test("zero commits with a non-zero ciFixAttempts: every bucket is 0 (nothing to attribute)", () => {
    expect(classifyCommits([], 42, 3)).toEqual({
      commitsDocsRefresh: 0,
      commitsReviewPatch: 0,
      commitsCiFix: 0,
      commitsImplementation: 0,
    });
  });

  test("a negative ciFixAttempts never yields a negative bucket or an inflated implementation count", () => {
    expect(
      classifyCommits([{ messageHeadline: "feat: add the thing" }], 42, -4),
    ).toEqual({
      commitsDocsRefresh: 0,
      commitsReviewPatch: 0,
      commitsCiFix: 0,
      commitsImplementation: 1,
    });
  });

  test("the four buckets sum to commitCount for every ciFixAttempts value, clamped or not", () => {
    const commits = [
      { messageHeadline: "docs: refresh docs/agent.md" },
      { messageHeadline: "fix: address review findings on #42" },
      { messageHeadline: "feat: build the thing" },
      { messageHeadline: "test: cover the thing" },
    ];
    for (const ciFixAttempts of [0, 1, 2, 3, 7, 100]) {
      const result = classifyCommits(commits, 42, ciFixAttempts);
      const sum =
        result.commitsDocsRefresh +
        result.commitsReviewPatch +
        result.commitsCiFix +
        result.commitsImplementation;
      expect(sum).toBe(commits.length);
      expect(result.commitsCiFix).toBeGreaterThanOrEqual(0);
      expect(result.commitsImplementation).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── buildCensusEntry ───────────────────────────────────────────────────────

describe("buildCensusEntry", () => {
  test("shipwright-origin PR (task row match): commitCount + all four breakdown buckets populated, summing to commitCount", () => {
    const entry = buildCensusEntry(
      "org/repo",
      pr({
        number: 7,
        commits: [
          { messageHeadline: "docs: refresh docs/agent.md" },
          { messageHeadline: "fix: address review findings on #7" },
          { messageHeadline: "feat: build the thing" },
          { messageHeadline: "feat: build more of the thing" },
        ],
      }),
      new Map([[7, { pr: 7, ciFixAttempts: 1 }]]),
    );

    expect(entry.origin).toBe("shipwright");
    expect(entry.commitCount).toBe(4);
    expect(entry.commitsDocsRefresh).toBe(1);
    expect(entry.commitsReviewPatch).toBe(1);
    expect(entry.commitsCiFix).toBe(1);
    expect(entry.commitsImplementation).toBe(1);
    expect(
      (entry.commitsDocsRefresh ?? 0) +
        (entry.commitsReviewPatch ?? 0) +
        (entry.commitsCiFix ?? 0) +
        (entry.commitsImplementation ?? 0),
    ).toBe(entry.commitCount ?? -1);
  });

  test("task row present but ciFixAttempts unset: treated as 0, not null, for the arithmetic", () => {
    const entry = buildCensusEntry(
      "org/repo",
      pr({
        number: 8,
        commits: [{ messageHeadline: "feat: build the thing" }],
      }),
      new Map([[8, { pr: 8 }]]),
    );

    expect(entry.commitCount).toBe(1);
    expect(entry.commitsCiFix).toBe(0);
    expect(entry.commitsImplementation).toBe(1);
  });

  test("non-shipwright-origin PR (no task row): commitCount populated but all four breakdown buckets are null", () => {
    const entry = buildCensusEntry(
      "org/repo",
      pr({
        number: 9,
        author: { login: "some-human" },
        commits: [
          { messageHeadline: "docs: refresh docs/agent.md" },
          { messageHeadline: "feat: do the thing" },
        ],
      }),
      new Map(), // no task row for PR #9
    );

    expect(entry.origin).toBe("human");
    expect(entry.commitCount).toBe(2);
    expect(entry.commitsDocsRefresh).toBeNull();
    expect(entry.commitsReviewPatch).toBeNull();
    expect(entry.commitsCiFix).toBeNull();
    expect(entry.commitsImplementation).toBeNull();
  });

  test("shipwright-origin PR whose ciFixAttempts exceeds its commit count: buckets still sum to commitCount", () => {
    const entry = buildCensusEntry(
      "org/repo",
      pr({
        number: 11,
        commits: [{ messageHeadline: "feat: build the thing" }],
      }),
      new Map([[11, { pr: 11, ciFixAttempts: 6 }]]),
    );

    expect(entry.commitCount).toBe(1);
    expect(entry.commitsCiFix).toBe(1); // clamped from 6
    expect(entry.commitsImplementation).toBe(0);
    expect(
      (entry.commitsDocsRefresh ?? 0) +
        (entry.commitsReviewPatch ?? 0) +
        (entry.commitsCiFix ?? 0) +
        (entry.commitsImplementation ?? 0),
    ).toBe(entry.commitCount ?? -1);
  });

  test("zero-commit PR with a task row match: commitCount 0, all four breakdown buckets 0", () => {
    const entry = buildCensusEntry(
      "org/repo",
      pr({ number: 10, commits: [] }),
      new Map([[10, { pr: 10, ciFixAttempts: 0 }]]),
    );

    expect(entry.commitCount).toBe(0);
    expect(entry.commitsDocsRefresh).toBe(0);
    expect(entry.commitsReviewPatch).toBe(0);
    expect(entry.commitsCiFix).toBe(0);
    expect(entry.commitsImplementation).toBe(0);
  });

  // ── POF-1.2: reads is_bot off pr.author and labels off pr.labels ──────────

  test("pr.author.is_bot=true with a gh-normalized 'app/renovate' login classifies as dependency_bot", () => {
    const entry = buildCensusEntry(
      "org/repo",
      pr({
        number: 20,
        author: { login: "app/renovate", is_bot: true },
      }),
      new Map(),
    );

    expect(entry.origin).toBe("dependency_bot");
  });

  test("pr.labels containing 'automated' classifies as ci even with a human-looking authorLogin", () => {
    const entry = buildCensusEntry(
      "org/repo",
      pr({
        number: 21,
        author: { login: "some-human" },
        labels: [{ name: "automated" }],
      }),
      new Map(),
    );

    expect(entry.origin).toBe("ci");
  });

  test("pr.labels containing 'shipwright' classifies as shipwright even with no task row match", () => {
    const entry = buildCensusEntry(
      "org/repo",
      pr({
        number: 22,
        author: { login: "some-human" },
        labels: [{ name: "shipwright" }],
      }),
      new Map(),
    );

    expect(entry.origin).toBe("shipwright");
  });

  test("missing labels array and missing is_bot are treated as falsy, not an error", () => {
    const entry = buildCensusEntry(
      "org/repo",
      pr({ number: 23, author: { login: "some-human" } }),
      new Map(),
    );

    expect(entry.origin).toBe("human");
  });
});

// ─── runPrCensus ────────────────────────────────────────────────────────────

describe("runPrCensus", () => {
  test("stored cursor: issues exactly one gh pr list --search call per scoped repo with merged:>=<cursor>", async () => {
    const { deps, ghCalls } = makeDeps({
      scopedRepos: ["org/repo-a"],
      cursorsByRepo: { "org/repo-a": "2026-09-01T00:00:00.000Z" },
      mergedPrsByRepo: { "org/repo-a": [] },
    });

    await runPrCensus(deps);

    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0].args).toContain("--search");
    expect(ghCalls[0].args).toContain("merged:>=2026-09-01T00:00:00.000Z");
    expect(ghCalls[0].args).toContain("--state");
    expect(ghCalls[0].args).toContain("merged");
  });

  test("no stored cursor (first run): issues zero gh pr list --search calls and zero POSTs for that repo", async () => {
    const { deps, ghCalls, postCalls } = makeDeps({
      scopedRepos: ["org/repo-a"],
      cursorsByRepo: {}, // undefined -> null cursor
    });

    await runPrCensus(deps);

    expect(ghCalls).toHaveLength(0);
    expect(postCalls).toHaveLength(0);
  });

  test("two repos x mixed merged PRs: one POST per repo with non-empty results, ordered ascending by mergedAt; zero POSTs for a repo with no new merged PRs", async () => {
    const { deps, postCalls } = makeDeps({
      scopedRepos: ["org/repo-a", "org/repo-b"],
      cursorsByRepo: {
        "org/repo-a": "2026-09-01T00:00:00.000Z",
        "org/repo-b": "2026-09-01T00:00:00.000Z",
      },
      mergedPrsByRepo: {
        "org/repo-a": [
          pr({
            number: 10,
            author: { login: "renovate[bot]" },
            mergedAt: "2026-09-03T00:00:00.000Z",
          }),
          pr({
            number: 5,
            author: { login: "some-human" },
            mergedAt: "2026-09-02T00:00:00.000Z",
          }),
        ],
        "org/repo-b": [], // no new merged PRs
      },
      tasksByRepo: {
        "org/repo-a": [{ pr: 999 }],
      },
    });

    await runPrCensus(deps);

    const repoAPosts = postCalls.filter((c) => c.repo === "org/repo-a");
    const repoBPosts = postCalls.filter((c) => c.repo === "org/repo-b");

    expect(repoAPosts).toHaveLength(1);
    expect(repoBPosts).toHaveLength(0);

    const entries = repoAPosts[0].entries;
    expect(entries.map((e) => e.prNumber)).toEqual([5, 10]); // ascending by mergedAt
    expect(entries[0].origin).toBe("human");
    expect(entries[1].origin).toBe("dependency_bot");
  });

  test("classifies a task-row match as shipwright using the fetched task list", async () => {
    const { deps, postCalls } = makeDeps({
      scopedRepos: ["org/repo-a"],
      cursorsByRepo: { "org/repo-a": "2026-09-01T00:00:00.000Z" },
      mergedPrsByRepo: {
        "org/repo-a": [pr({ number: 42, author: { login: "some-human" } })],
      },
      tasksByRepo: {
        "org/repo-a": [{ pr: 42 }],
      },
    });

    await runPrCensus(deps);

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0].entries[0].origin).toBe("shipwright");
  });

  test("requests commits in the --json field list, and threads the matched task row's ciFixAttempts through to commitsCiFix", async () => {
    const { deps, ghCalls, postCalls } = makeDeps({
      scopedRepos: ["org/repo-a"],
      cursorsByRepo: { "org/repo-a": "2026-09-01T00:00:00.000Z" },
      mergedPrsByRepo: {
        "org/repo-a": [
          pr({
            number: 42,
            author: { login: "some-human" },
            commits: [
              { messageHeadline: "feat: build the thing" },
              { messageHeadline: "feat: build more of the thing" },
            ],
          }),
        ],
      },
      tasksByRepo: {
        "org/repo-a": [{ pr: 42, ciFixAttempts: 1 }],
      },
    });

    await runPrCensus(deps);

    expect(ghCalls[0].args).toContain(
      "number,title,author,headRefName,createdAt,mergedAt,commits,labels",
    );

    const entry = postCalls[0].entries[0];
    expect(entry.commitCount).toBe(2);
    expect(entry.commitsCiFix).toBe(1);
    expect(entry.commitsImplementation).toBe(1);
  });

  test("non-shipwright-origin PR in a full sweep: commitCount populated, all four breakdown buckets null", async () => {
    const { deps, postCalls } = makeDeps({
      scopedRepos: ["org/repo-a"],
      cursorsByRepo: { "org/repo-a": "2026-09-01T00:00:00.000Z" },
      mergedPrsByRepo: {
        "org/repo-a": [
          pr({
            number: 43,
            author: { login: "some-human" },
            commits: [{ messageHeadline: "feat: manual fix" }],
          }),
        ],
      },
      tasksByRepo: { "org/repo-a": [] }, // no task row for PR #43
    });

    await runPrCensus(deps);

    const entry = postCalls[0].entries[0];
    expect(entry.origin).toBe("human");
    expect(entry.commitCount).toBe(1);
    expect(entry.commitsDocsRefresh).toBeNull();
    expect(entry.commitsReviewPatch).toBeNull();
    expect(entry.commitsCiFix).toBeNull();
    expect(entry.commitsImplementation).toBeNull();
  });

  test("a failed POST for repo A does not stop repo B from being processed in the same tick", async () => {
    const { deps, postCalls } = makeDeps({
      scopedRepos: ["org/repo-a", "org/repo-b"],
      cursorsByRepo: {
        "org/repo-a": "2026-09-01T00:00:00.000Z",
        "org/repo-b": "2026-09-01T00:00:00.000Z",
      },
      mergedPrsByRepo: {
        "org/repo-a": [pr({ number: 1 })],
        "org/repo-b": [pr({ number: 2 })],
      },
      postErrors: {
        "org/repo-a": new Error("task-store POST /prs/census → 500"),
      },
    });

    await runPrCensus(deps);

    const repoBPosts = postCalls.filter((c) => c.repo === "org/repo-b");
    expect(repoBPosts).toHaveLength(1);
    expect(repoBPosts[0].entries[0].prNumber).toBe(2);
  });

  test("a failed gh call for repo A does not stop repo B from being processed in the same tick", async () => {
    const { deps, ghCalls, postCalls } = makeDeps({
      scopedRepos: ["org/repo-a", "org/repo-b"],
      cursorsByRepo: {
        "org/repo-a": "2026-09-01T00:00:00.000Z",
        "org/repo-b": "2026-09-01T00:00:00.000Z",
      },
      mergedPrsByRepo: {
        "org/repo-b": [pr({ number: 2 })],
      },
      ghErrors: {
        "org/repo-a": new Error("gh pr list failed (exit 1): rate limited"),
      },
    });

    await runPrCensus(deps);

    expect(ghCalls).toHaveLength(2); // both repos attempted
    expect(postCalls.filter((c) => c.repo === "org/repo-b")).toHaveLength(1);
  });

  test("SHIPWRIGHT_AGENT_PR_CENSUS_ENABLED=false -> zero ghJson calls", async () => {
    const { deps, ghCalls, postCalls } = makeDeps({
      scopedRepos: ["org/repo-a"],
      cursorsByRepo: { "org/repo-a": "2026-09-01T00:00:00.000Z" },
      mergedPrsByRepo: { "org/repo-a": [pr({ number: 1 })] },
      enabled: false,
    });

    await runPrCensus(deps);

    expect(ghCalls).toHaveLength(0);
    expect(postCalls).toHaveLength(0);
  });

  test("chunks a >200-entry batch into multiple POSTs of at most 200 entries each", async () => {
    const manyPrs: GhCensusPr[] = Array.from({ length: 250 }, (_, i) =>
      pr({
        number: i + 1,
        mergedAt: `2026-09-02T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      }),
    );
    const { deps, postCalls } = makeDeps({
      scopedRepos: ["org/repo-a"],
      cursorsByRepo: { "org/repo-a": "2026-09-01T00:00:00.000Z" },
      mergedPrsByRepo: { "org/repo-a": manyPrs },
    });

    await runPrCensus(deps);

    expect(postCalls).toHaveLength(2);
    expect(postCalls[0].entries).toHaveLength(200);
    expect(postCalls[1].entries).toHaveLength(50);
  });

  test("INTERVAL_MS throttle: a second tick within the window is skipped (zero gh calls); once elapsed, it runs", async () => {
    const t0 = new Date("2026-09-16T00:00:00.000Z");
    const { deps, ghCalls } = makeDeps({
      scopedRepos: ["org/repo-a"],
      cursorsByRepo: { "org/repo-a": "2026-09-01T00:00:00.000Z" },
      mergedPrsByRepo: { "org/repo-a": [] },
      intervalMs: 60_000,
      now: t0,
    });

    await runPrCensus(deps); // first tick — always runs
    expect(ghCalls).toHaveLength(1);

    // Second tick, 30s later — inside the 60s window — should be skipped.
    deps.clock = FixedClock(new Date(t0.getTime() + 30_000));
    await runPrCensus(deps);
    expect(ghCalls).toHaveLength(1); // unchanged — throttled

    // Third tick, 61s after the first — outside the window — should run.
    deps.clock = FixedClock(new Date(t0.getTime() + 61_000));
    await runPrCensus(deps);
    expect(ghCalls).toHaveLength(2);
  });

  test("no INTERVAL_MS set: every tick runs with no throttling", async () => {
    const { deps, ghCalls } = makeDeps({
      scopedRepos: ["org/repo-a"],
      cursorsByRepo: { "org/repo-a": "2026-09-01T00:00:00.000Z" },
      mergedPrsByRepo: { "org/repo-a": [] },
    });

    await runPrCensus(deps);
    await runPrCensus(deps);

    expect(ghCalls).toHaveLength(2);
  });
});
