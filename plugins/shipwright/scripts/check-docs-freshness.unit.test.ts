/**
 * plugins/shipwright/scripts/check-docs-freshness.unit.test.ts
 *
 * Unit tests for check-docs-freshness.ts
 *
 * Design: the script exports a `run(deps)` function that accepts injected
 * dependencies, repo-aware (mirrors check-deploy.ts's/check-review.ts's
 * resolveAllRepos usage pattern — deps.repos is an array of { repo, dir }
 * pairs). Tests inject stub implementations — no file I/O or git commands
 * are executed.
 */

import { describe, expect, test } from "bun:test";
import { run } from "./check-docs-freshness.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface RepoDir {
  repo: string;
  dir: string;
}

interface MakeDepsOptions {
  repos?: RepoDir[];
  hasDocsDir?: (dir: string) => boolean;
  readSyncAnchor?: (dir: string) => string | null;
  getCommitsSince?: (dir: string, sha: string) => string[] | null;
  getChangedFilesSince?: (dir: string, sha: string) => string[] | null;
}

const SINGLE_REPO: RepoDir = {
  repo: "acme/example-repo",
  dir: "/repos/example-repo",
};

function makeDeps(overrides: MakeDepsOptions = {}) {
  return {
    repos: overrides.repos ?? [SINGLE_REPO],
    hasDocsDir: overrides.hasDocsDir ?? (() => true),
    readSyncAnchor: overrides.readSyncAnchor ?? (() => "abc123"),
    getCommitsSince:
      overrides.getCommitsSince ?? ((_dir: string, _sha: string) => []),
    getChangedFilesSince:
      overrides.getChangedFilesSince ?? ((_dir: string, _sha: string) => []),
  };
}

// ─── Single-repo behavior (AC #5 — unchanged when only one repo configured) ───

