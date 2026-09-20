/**
 * agent/src/pr-origin-backfill.unit.test.ts
 *
 * Unit tests for POB-1.1's one-off historical PR-origin backfill:
 *   - buildBackfillEntries()'s cutoff-boundary filtering (exactly-at/just
 *     before/just-after cutoff, null mergedAt excluded), ascending sort by
 *     mergedAt, and confirmation that classification is delegated to
 *     pr-census.ts's classifyPrOrigin()/buildCensusEntry() rather than
 *     reimplemented.
 *   - runBackfillForRepo()'s >200-entry chunking into multiple
 *     postCensusBatch calls, and per-repo error isolation (a thrown
 *     ghJson/postCensusBatch error is caught and surfaced in the returned
 *     summary, never thrown to the caller).
 *   - runBackfill()'s per-repo continue-on-error orchestration.
 *
 * Uses fully injected ghJson/task-store-HTTP doubles — no real fetch, no gh
 * CLI, no global.fetch/global.* overrides — per this repo's unit-test
 * isolation contract. Modeled on pr-census.unit.test.ts's fake-deps pattern.
 */

import { describe, expect, test } from "bun:test";
import type { CensusEntry, CensusTaskRecord, GhCensusPr } from "./pr-census.ts";
import {
  type BackfillDeps,
  buildBackfillEntries,
  runBackfill,
  runBackfillForRepo,
} from "./pr-origin-backfill.ts";

// ─── Fakes ────────────────────────────────────────────────────────────────────

interface MakeDepsOptions {
  /** repo -> gh pr list result for that repo's plain merged-PR listing. */
  mergedPrsByRepo?: Record<string, GhCensusPr[]>;
  /** repo -> task-store tasks with pr set. */
  tasksByRepo?: Record<string, CensusTaskRecord[]>;
  /** repo -> Error to throw from ghJson (the gh pr list call) for that repo. */
  ghErrors?: Record<string, Error>;
  /** repo -> Error to throw from postCensusBatch for that repo. */
  postErrors?: Record<string, Error>;
}

function makeDeps(opts: MakeDepsOptions = {}): {
  deps: BackfillDeps;
  ghCalls: Array<{ repo: string; args: string[] }>;
  postCalls: Array<{ repo: string; entries: CensusEntry[] }>;
} {
  const {
    mergedPrsByRepo = {},
    tasksByRepo = {},
    ghErrors = {},
    postErrors = {},
  } = opts;

  const ghCalls: Array<{ repo: string; args: string[] }> = [];
  const postCalls: Array<{ repo: string; entries: CensusEntry[] }> = [];

  const deps: BackfillDeps = {
    ghJson: async <T>(args: string[]): Promise<T> => {
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] : "";
      ghCalls.push({ repo, args });
      const err = ghErrors[repo];
      if (err) throw err;
      return (mergedPrsByRepo[repo] ?? []) as unknown as T;
    },
    listTasksWithPr: async (repo: string) => tasksByRepo[repo] ?? [],
    postCensusBatch: async (repo: string, entries: CensusEntry[]) => {
      postCalls.push({ repo, entries });
      const err = postErrors[repo];
      if (err) throw err;
    },
  };

  return { deps, ghCalls, postCalls };
}

function pr(overrides: Partial<GhCensusPr>): GhCensusPr {
  return {
    number: 1,
    title: "Some PR",
    author: { login: "someone" },
    headRefName: "feat/some-branch",
    createdAt: "2026-06-01T00:00:00.000Z",
    mergedAt: "2026-06-02T00:00:00.000Z",
    ...overrides,
  };
}

const CUTOFF = "2026-06-21T00:00:00.000Z"; // 90 days before 2026-09-19, illustratively

// ─── buildBackfillEntries ───────────────────────────────────────────────────

