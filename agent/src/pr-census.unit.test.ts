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
  type CensusEntry,
  type CensusTaskRecord,
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
  // order (ci -> dependency_bot -> shipwright -> human -> unknown), the ci/
  // dependency_bot checks run BEFORE the task-row/shipwright check — so an
  // author login that independently triggers ci/dependency_bot wins over a
  // task-row match, not the other way around. This is the interpretation
  // implemented and tested here.
  test("a ci-triggering author login takes precedence over a task-row match", () => {
    expect(
      classifyPrOrigin({
        authorLogin: "github-actions[bot]",
        headRefName: "feat/x",
        hasTaskRowMatch: true,
      }),
    ).toBe("ci");
  });

  test("a dependency_bot-triggering author login takes precedence over a task-row match", () => {
    expect(
      classifyPrOrigin({
        authorLogin: "renovate[bot]",
        headRefName: "renovate/some-dep",
        hasTaskRowMatch: true,
      }),
    ).toBe("dependency_bot");
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
