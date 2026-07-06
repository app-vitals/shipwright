/**
 * plugins/shipwright/scripts/check-dependabot-triage.test.ts
 *
 * Unit tests for check-dependabot-triage.ts
 *
 * Design: the script exports a `run(deps)` function with injectable deps
 * for repo resolution, open Dependabot PR listing, and state reading.
 * No file I/O or gh CLI calls are made in tests.
 */

import { describe, expect, test } from "bun:test";
import type { Deps, PrInfo, StateEntry } from "./check-dependabot-triage.ts";
import { run } from "./check-dependabot-triage.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 42,
    title: "Bump axios from 1.6.0 to 1.7.0",
    headRefName: "dependabot/npm_and_yarn/axios-1.7.0",
    ...overrides,
  };
}

function makeStateEntry(overrides: Partial<StateEntry> = {}): StateEntry {
  return {
    pr: 42,
    repo: "example-repo",
    org: "example-org",
    title: "Bump axios from 1.6.0 to 1.7.0",
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

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    resolveRepos:
      overrides.resolveRepos ?? (() => ["example-org/example-repo"]),
    listOpenDependabotPrs:
      overrides.listOpenDependabotPrs ?? (async (_repo: string) => []),
    readState: overrides.readState ?? (() => []),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("check-dependabot-triage", () => {
  test("exits 1 when there are no open dependabot PRs (across all repos)", async () => {
    const deps = makeDeps({
      resolveRepos: () => ["example-org/example-repo"],
      listOpenDependabotPrs: async () => [],
      readState: () => [],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when all open dependabot PRs already have a non-terminal state entry", async () => {
    const pr = makePr({ number: 42 });
    const deps = makeDeps({
      resolveRepos: () => ["example-org/example-repo"],
      listOpenDependabotPrs: async () => [pr],
      readState: () => [
        makeStateEntry({
          pr: 42,
          repo: "example-repo",
          org: "example-org",
          status: "staged",
        }),
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when at least one open dependabot PR has no corresponding non-terminal entry", async () => {
    const pr = makePr({ number: 42 });
    const deps = makeDeps({
      resolveRepos: () => ["example-org/example-repo"],
      listOpenDependabotPrs: async () => [pr],
      readState: () => [],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 0 when zero repos are configured is NOT the case — zero repos means zero PRs, exits 1", async () => {
    const deps = makeDeps({
      resolveRepos: () => [],
      listOpenDependabotPrs: async () => {
        throw new Error("should not be called for zero repos");
      },
      readState: () => [],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when a PR has only a terminal (merged) state entry — still needs triage", async () => {
    const pr = makePr({ number: 42 });
    const deps = makeDeps({
      resolveRepos: () => ["example-org/example-repo"],
      listOpenDependabotPrs: async () => [pr],
      readState: () => [
        makeStateEntry({
          pr: 42,
          repo: "example-repo",
          org: "example-org",
          status: "merged",
        }),
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 0 when a PR has only a terminal (closed) state entry — still needs triage", async () => {
    const pr = makePr({ number: 7 });
    const deps = makeDeps({
      resolveRepos: () => ["example-org/example-repo"],
      listOpenDependabotPrs: async () => [pr],
      readState: () => [
        makeStateEntry({
          pr: 7,
          repo: "example-repo",
          org: "example-org",
          status: "closed",
        }),
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("multi-repo: all PRs across repos already triaged (non-terminal) — exits 1", async () => {
    const prA = makePr({ number: 1 });
    const prB = makePr({ number: 2 });
    const deps = makeDeps({
      resolveRepos: () => ["org/repo-a", "org/repo-b"],
      listOpenDependabotPrs: async (repo: string) =>
        repo === "org/repo-a" ? [prA] : [prB],
      readState: () => [
        makeStateEntry({ pr: 1, repo: "repo-a", org: "org", status: "posted" }),
        makeStateEntry({
          pr: 2,
          repo: "repo-b",
          org: "org",
          status: "pending",
        }),
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("multi-repo: one repo has an untriaged PR — exits 0", async () => {
    const prA = makePr({ number: 1 });
    const prB = makePr({ number: 2 });
    const deps = makeDeps({
      resolveRepos: () => ["org/repo-a", "org/repo-b"],
      listOpenDependabotPrs: async (repo: string) =>
        repo === "org/repo-a" ? [prA] : [prB],
      readState: () => [
        makeStateEntry({ pr: 1, repo: "repo-a", org: "org", status: "posted" }),
        // repo-b PR #2 has no entry at all
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("does not match a state entry from a different repo with the same PR number", async () => {
    const pr = makePr({ number: 42 });
    const deps = makeDeps({
      resolveRepos: () => ["org/repo-a"],
      listOpenDependabotPrs: async () => [pr],
      readState: () => [
        makeStateEntry({
          pr: 42,
          repo: "repo-b", // different repo, same PR number
          org: "org",
          status: "staged",
        }),
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 1 when repos exist but zero repos return any PRs", async () => {
    const deps = makeDeps({
      resolveRepos: () => ["org/repo-a", "org/repo-b"],
      listOpenDependabotPrs: async () => [],
      readState: () => [],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 (permissive) when listOpenDependabotPrs throws (gh CLI failure)", async () => {
    const deps = makeDeps({
      resolveRepos: () => ["org/repo-a"],
      listOpenDependabotPrs: async () => {
        throw new Error("gh pr list failed");
      },
      readState: () => [],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });
});