describe("buildBackfillEntries", () => {
  test("PR merged exactly at the cutoff is included", () => {
    const entries = buildBackfillEntries(
      "org/repo",
      [pr({ number: 1, mergedAt: CUTOFF })],
      CUTOFF,
      new Set(),
    );
    expect(entries.map((e) => e.prNumber)).toEqual([1]);
  });

  test("PR merged just before the cutoff is excluded", () => {
    const justBefore = new Date(new Date(CUTOFF).getTime() - 1).toISOString();
    const entries = buildBackfillEntries(
      "org/repo",
      [pr({ number: 1, mergedAt: justBefore })],
      CUTOFF,
      new Set(),
    );
    expect(entries).toHaveLength(0);
  });

  test("PR merged just after the cutoff is included", () => {
    const justAfter = new Date(new Date(CUTOFF).getTime() + 1).toISOString();
    const entries = buildBackfillEntries(
      "org/repo",
      [pr({ number: 1, mergedAt: justAfter })],
      CUTOFF,
      new Set(),
    );
    expect(entries.map((e) => e.prNumber)).toEqual([1]);
  });

  test("PR with null mergedAt is excluded", () => {
    const entries = buildBackfillEntries(
      "org/repo",
      [pr({ number: 1, mergedAt: null })],
      CUTOFF,
      new Set(),
    );
    expect(entries).toHaveLength(0);
  });

  test("in-window results are sorted ascending by mergedAt", () => {
    const entries = buildBackfillEntries(
      "org/repo",
      [
        pr({ number: 3, mergedAt: "2026-07-03T00:00:00.000Z" }),
        pr({ number: 1, mergedAt: "2026-07-01T00:00:00.000Z" }),
        pr({ number: 2, mergedAt: "2026-07-02T00:00:00.000Z" }),
      ],
      CUTOFF,
      new Set(),
    );
    expect(entries.map((e) => e.prNumber)).toEqual([1, 2, 3]);
  });

  test("delegates classification to classifyPrOrigin/buildCensusEntry rather than reimplementing it: a task-row match beats a dependency-bot-triggering author login", () => {
    const entries = buildBackfillEntries(
      "org/repo",
      [
        pr({
          number: 42,
          author: { login: "renovate[bot]" },
          mergedAt: "2026-07-01T00:00:00.000Z",
        }),
      ],
      CUTOFF,
      new Set([42]),
    );
    // classifyPrOrigin's documented precedence: a task-row match wins over
    // an author login that would otherwise say dependency_bot. If this
    // module reimplemented classification independently rather than
    // delegating, it would be easy to get this precedence wrong (e.g.
    // classify by author login alone) — asserting on it here pins the
    // delegation.
    expect(entries[0].origin).toBe("shipwright");
    expect(entries[0].repo).toBe("org/repo");
  });

  test("no task-row match: dependency-bot author classifies as dependency_bot via classifyPrOrigin", () => {
    const entries = buildBackfillEntries(
      "org/repo",
      [
        pr({
          number: 7,
          author: { login: "dependabot[bot]" },
          mergedAt: "2026-07-01T00:00:00.000Z",
        }),
      ],
      CUTOFF,
      new Set(),
    );
    expect(entries[0].origin).toBe("dependency_bot");
  });
});

// ─── runBackfillForRepo ─────────────────────────────────────────────────────