describe("check-docs-freshness — single repo (unchanged behavior)", () => {
  test("exits 0 (first run) when no sync anchor file exists", async () => {
    const deps = makeDeps({ readSyncAnchor: () => null });
    const result = await run(deps);
    expect(result.exit).toBe(0);
  });

  test("exits 1 when no commits since last sync", async () => {
    const deps = makeDeps({
      readSyncAnchor: () => "abc123",
      getCommitsSince: () => [],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when commits exist but only docs/ files changed", async () => {
    const deps = makeDeps({
      readSyncAnchor: () => "abc123",
      getCommitsSince: () => ["abc456 update docs"],
      getChangedFilesSince: () => ["docs/modules/auth.md", "docs/overview.md"],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when source files have changed since last sync", async () => {
    const deps = makeDeps({
      readSyncAnchor: () => "abc123",
      getCommitsSince: () => ["def789 add feature"],
      getChangedFilesSince: () => [
        "src/auth/handler.ts",
        "src/billing/index.ts",
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
  });

  test("exits 1 when only state/ files changed", async () => {
    const deps = makeDeps({
      readSyncAnchor: () => "abc123",
      getCommitsSince: () => ["def789 update state"],
      getChangedFilesSince: () => [
        "state/todos.json",
        "state/docs-last-synced.json",
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when only .github/ files changed", async () => {
    const deps = makeDeps({
      readSyncAnchor: () => "abc123",
      getCommitsSince: () => ["def789 update ci"],
      getChangedFilesSince: () => [
        ".github/workflows/ci.yml",
        ".github/CODEOWNERS",
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 output includes newline-separated list of changed source files", async () => {
    const changedFiles = ["accounts/src/handler.ts", "billing/src/invoice.ts"];
    const deps = makeDeps({
      readSyncAnchor: () => "abc123",
      getCommitsSince: () => ["def789 add billing feature"],
      getChangedFilesSince: () => changedFiles,
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("accounts/src/handler.ts");
    expect(result.output).toContain("billing/src/invoice.ts");
  });

  test("filters out docs/ files but includes remaining source files", async () => {
    const deps = makeDeps({
      readSyncAnchor: () => "abc123",
      getCommitsSince: () => ["def789 mixed commit"],
      getChangedFilesSince: () => [
        "docs/modules/billing.md",
        "billing/src/invoice.ts",
        "state/todos.json",
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("billing/src/invoice.ts");
    expect(result.output).not.toContain("docs/modules/billing.md");
    expect(result.output).not.toContain("state/todos.json");
  });

  test("exits 0 when getCommitsSince returns null (git failure — permissive)", async () => {
    const deps = makeDeps({ getCommitsSince: () => null });
    const result = await run(deps);
    expect(result.exit).toBe(0);
  });

  test("exits 0 when getChangedFilesSince returns null (git failure — permissive)", async () => {
    const deps = makeDeps({
      getCommitsSince: () => ["abc456 some commit"],
      getChangedFilesSince: () => null,
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
  });

  test("exits 1 when no repos are configured", async () => {
    const result = await run(makeDeps({ repos: [] }));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });
});

// ─── Multi-repo behavior (AC #1, #2, #3, #6) ──────────────────────────────────

describe("check-docs-freshness — multi repo", () => {
  test("iterates every configured repo independently", async () => {
    const repoA: RepoDir = { repo: "acme/repo-a", dir: "/repos/repo-a" };
    const repoB: RepoDir = { repo: "acme/repo-b", dir: "/repos/repo-b" };

    const anchors: Record<string, string | null> = {
      "/repos/repo-a": "sha-a",
      "/repos/repo-b": "sha-b",
    };
    const commits: Record<string, string[]> = {
      "/repos/repo-a": [],
      "/repos/repo-b": ["def456 add billing endpoint"],
    };
    const changedFiles: Record<string, string[]> = {
      "/repos/repo-b": ["billing/src/invoice.ts"],
    };

    const deps = makeDeps({
      repos: [repoA, repoB],
      readSyncAnchor: (dir) => anchors[dir] ?? null,
      getCommitsSince: (dir) => commits[dir] ?? [],
      getChangedFilesSince: (dir) => changedFiles[dir] ?? [],
    });

    const result = await run(deps);
    expect(result.exit).toBe(0);
    // repo-a had no commits since anchor — should not appear
    expect(result.output).not.toContain("acme/repo-a");
    // repo-b had a qualifying source change — should be identified by repo
    expect(result.output).toContain("acme/repo-b");
    expect(result.output).toContain("billing/src/invoice.ts");
  });

  test("reads/writes each repo's own state/docs-last-synced.json independently (anchor keyed by dir)", async () => {
    const repoA: RepoDir = { repo: "acme/repo-a", dir: "/repos/repo-a" };
    const repoB: RepoDir = { repo: "acme/repo-b", dir: "/repos/repo-b" };

    const seenDirs: string[] = [];
    const deps = makeDeps({
      repos: [repoA, repoB],
      readSyncAnchor: (dir) => {
        seenDirs.push(dir);
        // repo-a has no anchor yet (first run); repo-b has an anchor with no changes
        return dir === "/repos/repo-a" ? null : "sha-b";
      },
      getCommitsSince: () => [],
    });

    const result = await run(deps);
    expect(seenDirs).toEqual(["/repos/repo-a", "/repos/repo-b"]);
    // repo-a qualifies (first run); repo-b does not (no commits since its own anchor)
    expect(result.exit).toBe(0);
    expect(result.output).toContain("acme/repo-a");
    expect(result.output).not.toContain("acme/repo-b");
  });

  test("skips a repo with no docs/ directory cleanly — no anchor read, no output", async () => {
    const repoNoDocs: RepoDir = {
      repo: "acme/no-docs-repo",
      dir: "/repos/no-docs-repo",
    };
    const repoWithDocs: RepoDir = {
      repo: "acme/docs-repo",
      dir: "/repos/docs-repo",
    };

    const anchorReadDirs: string[] = [];
    const deps = makeDeps({
      repos: [repoNoDocs, repoWithDocs],
      hasDocsDir: (dir) => dir === "/repos/docs-repo",
      readSyncAnchor: (dir) => {
        anchorReadDirs.push(dir);
        return null;
      },
    });

    const result = await run(deps);

    // The no-docs repo's anchor must never be read (AC #3: skip cleanly).
    expect(anchorReadDirs).not.toContain("/repos/no-docs-repo");
    expect(anchorReadDirs).toContain("/repos/docs-repo");

    expect(result.exit).toBe(0);
    expect(result.output).not.toContain("acme/no-docs-repo");
    expect(result.output).toContain("acme/docs-repo");
  });

  test("exits 1 when every configured repo has no docs/ directory", async () => {
    const repoA: RepoDir = { repo: "acme/no-docs-a", dir: "/repos/no-docs-a" };
    const repoB: RepoDir = { repo: "acme/no-docs-b", dir: "/repos/no-docs-b" };

    const deps = makeDeps({
      repos: [repoA, repoB],
      hasDocsDir: () => false,
    });

    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when every configured repo has docs/ but nothing changed", async () => {
    const repoA: RepoDir = { repo: "acme/repo-a", dir: "/repos/repo-a" };
    const repoB: RepoDir = { repo: "acme/repo-b", dir: "/repos/repo-b" };

    const deps = makeDeps({
      repos: [repoA, repoB],
      getCommitsSince: () => [],
    });

    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("a repo whose git commands fail does not block findings in another repo", async () => {
    const failingRepo: RepoDir = {
      repo: "acme/failing-repo",
      dir: "/repos/failing-repo",
    };
    const goodRepo: RepoDir = {
      repo: "acme/good-repo",
      dir: "/repos/good-repo",
    };

    const deps = makeDeps({
      repos: [failingRepo, goodRepo],
      readSyncAnchor: () => "sha-anchor",
      getCommitsSince: (dir) => {
        if (dir === "/repos/failing-repo") return null; // git failure
        return ["def789 add feature"];
      },
      getChangedFilesSince: (dir) => {
        if (dir === "/repos/good-repo") return ["src/handler.ts"];
        return [];
      },
    });

    const result = await run(deps);
    expect(result.exit).toBe(0);
    // Permissive: failing repo still surfaces (unknown state, worth checking)
    expect(result.output).toContain("acme/failing-repo");
    // Good repo's real finding is not suppressed by the other repo's failure
    expect(result.output).toContain("acme/good-repo");
    expect(result.output).toContain("src/handler.ts");
  });

  test("a repo with docs/ but no prior sync anchor (first run) qualifies without git calls failing the run", async () => {
    const repo: RepoDir = {
      repo: "acme/first-run-repo",
      dir: "/repos/first-run-repo",
    };

    const deps = makeDeps({
      repos: [repo],
      readSyncAnchor: () => null,
    });

    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("acme/first-run-repo");
  });

  test("identifies which repo(s) need a docs check in the output (not just a flat file list)", async () => {
    const repoA: RepoDir = { repo: "acme/repo-a", dir: "/repos/repo-a" };

    const deps = makeDeps({
      repos: [repoA],
      readSyncAnchor: () => "sha-a",
      getCommitsSince: () => ["def789 change"],
      getChangedFilesSince: () => ["src/handler.ts"],
    });

    const result = await run(deps);
    expect(result.exit).toBe(0);
    // Repo identity must be present in the output, not just bare file paths.
    expect(result.output).toContain("acme/repo-a");
  });
});
