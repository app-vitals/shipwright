/**
 * plugins/shipwright/scripts/check-test-readiness.unit.test.ts
 *
 * Unit tests for check-test-readiness.ts
 *
 * Design: the script exports a `run(deps)` function that accepts injected
 * dependencies, repo-aware (mirrors check-docs-freshness.ts's/check-deploy.ts's
 * resolveAllRepos usage pattern — deps.repos is an array of { repo, dir }
 * pairs). Tests inject stub implementations — no file I/O or git commands
 * are executed.
 *
 * Qualification per repo: has a docs/test-readiness/ directory (the opt-in
 * signal — a repo with no docs/test-readiness/ is NOT the implicit target
 * and must be skipped cleanly, not silently defaulted to). For each
 * qualifying repo, the staleness check (4 phase artifacts, 24h threshold)
 * runs scoped to that repo's own directory.
 */

import { describe, expect, test } from "bun:test";
import { ARTIFACT_PATHS, run, STALE_THRESHOLD_MS } from "./check-test-readiness.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface RepoDir {
  repo: string;
  dir: string;
}

interface MakeDepsOptions {
  repos?: RepoDir[];
  hasTestReadinessDir?: (dir: string) => boolean;
  getMtimeMs?: (dir: string, path: string) => number | null;
  now?: () => number;
}

const NOW = 1_000_000_000_000;

const SINGLE_REPO: RepoDir = {
  repo: "acme/example-repo",
  dir: "/repos/example-repo",
};

function makeDeps(overrides: MakeDepsOptions = {}) {
  return {
    repos: overrides.repos ?? [SINGLE_REPO],
    hasTestReadinessDir: overrides.hasTestReadinessDir ?? (() => true),
    getMtimeMs: overrides.getMtimeMs ?? (() => NOW),
    now: overrides.now ?? (() => NOW),
  };
}

// ─── Single-repo behavior (AC #5 — unchanged when only one repo configured) ───