describe("runBackfillForRepo", () => {
  test("fetches, classifies, and posts a single batch when at or under the chunk size", async () => {
    const { deps, postCalls } = makeDeps({
      mergedPrsByRepo: {
        "org/repo-a": [
          pr({ number: 1, mergedAt: "2026-07-01T00:00:00.000Z" }),
          pr({
            number: 2,
            author: { login: "some-human" },
            mergedAt: "2026-07-02T00:00:00.000Z",
          }),
        ],
      },
    });

    const summary = await runBackfillForRepo(deps, "org/repo-a", CUTOFF);

    expect(summary.error).toBeNull();
    expect(summary.fetchedCount).toBe(2);
    expect(summary.inWindowCount).toBe(2);
    expect(summary.batchesPosted).toBe(1);
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0].entries.map((e) => e.prNumber)).toEqual([1, 2]);
  });

  test("chunks a >200-entry batch into multiple postCensusBatch calls of at most 200 entries each", async () => {
    const manyPrs: GhCensusPr[] = Array.from({ length: 250 }, (_, i) =>
      pr({
        number: i + 1,
        mergedAt: `2026-07-02T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      }),
    );
    const { deps, postCalls } = makeDeps({
      mergedPrsByRepo: { "org/repo-a": manyPrs },
    });

    const summary = await runBackfillForRepo(deps, "org/repo-a", CUTOFF);

    expect(summary.error).toBeNull();
    expect(summary.fetchedCount).toBe(250);
    expect(summary.inWindowCount).toBe(250);
    expect(summary.batchesPosted).toBe(2);
    expect(postCalls).toHaveLength(2);
    expect(postCalls[0].entries).toHaveLength(200);
    expect(postCalls[1].entries).toHaveLength(50);
  });

  test("zero in-window entries after filtering: zero POSTs", async () => {
    const { deps, postCalls } = makeDeps({
      mergedPrsByRepo: {
        "org/repo-a": [
          pr({
            number: 1,
            mergedAt: new Date(new Date(CUTOFF).getTime() - 1).toISOString(),
          }),
        ],
      },
    });

    const summary = await runBackfillForRepo(deps, "org/repo-a", CUTOFF);

    expect(summary.error).toBeNull();
    expect(summary.fetchedCount).toBe(1);
    expect(summary.inWindowCount).toBe(0);
    expect(summary.batchesPosted).toBe(0);
    expect(postCalls).toHaveLength(0);
  });

  test("a thrown ghJson error is caught and surfaced in the summary, not thrown", async () => {
    const { deps } = makeDeps({
      ghErrors: {
        "org/repo-a": new Error("gh pr list failed (exit 1): rate limited"),
      },
    });

    const summary = await runBackfillForRepo(deps, "org/repo-a", CUTOFF);

    expect(summary.error).toContain("rate limited");
    expect(summary.fetchedCount).toBe(0);
    expect(summary.inWindowCount).toBe(0);
    expect(summary.batchesPosted).toBe(0);
  });

  test("a thrown postCensusBatch error is caught and surfaced in the summary, not thrown", async () => {
    const { deps } = makeDeps({
      mergedPrsByRepo: {
        "org/repo-a": [pr({ number: 1, mergedAt: "2026-07-01T00:00:00.000Z" })],
      },
      postErrors: {
        "org/repo-a": new Error("task-store POST /prs/census → 500"),
      },
    });

    const summary = await runBackfillForRepo(deps, "org/repo-a", CUTOFF);

    expect(summary.error).toContain("500");
    // Values computed before the failing POST are still reported.
    expect(summary.fetchedCount).toBe(1);
    expect(summary.inWindowCount).toBe(1);
    expect(summary.batchesPosted).toBe(0);
  });
});

// ─── runBackfill (multi-repo orchestration) ─────────────────────────────────

describe("runBackfill", () => {
  test("a failed repo does not stop the remaining repos in the same run", async () => {
    const { deps, postCalls } = makeDeps({
      mergedPrsByRepo: {
        "org/repo-b": [pr({ number: 2, mergedAt: "2026-07-01T00:00:00.000Z" })],
      },
      ghErrors: {
        "org/repo-a": new Error("gh pr list failed (exit 1): repo not found"),
      },
    });

    const summaries = await runBackfill(
      deps,
      ["org/repo-a", "org/repo-b"],
      CUTOFF,
    );

    expect(summaries).toHaveLength(2);
    expect(summaries[0].repo).toBe("org/repo-a");
    expect(summaries[0].error).toContain("repo not found");
    expect(summaries[1].repo).toBe("org/repo-b");
    expect(summaries[1].error).toBeNull();
    expect(postCalls.filter((c) => c.repo === "org/repo-b")).toHaveLength(1);
  });

  test("origin breakdown tallies classified entries per repo", async () => {
    const { deps } = makeDeps({
      mergedPrsByRepo: {
        "org/repo-a": [
          pr({
            number: 1,
            author: { login: "renovate[bot]" },
            mergedAt: "2026-07-01T00:00:00.000Z",
          }),
          pr({
            number: 2,
            author: { login: "some-human" },
            mergedAt: "2026-07-02T00:00:00.000Z",
          }),
        ],
      },
    });

    const [summary] = await runBackfill(deps, ["org/repo-a"], CUTOFF);

    expect(summary.originBreakdown.dependency_bot).toBe(1);
    expect(summary.originBreakdown.human).toBe(1);
    expect(summary.originBreakdown.ci).toBe(0);
  });
});