describe("check-test-readiness — single repo (unchanged behavior)", () => {
  test("exits 1 with empty output when all 4 artifacts are fresh", async () => {
    const deps = makeDeps({ getMtimeMs: () => NOW });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 with a summary when one artifact is stale (old mtime)", async () => {
    const staleMtime = NOW - (STALE_THRESHOLD_MS + 1);
    const deps = makeDeps({
      getMtimeMs: (_dir, path) => (path === ARTIFACT_PATHS[1] ? staleMtime : NOW),
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain(ARTIFACT_PATHS[1]);
  });

  test("exits 0 (treated as stale) when an artifact is missing entirely", async () => {
    const deps = makeDeps({
      getMtimeMs: (_dir, path) => (path === ARTIFACT_PATHS[2] ? null : NOW),
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain(ARTIFACT_PATHS[2]);
  });

  test("exits 0 and lists all stale artifacts when multiple are stale", async () => {
    const staleMtime = NOW - (STALE_THRESHOLD_MS + 1);
    const deps = makeDeps({
      getMtimeMs: (_dir, path) => {
        if (path === ARTIFACT_PATHS[0]) return staleMtime;
        if (path === ARTIFACT_PATHS[3]) return null;
        return NOW;
      },
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain(ARTIFACT_PATHS[0]);
    expect(result.output).toContain(ARTIFACT_PATHS[3]);
    expect(result.output).not.toContain(ARTIFACT_PATHS[1]);
    expect(result.output).not.toContain(ARTIFACT_PATHS[2]);
  });

  test("treats mtime exactly at the 24h boundary as fresh (permissive on boundary)", async () => {
    const boundaryMtime = NOW - STALE_THRESHOLD_MS;
    const deps = makeDeps({ getMtimeMs: () => boundaryMtime });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 output includes the repo's org/repo name", async () => {
    const staleMtime = NOW - (STALE_THRESHOLD_MS + 1);
    const deps = makeDeps({ getMtimeMs: () => staleMtime });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("acme/example-repo");
  });

  test("exits 1 when no repos are configured", async () => {
    const result = await run(makeDeps({ repos: [] }));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });
});

// ─── Opt-in qualification (AC #3 — docs/test-readiness/ required) ─────────────

describe("check-test-readiness — opt-in qualification", () => {
  test("skips a repo with no docs/test-readiness/ directory cleanly — no mtime read, no output", async () => {
    const noOptIn: RepoDir = { repo: "acme/no-opt-in", dir: "/repos/no-opt-in" };
    const seenDirs: string[] = [];

    const deps = makeDeps({
      repos: [noOptIn],
      hasTestReadinessDir: () => false,
      getMtimeMs: (dir) => {
        seenDirs.push(dir);
        return NOW;
      },
    });

    const result = await run(deps);
    expect(seenDirs).not.toContain("/repos/no-opt-in");
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("does not silently treat an opted-out repo as the implicit target", async () => {
    const noOptIn: RepoDir = { repo: "acme/no-opt-in", dir: "/repos/no-opt-in" };
    const optedIn: RepoDir = { repo: "acme/opted-in", dir: "/repos/opted-in" };

    const staleMtime = NOW - (STALE_THRESHOLD_MS + 1);
    const deps = makeDeps({
      repos: [noOptIn, optedIn],
      hasTestReadinessDir: (dir) => dir === "/repos/opted-in",
      getMtimeMs: () => staleMtime,
    });

    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).not.toContain("acme/no-opt-in");
    expect(result.output).toContain("acme/opted-in");
  });

  test("exits 1 when every configured repo lacks docs/test-readiness/", async () => {
    const repoA: RepoDir = { repo: "acme/repo-a", dir: "/repos/repo-a" };
    const repoB: RepoDir = { repo: "acme/repo-b", dir: "/repos/repo-b" };

    const deps = makeDeps({
      repos: [repoA, repoB],
      hasTestReadinessDir: () => false,
    });

    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });
});

// ─── Multi-repo behavior (AC #1, #2, #6) ──────────────────────────────────────

describe("check-test-readiness — multi repo", () => {
  test("iterates every configured repo independently, scoping the staleness check per repo dir", async () => {
    const repoA: RepoDir = { repo: "acme/repo-a", dir: "/repos/repo-a" };
    const repoB: RepoDir = { repo: "acme/repo-b", dir: "/repos/repo-b" };

    const staleMtime = NOW - (STALE_THRESHOLD_MS + 1);
    const mtimes: Record<string, number> = {
      "/repos/repo-a": NOW, // fresh
      "/repos/repo-b": staleMtime, // stale
    };

    const deps = makeDeps({
      repos: [repoA, repoB],
      getMtimeMs: (dir) => mtimes[dir] ?? NOW,
    });

    const result = await run(deps);
    expect(result.exit).toBe(0);
    // repo-a is fresh — should not appear
    expect(result.output).not.toContain("acme/repo-a");
    // repo-b is stale — should be identified by repo
    expect(result.output).toContain("acme/repo-b");
  });

  test("a repo whose mtime lookups fail does not block findings in another repo", async () => {
    const failingRepo: RepoDir = {
      repo: "acme/failing-repo",
      dir: "/repos/failing-repo",
    };
    const goodRepo: RepoDir = { repo: "acme/good-repo", dir: "/repos/good-repo" };

    const staleMtime = NOW - (STALE_THRESHOLD_MS + 1);
    const deps = makeDeps({
      repos: [failingRepo, goodRepo],
      hasTestReadinessDir: (dir) => {
        if (dir === "/repos/failing-repo") throw new Error("fs error");
        return true;
      },
      getMtimeMs: (dir) => (dir === "/repos/good-repo" ? staleMtime : NOW),
    });

    const result = await run(deps);
    expect(result.exit).toBe(0);
    // Permissive: failing repo still surfaces (unknown state, worth checking)
    expect(result.output).toContain("acme/failing-repo");
    // Good repo's real finding is not suppressed by the other repo's failure
    expect(result.output).toContain("acme/good-repo");
  });

  test("exits 1 when every configured repo has fresh artifacts", async () => {
    const repoA: RepoDir = { repo: "acme/repo-a", dir: "/repos/repo-a" };
    const repoB: RepoDir = { repo: "acme/repo-b", dir: "/repos/repo-b" };

    const deps = makeDeps({
      repos: [repoA, repoB],
      getMtimeMs: () => NOW,
    });

    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("identifies which repo(s) need a test-readiness run in the output, one section per repo", async () => {
    const repoA: RepoDir = { repo: "acme/repo-a", dir: "/repos/repo-a" };
    const repoB: RepoDir = { repo: "acme/repo-b", dir: "/repos/repo-b" };

    const staleMtime = NOW - (STALE_THRESHOLD_MS + 1);
    const deps = makeDeps({
      repos: [repoA, repoB],
      getMtimeMs: () => staleMtime,
    });

    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("acme/repo-a");
    expect(result.output).toContain("acme/repo-b");
  });
});
