/**
 * agent/src/check-helpers.unit.test.ts
 *
 * Unit tests for resolveRepos(), getCurrentUser(), and createTaskStoreClient()
 * in check-helpers.ts. Ported from
 * plugins/shipwright/scripts/check-helpers.unit.test.ts — adapted so
 * createTaskStoreClient() tests inject a fake fetch function instead of
 * overriding globalThis.fetch (agent/src test isolation rule: no
 * global.fetch/global.* overrides).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrReviewData, ReviewNode, ReviewThread } from "./check-patch.ts";
import {
  classifyReviewState,
  createBundleCompleteQuery,
  createPrRecordQuery,
  createTaskStatusQuery,
  createTaskStoreClient,
  getCurrentUser,
  hasAnyReviewAtHead,
  isCleanApproveBody,
  isPrRecordBlockedForDispatch,
  isTaskBlockedForDispatch,
  isTerminalReviewLabel,
  parseCandidateId,
  resolveAllRepos,
  resolveRepos,
  reviewsAtHeadCommit,
  VERDICT_TERMINAL_LABEL,
} from "./check-helpers.ts";
import * as checkHelpers from "./check-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake git repo in dir/repoName with a remote origin URL. */
function makeGitClone(
  parentDir: string,
  repoName: string,
  remoteUrl: string,
): void {
  const repoDir = join(parentDir, repoName);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  const gitConfig = `[core]
\trepositoryformatversion = 0
\tfilemode = true
[remote "origin"]
\turl = ${remoteUrl}
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
\tmerge = refs/heads/main
`;
  writeFileSync(join(repoDir, ".git", "config"), gitConfig);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveRepos", () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "resolve-repos-test-"));
    savedEnv = process.env.SHIPWRIGHT_REPOS_DIR;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_REPOS_DIR;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.SHIPWRIGHT_REPOS_DIR = savedEnv;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_REPOS_DIR;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array when workspace has no repos/ dir and no env var", () => {
    const result = resolveRepos(tmpDir);
    expect(result).toEqual([]);
  });

  test("returns empty array when workspace repos/ dir exists but is empty", () => {
    mkdirSync(join(tmpDir, "repos"), { recursive: true });
    const result = resolveRepos(tmpDir);
    expect(result).toEqual([]);
  });

  test("parses HTTPS remote URL from git clone in repos/", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "example-repo",
      "https://github.com/acme/example-repo.git",
    );
    const result = resolveRepos(tmpDir);
    expect(result).toContain("acme/example-repo");
  });

  test("parses SSH remote URL from git clone in repos/", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "example-repo",
      "git@github.com:acme/example-repo.git",
    );
    const result = resolveRepos(tmpDir);
    expect(result).toContain("acme/example-repo");
  });

  test("parses HTTPS URL without .git suffix", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(reposDir, "my-repo", "https://github.com/myorg/my-repo");
    const result = resolveRepos(tmpDir);
    expect(result).toContain("myorg/my-repo");
  });

  test("returns multiple repos when multiple git clones exist", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "example-repo",
      "https://github.com/acme/example-repo.git",
    );
    makeGitClone(
      reposDir,
      "other-repo",
      "https://github.com/acme/other-repo.git",
    );
    const result = resolveRepos(tmpDir);
    expect(result).toContain("acme/example-repo");
    expect(result).toContain("acme/other-repo");
    expect(result).toHaveLength(2);
  });

  test("skips subdirs without .git directory", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    // Not a git clone — just a regular dir
    mkdirSync(join(reposDir, "not-a-repo"));
    makeGitClone(
      reposDir,
      "example-repo",
      "https://github.com/acme/example-repo.git",
    );
    const result = resolveRepos(tmpDir);
    expect(result).toHaveLength(1);
    expect(result).toContain("acme/example-repo");
  });

  test("falls back to SHIPWRIGHT_REPOS_DIR when repos/ is empty", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true }); // empty repos/ dir

    const envReposDir = join(tmpDir, "env-repos");
    mkdirSync(envReposDir, { recursive: true });
    makeGitClone(
      envReposDir,
      "example-repo",
      "https://github.com/acme/example-repo.git",
    );

    process.env.SHIPWRIGHT_REPOS_DIR = envReposDir;
    const result = resolveRepos(tmpDir);
    expect(result).toContain("acme/example-repo");
  });

  test("falls back to SHIPWRIGHT_REPOS_DIR when repos/ does not exist", () => {
    // No repos/ dir at all
    const envReposDir = join(tmpDir, "env-repos");
    mkdirSync(envReposDir, { recursive: true });
    makeGitClone(
      envReposDir,
      "example-repo",
      "git@github.com:acme/example-repo.git",
    );

    process.env.SHIPWRIGHT_REPOS_DIR = envReposDir;
    const result = resolveRepos(tmpDir);
    expect(result).toContain("acme/example-repo");
  });

  test("repos/ takes priority over SHIPWRIGHT_REPOS_DIR when non-empty", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "example-repo",
      "https://github.com/acme/example-repo.git",
    );

    const envReposDir = join(tmpDir, "env-repos");
    mkdirSync(envReposDir, { recursive: true });
    makeGitClone(
      envReposDir,
      "other-repo",
      "https://github.com/acme/other-repo.git",
    );

    process.env.SHIPWRIGHT_REPOS_DIR = envReposDir;
    const result = resolveRepos(tmpDir);
    // repos/ is non-empty, so env var is ignored
    expect(result).toContain("acme/example-repo");
    expect(result).not.toContain("acme/other-repo");
  });

  test("returns empty array when SHIPWRIGHT_REPOS_DIR points to nonexistent path", () => {
    process.env.SHIPWRIGHT_REPOS_DIR = "/no/such/path";
    const result = resolveRepos(tmpDir);
    expect(result).toEqual([]);
  });

  test("skips git clone with no remote origin configured", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    // Git dir without a remote
    const repoDir = join(reposDir, "no-remote");
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    writeFileSync(
      join(repoDir, ".git", "config"),
      "[core]\n\trepositoryformatversion = 0\n",
    );

    const result = resolveRepos(tmpDir);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveAllRepos
// ---------------------------------------------------------------------------

describe("resolveAllRepos", () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "resolve-all-repos-test-"));
    savedEnv = process.env.SHIPWRIGHT_REPOS_DIR;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_REPOS_DIR;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.SHIPWRIGHT_REPOS_DIR = savedEnv;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_REPOS_DIR;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns scanned repos", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "other-repo",
      "https://github.com/acme/other-repo.git",
    );
    expect(resolveAllRepos(tmpDir)).toEqual(["acme/other-repo"]);
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspacePath
// ---------------------------------------------------------------------------

describe("resolveWorkspacePath", () => {
  let savedWorkspacePath: string | undefined;
  let savedAgentHome: string | undefined;

  beforeEach(() => {
    savedWorkspacePath = process.env.WORKSPACE_PATH;
    savedAgentHome = process.env.AGENT_HOME;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.WORKSPACE_PATH;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.AGENT_HOME;
  });

  afterEach(() => {
    if (savedWorkspacePath !== undefined) {
      process.env.WORKSPACE_PATH = savedWorkspacePath;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.WORKSPACE_PATH;
    }
    if (savedAgentHome !== undefined) {
      process.env.AGENT_HOME = savedAgentHome;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.AGENT_HOME;
    }
  });

  test("returns WORKSPACE_PATH when set, taking priority over AGENT_HOME", () => {
    process.env.WORKSPACE_PATH = "/explicit/workspace";
    process.env.AGENT_HOME = "/agent/home";
    expect(checkHelpers.resolveWorkspacePath()).toBe("/explicit/workspace");
  });

  test("derives from AGENT_HOME/workspace when WORKSPACE_PATH is unset", () => {
    process.env.AGENT_HOME = "/agent/home";
    expect(checkHelpers.resolveWorkspacePath()).toBe(
      join("/agent/home", "workspace"),
    );
  });

  test("throws when neither WORKSPACE_PATH nor AGENT_HOME is set", () => {
    expect(() => checkHelpers.resolveWorkspacePath()).toThrow(
      "AGENT_HOME is not set",
    );
  });
});

// ---------------------------------------------------------------------------
// parseAllowSelfReview / readAllowSelfReview
// ---------------------------------------------------------------------------

describe("parseAllowSelfReview", () => {
  test("returns true when the table cell says true", () => {
    expect(
      checkHelpers.parseAllowSelfReview("| `allow_self_review` | true |"),
    ).toBe(true);
  });

  test("returns false when the table cell says false", () => {
    expect(
      checkHelpers.parseAllowSelfReview("| `allow_self_review` | false |"),
    ).toBe(false);
  });

  test("returns false for bold-style false", () => {
    expect(
      checkHelpers.parseAllowSelfReview("**allow_self_review**: false"),
    ).toBe(false);
  });

  test("returns true for bold-style true", () => {
    expect(
      checkHelpers.parseAllowSelfReview("**allow_self_review**: true"),
    ).toBe(true);
  });

  test("returns true for plain YAML frontmatter style true", () => {
    expect(
      checkHelpers.parseAllowSelfReview(
        "---\nauto_post_reviews: true\nallow_self_review: true\nmin_confidence: 75\n---\n",
      ),
    ).toBe(true);
  });

  test("returns false for plain YAML frontmatter style false", () => {
    expect(
      checkHelpers.parseAllowSelfReview(
        "---\nauto_post_reviews: true\nallow_self_review: false\nmin_confidence: 75\n---\n",
      ),
    ).toBe(false);
  });

  test("defaults to false when the field is missing entirely", () => {
    expect(checkHelpers.parseAllowSelfReview("no policy here")).toBe(false);
  });
});

describe("readAllowSelfReview", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "read-allow-self-review-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads and parses state/agent-policy.md when present", () => {
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(
      join(tmpDir, "state", "agent-policy.md"),
      "| `allow_self_review` | false |",
    );
    expect(checkHelpers.readAllowSelfReview(tmpDir)).toBe(false);
  });

  test("defaults to false when the policy file does not exist", () => {
    expect(checkHelpers.readAllowSelfReview(tmpDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAutoMergeAnyAuthorRepos / readAutoMergeAnyAuthorRepos (AM-1)
// ---------------------------------------------------------------------------

describe("parseAutoMergeAnyAuthorRepos", () => {
  test("parses a bracketed comma-separated list", () => {
    expect(
      checkHelpers.parseAutoMergeAnyAuthorRepos(
        "auto_merge_any_author_repos: [acme/repo-a, acme/repo-b]",
      ),
    ).toEqual(["acme/repo-a", "acme/repo-b"]);
  });

  test("parses a table-cell style bracketed list", () => {
    expect(
      checkHelpers.parseAutoMergeAnyAuthorRepos(
        "| `auto_merge_any_author_repos` | [acme/repo-a] |",
      ),
    ).toEqual(["acme/repo-a"]);
  });

  test("parses a bold-style bracketed list", () => {
    expect(
      checkHelpers.parseAutoMergeAnyAuthorRepos(
        "**auto_merge_any_author_repos**: [acme/repo-a, acme/repo-b]",
      ),
    ).toEqual(["acme/repo-a", "acme/repo-b"]);
  });

  test("returns an empty array for an explicit empty bracket list", () => {
    expect(
      checkHelpers.parseAutoMergeAnyAuthorRepos(
        "auto_merge_any_author_repos: []",
      ),
    ).toEqual([]);
  });

  test("defaults to an empty array when the field is missing entirely", () => {
    expect(checkHelpers.parseAutoMergeAnyAuthorRepos("no policy here")).toEqual(
      [],
    );
  });

  test("trims whitespace around each entry", () => {
    expect(
      checkHelpers.parseAutoMergeAnyAuthorRepos(
        "auto_merge_any_author_repos: [ acme/repo-a ,  acme/repo-b ]",
      ),
    ).toEqual(["acme/repo-a", "acme/repo-b"]);
  });
});

describe("readAutoMergeAnyAuthorRepos", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(
      join(tmpdir(), "read-auto-merge-any-author-repos-test-"),
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads and parses state/agent-policy.md when present", () => {
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(
      join(tmpDir, "state", "agent-policy.md"),
      "auto_merge_any_author_repos: [acme/repo-a]",
    );
    expect(checkHelpers.readAutoMergeAnyAuthorRepos(tmpDir)).toEqual([
      "acme/repo-a",
    ]);
  });

  test("defaults to an empty array when the policy file does not exist", () => {
    expect(checkHelpers.readAutoMergeAnyAuthorRepos(tmpDir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseAutoMergeHoldLabel / readAutoMergeHoldLabel (AM-1)
// ---------------------------------------------------------------------------

describe("parseAutoMergeHoldLabel", () => {
  test("parses a table-cell style bare label", () => {
    expect(
      checkHelpers.parseAutoMergeHoldLabel(
        "| `auto_merge_hold_label` | do-not-merge |",
      ),
    ).toBe("do-not-merge");
  });

  test("parses a bold-style bare label", () => {
    expect(
      checkHelpers.parseAutoMergeHoldLabel(
        "**auto_merge_hold_label**: do-not-merge",
      ),
    ).toBe("do-not-merge");
  });

  test("parses a plain YAML frontmatter style label", () => {
    expect(
      checkHelpers.parseAutoMergeHoldLabel(
        "---\nauto_merge_hold_label: hold\n---\n",
      ),
    ).toBe("hold");
  });

  test("strips surrounding quotes", () => {
    expect(
      checkHelpers.parseAutoMergeHoldLabel(
        'auto_merge_hold_label: "do not merge"',
      ),
    ).toBe("do not merge");
  });

  test("defaults to an empty string when the field is missing entirely", () => {
    expect(checkHelpers.parseAutoMergeHoldLabel("no policy here")).toBe("");
  });

  test("defaults to an empty string when the value itself is empty", () => {
    expect(checkHelpers.parseAutoMergeHoldLabel("auto_merge_hold_label:")).toBe(
      "",
    );
  });
});

describe("readAutoMergeHoldLabel", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "read-auto-merge-hold-label-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads and parses state/agent-policy.md when present", () => {
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(
      join(tmpDir, "state", "agent-policy.md"),
      "auto_merge_hold_label: do-not-merge",
    );
    expect(checkHelpers.readAutoMergeHoldLabel(tmpDir)).toBe("do-not-merge");
  });

  test("defaults to an empty string when the policy file does not exist", () => {
    expect(checkHelpers.readAutoMergeHoldLabel(tmpDir)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// parseCleanupMergedWorktrees
// ---------------------------------------------------------------------------

describe("parseCleanupMergedWorktrees", () => {
  test("returns true when the table cell says true", () => {
    expect(
      checkHelpers.parseCleanupMergedWorktrees("| `cleanup_merged_worktrees` | true |"),
    ).toBe(true);
  });

  test("returns false when the table cell says false", () => {
    expect(
      checkHelpers.parseCleanupMergedWorktrees("| `cleanup_merged_worktrees` | false |"),
    ).toBe(false);
  });

  test("returns false for bold-style false", () => {
    expect(
      checkHelpers.parseCleanupMergedWorktrees("**cleanup_merged_worktrees**: false"),
    ).toBe(false);
  });

  test("returns true for bold-style true", () => {
    expect(
      checkHelpers.parseCleanupMergedWorktrees("**cleanup_merged_worktrees**: true"),
    ).toBe(true);
  });

  test("returns false for plain YAML frontmatter style false", () => {
    expect(
      checkHelpers.parseCleanupMergedWorktrees(
        "---\ncleanup_merged_worktrees: false\ncleanup_after_days: 14\n---\n",
      ),
    ).toBe(false);
  });

  test("returns true for plain YAML frontmatter style true", () => {
    expect(
      checkHelpers.parseCleanupMergedWorktrees(
        "---\ncleanup_merged_worktrees: true\ncleanup_after_days: 14\n---\n",
      ),
    ).toBe(true);
  });

  test("defaults to true when the field is missing entirely", () => {
    expect(checkHelpers.parseCleanupMergedWorktrees("no policy here")).toBe(true);
  });

  test("defaults to true when content is empty", () => {
    expect(checkHelpers.parseCleanupMergedWorktrees("")).toBe(true);
  });
});

describe("readCleanupMergedWorktrees", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "read-cleanup-merged-worktrees-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads and parses state/agent-policy.md when present", () => {
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(
      join(tmpDir, "state", "agent-policy.md"),
      "| `cleanup_merged_worktrees` | false |",
    );
    expect(checkHelpers.readCleanupMergedWorktrees(tmpDir)).toBe(false);
  });

  test("defaults to true when the policy file does not exist", () => {
    expect(checkHelpers.readCleanupMergedWorktrees(tmpDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseCleanupAfterDays
// ---------------------------------------------------------------------------

describe("parseCleanupAfterDays", () => {
  test("parses numeric value from table format", () => {
    expect(
      checkHelpers.parseCleanupAfterDays("| `cleanup_after_days` | 7 |"),
    ).toBe(7);
  });

  test("parses numeric value from bold-style format", () => {
    expect(
      checkHelpers.parseCleanupAfterDays("**cleanup_after_days**: 21"),
    ).toBe(21);
  });

  test("parses numeric value from plain YAML frontmatter style", () => {
    expect(
      checkHelpers.parseCleanupAfterDays(
        "---\ncleanup_merged_worktrees: true\ncleanup_after_days: 30\n---\n",
      ),
    ).toBe(30);
  });

  test("defaults to 14 when the field is missing", () => {
    expect(checkHelpers.parseCleanupAfterDays("no policy here")).toBe(14);
  });

  test("defaults to 14 when content is empty", () => {
    expect(checkHelpers.parseCleanupAfterDays("")).toBe(14);
  });

  test("handles leading/trailing whitespace around numeric value", () => {
    expect(
      checkHelpers.parseCleanupAfterDays("**cleanup_after_days**:   30   "),
    ).toBe(30);
  });

  test("defaults to 14 when value is not a valid number", () => {
    expect(
      checkHelpers.parseCleanupAfterDays("**cleanup_after_days**: abc"),
    ).toBe(14);
  });

  test("defaults to 14 when parsed value is NaN", () => {
    expect(
      checkHelpers.parseCleanupAfterDays("**cleanup_after_days**: NaN"),
    ).toBe(14);
  });

  test("parses zero as a valid value", () => {
    expect(
      checkHelpers.parseCleanupAfterDays("**cleanup_after_days**: 0"),
    ).toBe(0);
  });
});

describe("readCleanupAfterDays", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "read-cleanup-after-days-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads and parses state/agent-policy.md when present", () => {
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(
      join(tmpDir, "state", "agent-policy.md"),
      "| `cleanup_after_days` | 7 |",
    );
    expect(checkHelpers.readCleanupAfterDays(tmpDir)).toBe(7);
  });

  test("defaults to 14 when the policy file does not exist", () => {
    expect(checkHelpers.readCleanupAfterDays(tmpDir)).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// isMergeOnlyUpdate
// ---------------------------------------------------------------------------

describe("isMergeOnlyUpdate", () => {
  test("returns true when every commit after the anchor is a merge commit", async () => {
    const deps = {
      listPrCommits: async () => [
        { sha: "a", parents: [{ sha: "root" }] },
        { sha: "b", parents: [{ sha: "a" }, { sha: "other" }] },
        { sha: "c", parents: [{ sha: "b" }, { sha: "other2" }] },
      ],
    };
    expect(await checkHelpers.isMergeOnlyUpdate(1, "a", deps)).toBe(true);
  });

  test("returns false when a non-merge commit follows the anchor", async () => {
    const deps = {
      listPrCommits: async () => [
        { sha: "a", parents: [{ sha: "root" }] },
        { sha: "b", parents: [{ sha: "a" }] },
      ],
    };
    expect(await checkHelpers.isMergeOnlyUpdate(1, "a", deps)).toBe(false);
  });

  test("returns false when the anchor commit is not found", async () => {
    const deps = {
      listPrCommits: async () => [{ sha: "z", parents: [{ sha: "root" }] }],
    };
    expect(await checkHelpers.isMergeOnlyUpdate(1, "missing", deps)).toBe(
      false,
    );
  });

  test("returns false when there are no commits after the anchor", () => {
    const deps = {
      listPrCommits: async () => [{ sha: "a", parents: [{ sha: "root" }] }],
    };
    expect(checkHelpers.isMergeOnlyUpdate(1, "a", deps)).resolves.toBe(false);
  });

  test("returns false when listPrCommits throws", async () => {
    const deps = {
      listPrCommits: async () => {
        throw new Error("network error");
      },
    };
    expect(await checkHelpers.isMergeOnlyUpdate(1, "a", deps)).toBe(false);
  });

  test("passes the repo argument through to listPrCommits", async () => {
    let receivedRepo: string | undefined;
    const deps = {
      listPrCommits: async (_prNumber: number, repo?: string) => {
        receivedRepo = repo;
        return [
          { sha: "a", parents: [{ sha: "root" }] },
          { sha: "b", parents: [{ sha: "a" }, { sha: "other" }] },
        ];
      },
    };
    await checkHelpers.isMergeOnlyUpdate(1, "a", deps, "acme/example-repo");
    expect(receivedRepo).toBe("acme/example-repo");
  });
});

// ---------------------------------------------------------------------------
// getCurrentUser
// ---------------------------------------------------------------------------

/**
 * Write a fake `gh` binary into dir that returns the given GraphQL viewer
 * response JSON. Returns the path to the fake binary.
 *
 * The fake binary is added to PATH by the test beforeEach/afterEach helpers.
 */
function writeFakeGhBinary(dir: string, viewerLogin: string): string {
  const binPath = join(dir, "gh");
  const response = JSON.stringify({ data: { viewer: { login: viewerLogin } } });
  // A minimal shell script that ignores all args and prints the baked response.
  writeFileSync(binPath, `#!/bin/sh\nprintf '%s\\n' '${response}'\n`);
  chmodSync(binPath, 0o755);
  return binPath;
}

/** Write a fake `gh` binary that always fails with a given exit code. */
function writeFailingGhBinary(
  dir: string,
  exitCode: number,
  stderr: string,
): string {
  const binPath = join(dir, "gh");
  writeFileSync(
    binPath,
    `#!/bin/sh\nprintf '%s\\n' '${stderr}' >&2\nexit ${exitCode}\n`,
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

describe("getCurrentUser", () => {
  let tmpDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "get-current-user-test-"));
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    if (savedPath !== undefined) {
      process.env.PATH = savedPath;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns login as-is for a regular PAT user", async () => {
    writeFakeGhBinary(tmpDir, "dmcaulay");
    process.env.PATH = `${tmpDir}:${savedPath}`;
    const result = await getCurrentUser();
    expect(result).toBe("dmcaulay");
  });

  test("normalises [bot] suffix to app/ prefix for GitHub App identity", async () => {
    writeFakeGhBinary(tmpDir, "my-app[bot]");
    process.env.PATH = `${tmpDir}:${savedPath}`;
    const result = await getCurrentUser();
    expect(result).toBe("app/my-app");
  });

  test("handles hyphenated app name in [bot] normalisation", async () => {
    writeFakeGhBinary(tmpDir, "example-repo-agent[bot]");
    process.env.PATH = `${tmpDir}:${savedPath}`;
    const result = await getCurrentUser();
    expect(result).toBe("app/example-repo-agent");
  });

  test("throws when gh exits non-zero", async () => {
    writeFailingGhBinary(tmpDir, 1, "not authenticated");
    process.env.PATH = `${tmpDir}:${savedPath}`;
    await expect(getCurrentUser()).rejects.toThrow("gh api graphql failed");
  });
});

// ---------------------------------------------------------------------------
// createTaskStoreClient — query() response shape handling
// ---------------------------------------------------------------------------

describe("createTaskStoreClient query()", () => {
  const FAKE_TASK = {
    id: "T-1",
    title: "Do the thing",
    status: "pending" as const,
  };

  let savedEnv: { url?: string; token?: string };

  beforeEach(() => {
    savedEnv = {
      url: process.env.SHIPWRIGHT_TASK_STORE_URL,
      token: process.env.SHIPWRIGHT_TASK_STORE_TOKEN,
    };
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://task-store.example.com";
    process.env.SHIPWRIGHT_TASK_STORE_TOKEN = "test-token";
  });

  afterEach(() => {
    if (savedEnv.url !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_URL = savedEnv.url;
    } else {
      // biome-ignore lint/performance/noDelete: intentional env cleanup
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    }
    if (savedEnv.token !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN = savedEnv.token;
    } else {
      // biome-ignore lint/performance/noDelete: intentional env cleanup
      delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    }
  });

  test("unwraps { tasks } envelope from ?ready=true", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({ tasks: [FAKE_TASK], total: 1 }),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    const result = await client.query(new URLSearchParams({ ready: "true" }));
    expect(result).toEqual([FAKE_TASK]);
  });

  test("unwraps paginated { tasks } envelope (returned by ?status=...)", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          tasks: [FAKE_TASK],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    const result = await client.query(
      new URLSearchParams({ status: "in_progress" }),
    );
    expect(result).toEqual([FAKE_TASK]);
  });

  test("returns empty array when paginated envelope has empty tasks list", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({ tasks: [], total: 0, limit: 50, offset: 0 }),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    const result = await client.query(
      new URLSearchParams({ status: "in_progress" }),
    );
    expect(result).toEqual([]);
  });

  test("throws on unrecognised response shape", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({ unexpected: true }),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(
      client.query(new URLSearchParams({ status: "in_progress" })),
    ).rejects.toThrow("Unexpected task-store response format");
  });

  test("accepts a legacy bare Task[] response", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => [FAKE_TASK],
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    const result = await client.query(new URLSearchParams({ ready: "true" }));
    expect(result).toEqual([FAKE_TASK]);
  });

  test("throws when the query response is not ok", async () => {
    const fakeFetch = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(
      client.query(new URLSearchParams({ ready: "true" })),
    ).rejects.toThrow("task-store GET /tasks");
  });

  test("update() PATCHes the task and returns the parsed response", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return {
        ok: true,
        json: async () => ({ ...FAKE_TASK, status: "in_progress" }),
      } as Response;
    }) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    const result = await client.update("T-1", { status: "in_progress" });

    expect(capturedUrl).toBe("https://task-store.example.com/tasks/T-1");
    expect(capturedInit?.method).toBe("PATCH");
    expect(result).toEqual({ ...FAKE_TASK, status: "in_progress" });
  });

  test("throws when the update response is not ok", async () => {
    const fakeFetch = (async () =>
      ({
        ok: false,
        status: 404,
        json: async () => ({}),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(
      client.update("T-1", { status: "in_progress" }),
    ).rejects.toThrow("task-store PATCH /tasks/T-1");
  });

  test("claim() POSTs to /tasks/:id/claim", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return { ok: true, status: 200, json: async () => FAKE_TASK } as Response;
    }) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await client.claim("T-1");

    expect(capturedUrl).toBe("https://task-store.example.com/tasks/T-1/claim");
    expect(capturedInit?.method).toBe("POST");
    // headers always sets Content-Type: application/json — a truly empty
    // body would fail the server's JSON parse
    expect(capturedInit?.body).toBe("{}");
  });

  test("claim() returns true on 200", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => FAKE_TASK,
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(client.claim("T-1")).resolves.toBe(true);
  });

  test("claim() returns true on 201", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 201,
        json: async () => FAKE_TASK,
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(client.claim("T-1")).resolves.toBe(true);
  });

  test("claim() returns false on 409 (does not throw)", async () => {
    const fakeFetch = (async () =>
      ({
        ok: false,
        status: 409,
        json: async () => ({ error: "already claimed" }),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(client.claim("T-1")).resolves.toBe(false);
  });

  test("claim() throws on other non-ok statuses (e.g. 500)", async () => {
    const fakeFetch = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(client.claim("T-1")).rejects.toThrow(
      "task-store POST /tasks/T-1/claim",
    );
  });

  // ─── claimPr() (CBD-1.3) ──────────────────────────────────────────────────

  const FAKE_PR = {
    id: "clx0987654321",
    repo: "app-vitals/shipwright",
    prNumber: 42,
    commitSha: "abc123def456",
  };

  test("claimPr() POSTs to /prs/claim with the right body", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return { ok: true, status: 200, json: async () => FAKE_PR } as Response;
    }) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await client.claimPr({
      repo: "app-vitals/shipwright",
      prNumber: 42,
      commitSha: "abc123def456",
      phase: "review",
    });

    expect(capturedUrl).toBe("https://task-store.example.com/prs/claim");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.body).toBe(
      JSON.stringify({
        repo: "app-vitals/shipwright",
        prNumber: 42,
        commitSha: "abc123def456",
        phase: "review",
      }),
    );
  });

  test("claimPr() returns {id, commitSha} on 200", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => FAKE_PR,
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(
      client.claimPr({
        repo: "app-vitals/shipwright",
        prNumber: 42,
        commitSha: "abc123def456",
        phase: "review",
      }),
    ).resolves.toEqual({ id: "clx0987654321", commitSha: "abc123def456" });
  });

  test("claimPr() returns {id, commitSha} on 201", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 201,
        json: async () => FAKE_PR,
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(
      client.claimPr({
        repo: "app-vitals/shipwright",
        prNumber: 42,
        commitSha: "abc123def456",
        phase: "deploy",
      }),
    ).resolves.toEqual({ id: "clx0987654321", commitSha: "abc123def456" });
  });

  test("claimPr() falls back to the request commitSha when the response omits it", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ...FAKE_PR, commitSha: null }),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(
      client.claimPr({
        repo: "app-vitals/shipwright",
        prNumber: 42,
        commitSha: "abc123def456",
        phase: "patch",
      }),
    ).resolves.toEqual({ id: "clx0987654321", commitSha: "abc123def456" });
  });

  test("claimPr() returns null on 409 (does not throw)", async () => {
    const fakeFetch = (async () =>
      ({
        ok: false,
        status: 409,
        json: async () => ({ error: "already claimed" }),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(
      client.claimPr({
        repo: "app-vitals/shipwright",
        prNumber: 42,
        commitSha: "abc123def456",
        phase: "review",
      }),
    ).resolves.toBeNull();
  });

  test("claimPr() throws on other non-ok statuses (e.g. 500)", async () => {
    const fakeFetch = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(
      client.claimPr({
        repo: "app-vitals/shipwright",
        prNumber: 42,
        commitSha: "abc123def456",
        phase: "review",
      }),
    ).rejects.toThrow("task-store POST /prs/claim → 500");
  });

  // ─── recordSkip() / resetSkip() (SKT-2.1) ──────────────────────────────────
  //
  // Unlike claim/claimPr/update, these two methods must NEVER throw — they're
  // called fire-and-forget from the loop orchestrator's dispatch path, and a
  // task-store error here must not abort or delay the dispatch loop.

  test("recordSkip() POSTs to /tasks/:id/skip for itemType 'task'", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await client.recordSkip("task", "SKT-2.1");

    expect(capturedUrl).toBe(
      "https://task-store.example.com/tasks/SKT-2.1/skip",
    );
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.body).toBe("{}");
  });

  test("recordSkip() POSTs to /prs/:id/skip for itemType 'pr'", async () => {
    let capturedUrl: string | undefined;
    const fakeFetch = (async (url: RequestInfo | URL) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await client.recordSkip("pr", "clx-record-id");

    expect(capturedUrl).toBe(
      "https://task-store.example.com/prs/clx-record-id/skip",
    );
  });

  test("resetSkip() POSTs to /tasks/:id/skip/reset for itemType 'task'", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await client.resetSkip("task", "SKT-2.1");

    expect(capturedUrl).toBe(
      "https://task-store.example.com/tasks/SKT-2.1/skip/reset",
    );
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.body).toBe("{}");
  });

  test("resetSkip() POSTs to /prs/:id/skip/reset for itemType 'pr'", async () => {
    let capturedUrl: string | undefined;
    const fakeFetch = (async (url: RequestInfo | URL) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await client.resetSkip("pr", "clx-record-id");

    expect(capturedUrl).toBe(
      "https://task-store.example.com/prs/clx-record-id/skip/reset",
    );
  });

  test("recordSkip() swallows a non-ok HTTP response (does not throw)", async () => {
    const fakeFetch = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(
      client.recordSkip("task", "SKT-2.1"),
    ).resolves.toBeUndefined();
  });

  test("recordSkip() swallows a network error (does not throw)", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(
      client.recordSkip("pr", "clx-record-id"),
    ).resolves.toBeUndefined();
  });

  test("resetSkip() swallows a non-ok HTTP response (does not throw)", async () => {
    const fakeFetch = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(
      client.resetSkip("task", "SKT-2.1"),
    ).resolves.toBeUndefined();
  });

  test("resetSkip() swallows a network error (does not throw)", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const client = createTaskStoreClient({ fetchFn: fakeFetch });
    await expect(
      client.resetSkip("pr", "clx-record-id"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseCandidateId
// ---------------------------------------------------------------------------

describe("parseCandidateId", () => {
  test("splits a valid org/repo#number id", () => {
    expect(parseCandidateId("app-vitals/shipwright#42")).toEqual({
      repo: "app-vitals/shipwright",
      prNumber: 42,
    });
  });

  test("handles a bare repo name without an org", () => {
    expect(parseCandidateId("shipwright#7")).toEqual({
      repo: "shipwright",
      prNumber: 7,
    });
  });

  test("returns null when there is no '#'", () => {
    expect(parseCandidateId("app-vitals/shipwright")).toBeNull();
  });

  test("returns null when the repo part is empty", () => {
    expect(parseCandidateId("#42")).toBeNull();
  });

  test("returns null when the number part is not an integer", () => {
    expect(parseCandidateId("app-vitals/shipwright#abc")).toBeNull();
    expect(parseCandidateId("app-vitals/shipwright#4.5")).toBeNull();
    expect(parseCandidateId("app-vitals/shipwright#")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createTaskStatusQuery
// ---------------------------------------------------------------------------

describe("createTaskStatusQuery", () => {
  let savedEnv: { url?: string; token?: string };

  beforeEach(() => {
    savedEnv = {
      url: process.env.SHIPWRIGHT_TASK_STORE_URL,
      token: process.env.SHIPWRIGHT_TASK_STORE_TOKEN,
    };
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://task-store.example.com";
    process.env.SHIPWRIGHT_TASK_STORE_TOKEN = "test-token";
  });

  afterEach(() => {
    if (savedEnv.url !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_URL = savedEnv.url;
    } else {
      // biome-ignore lint/performance/noDelete: intentional env cleanup
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    }
    if (savedEnv.token !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN = savedEnv.token;
    } else {
      // biome-ignore lint/performance/noDelete: intentional env cleanup
      delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    }
  });

  test("returns { status, createdAt } when a linked task is found with both fields present", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          tasks: [
            {
              id: "T-1",
              title: "Do the thing",
              status: "in_progress",
              createdAt: "2026-05-01T00:00:00.000Z",
            },
          ],
        }),
      }) as Response) as unknown as typeof fetch;

    const query = createTaskStatusQuery({ fetchFn: fakeFetch });
    const result = await query("acme/example-repo", 42);
    expect(result).toEqual({
      status: "in_progress",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
  });

  test("returns { status, createdAt: undefined } when the matched task has no createdAt", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          tasks: [{ id: "T-1", title: "Do the thing", status: "pending" }],
        }),
      }) as Response) as unknown as typeof fetch;

    const query = createTaskStatusQuery({ fetchFn: fakeFetch });
    const result = await query("acme/example-repo", 42);
    expect(result).toEqual({ status: "pending", createdAt: undefined });
  });

  test("returns null when no linked task is found (empty tasks array)", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({ tasks: [] }),
      }) as Response) as unknown as typeof fetch;

    const query = createTaskStatusQuery({ fetchFn: fakeFetch });
    const result = await query("acme/example-repo", 42);
    expect(result).toBeNull();
  });

  test("throws when the lookup response is not ok (fail-closed)", async () => {
    const fakeFetch = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as Response) as unknown as typeof fetch;

    const query = createTaskStatusQuery({ fetchFn: fakeFetch });
    await expect(query("acme/example-repo", 42)).rejects.toThrow(
      "task-store GET /tasks",
    );
  });

  test("throws when SHIPWRIGHT_TASK_STORE_URL/TOKEN are not configured", async () => {
    // biome-ignore lint/performance/noDelete: intentional env cleanup
    delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    // biome-ignore lint/performance/noDelete: intentional env cleanup
    delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;

    const query = createTaskStatusQuery();
    await expect(query("acme/example-repo", 42)).rejects.toThrow(
      "SHIPWRIGHT_TASK_STORE_URL/SHIPWRIGHT_TASK_STORE_TOKEN not configured",
    );
  });
});

// ---------------------------------------------------------------------------
// createBundleCompleteQuery
// ---------------------------------------------------------------------------

describe("createBundleCompleteQuery", () => {
  let savedEnv: { url?: string; token?: string };

  beforeEach(() => {
    savedEnv = {
      url: process.env.SHIPWRIGHT_TASK_STORE_URL,
      token: process.env.SHIPWRIGHT_TASK_STORE_TOKEN,
    };
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://task-store.example.com";
    process.env.SHIPWRIGHT_TASK_STORE_TOKEN = "test-token";
  });

  afterEach(() => {
    if (savedEnv.url !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_URL = savedEnv.url;
    } else {
      // biome-ignore lint/performance/noDelete: intentional env cleanup
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    }
    if (savedEnv.token !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN = savedEnv.token;
    } else {
      // biome-ignore lint/performance/noDelete: intentional env cleanup
      delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    }
  });

  test("returns true when the branch has zero tasks", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({ tasks: [] }),
      }) as Response) as unknown as typeof fetch;

    const query = createBundleCompleteQuery({ fetchFn: fakeFetch });
    const result = await query("feat/example-branch");
    expect(result).toBe(true);
  });

  test("returns true when all tasks on the branch are complete (pr_open/merged/approved)", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          tasks: [
            { id: "T-1", title: "First", status: "pr_open" },
            { id: "T-2", title: "Second", status: "merged" },
            { id: "T-3", title: "Third", status: "approved" },
          ],
        }),
      }) as Response) as unknown as typeof fetch;

    const query = createBundleCompleteQuery({ fetchFn: fakeFetch });
    const result = await query("feat/example-branch");
    expect(result).toBe(true);
  });

  test("returns false when at least one task on the branch is pending", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          tasks: [
            { id: "T-1", title: "First", status: "pr_open" },
            { id: "T-2", title: "Second", status: "pending" },
          ],
        }),
      }) as Response) as unknown as typeof fetch;

    const query = createBundleCompleteQuery({ fetchFn: fakeFetch });
    const result = await query("feat/example-branch");
    expect(result).toBe(false);
  });

  test("returns false when at least one task on the branch is in_progress", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          tasks: [{ id: "T-1", title: "First", status: "in_progress" }],
        }),
      }) as Response) as unknown as typeof fetch;

    const query = createBundleCompleteQuery({ fetchFn: fakeFetch });
    const result = await query("feat/example-branch");
    expect(result).toBe(false);
  });

  test("returns false when at least one task on the branch is blocked", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          tasks: [{ id: "T-1", title: "First", status: "blocked" }],
        }),
      }) as Response) as unknown as typeof fetch;

    const query = createBundleCompleteQuery({ fetchFn: fakeFetch });
    const result = await query("feat/example-branch");
    expect(result).toBe(false);
  });

  test("throws when the lookup response is not ok (fail-closed)", async () => {
    const fakeFetch = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as Response) as unknown as typeof fetch;

    const query = createBundleCompleteQuery({ fetchFn: fakeFetch });
    await expect(query("feat/example-branch")).rejects.toThrow(
      "task-store GET /tasks",
    );
  });

  test("throws when SHIPWRIGHT_TASK_STORE_URL/TOKEN are not configured", async () => {
    // biome-ignore lint/performance/noDelete: intentional env cleanup
    delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    // biome-ignore lint/performance/noDelete: intentional env cleanup
    delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;

    const query = createBundleCompleteQuery();
    await expect(query("feat/example-branch")).rejects.toThrow(
      "SHIPWRIGHT_TASK_STORE_URL/SHIPWRIGHT_TASK_STORE_TOKEN not configured",
    );
  });
});

// ---------------------------------------------------------------------------
// createPrRecordQuery
// ---------------------------------------------------------------------------

describe("createPrRecordQuery", () => {
  let savedEnv: { url?: string; token?: string };

  beforeEach(() => {
    savedEnv = {
      url: process.env.SHIPWRIGHT_TASK_STORE_URL,
      token: process.env.SHIPWRIGHT_TASK_STORE_TOKEN,
    };
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://task-store.example.com";
    process.env.SHIPWRIGHT_TASK_STORE_TOKEN = "test-token";
  });

  afterEach(() => {
    if (savedEnv.url !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_URL = savedEnv.url;
    } else {
      // biome-ignore lint/performance/noDelete: intentional env cleanup
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    }
    if (savedEnv.token !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN = savedEnv.token;
    } else {
      // biome-ignore lint/performance/noDelete: intentional env cleanup
      delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    }
  });

  test("does not append ready to the request params by default", async () => {
    let capturedUrl: string | undefined;
    const fakeFetch = (async (url: RequestInfo | URL) => {
      capturedUrl = String(url);
      return {
        ok: true,
        json: async () => ({ prs: [] }),
      } as Response;
    }) as unknown as typeof fetch;

    const query = createPrRecordQuery({ fetchFn: fakeFetch });
    await query("acme/example-repo", 42);

    expect(capturedUrl).toBeDefined();
    expect(new URL(capturedUrl as string).searchParams.get("ready")).toBeNull();
  });

  test("appends ready=true to the request params when ready: true is passed", async () => {
    let capturedUrl: string | undefined;
    const fakeFetch = (async (url: RequestInfo | URL) => {
      capturedUrl = String(url);
      return {
        ok: true,
        json: async () => ({ prs: [] }),
      } as Response;
    }) as unknown as typeof fetch;

    const query = createPrRecordQuery({ fetchFn: fakeFetch, ready: true });
    await query("acme/example-repo", 42);

    expect(capturedUrl).toBeDefined();
    expect(new URL(capturedUrl as string).searchParams.get("ready")).toBe(
      "true",
    );
  });

  test("returns the record when ready: true is passed and a match is found", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          prs: [{ commitSha: "sha1", reviewState: "posted" }],
        }),
      }) as Response) as unknown as typeof fetch;

    const query = createPrRecordQuery({ fetchFn: fakeFetch, ready: true });
    const result = await query("acme/example-repo", 42);
    expect(result).toEqual({ commitSha: "sha1", reviewState: "posted" });
  });
});

// ---------------------------------------------------------------------------
// createTaskStoreClient — missing env vars
// ---------------------------------------------------------------------------

describe("createTaskStoreClient env validation", () => {
  let savedEnv: { url?: string; token?: string };
  let savedExit: typeof process.exit;
  let exitCode: number | undefined;

  beforeEach(() => {
    savedEnv = {
      url: process.env.SHIPWRIGHT_TASK_STORE_URL,
      token: process.env.SHIPWRIGHT_TASK_STORE_TOKEN,
    };
    savedExit = process.exit;
    exitCode = undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = savedExit;
    if (savedEnv.url !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_URL = savedEnv.url;
    } else {
      // biome-ignore lint/performance/noDelete: intentional env cleanup
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    }
    if (savedEnv.token !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN = savedEnv.token;
    } else {
      // biome-ignore lint/performance/noDelete: intentional env cleanup
      delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    }
  });

  test("exits 1 when SHIPWRIGHT_TASK_STORE_URL is missing", () => {
    // biome-ignore lint/performance/noDelete: intentional env cleanup
    delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    process.env.SHIPWRIGHT_TASK_STORE_TOKEN = "test-token";
    expect(() => createTaskStoreClient()).toThrow();
    expect(exitCode).toBe(1);
  });

  test("exits 1 when SHIPWRIGHT_TASK_STORE_TOKEN is missing", () => {
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://task-store.example.com";
    // biome-ignore lint/performance/noDelete: intentional env cleanup
    delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    expect(() => createTaskStoreClient()).toThrow();
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Removed exports
// ---------------------------------------------------------------------------

describe("removed exports", () => {
  test("readReviews is not exported from check-helpers", () => {
    expect(
      (checkHelpers as Record<string, unknown>).readReviews,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isCleanApproveBody
// ---------------------------------------------------------------------------

describe("isCleanApproveBody", () => {
  test("matches a leading APPROVE", () => {
    expect(isCleanApproveBody("APPROVE")).toBe(true);
    expect(isCleanApproveBody("APPROVE — looks good")).toBe(true);
  });

  test("matches a leading APPROVE with markdown bold markers stripped", () => {
    expect(isCleanApproveBody("**APPROVE** — all criteria met")).toBe(true);
  });

  test("matches a narrative 'Verdict: APPROVE' label anywhere in the body", () => {
    expect(
      isCleanApproveBody(
        "All 5 acceptance criteria met. Verdict: APPROVE (posted as COMMENT — GitHub disallows self-approval via the API).",
      ),
    ).toBe(true);
  });

  test("matches 'Verdict: APPROVE' case-insensitively with bold markers", () => {
    expect(isCleanApproveBody("verdict: **approve** — ship it")).toBe(true);
  });

  test("does not match free-form approval prose without APPROVE or the Verdict label", () => {
    expect(isCleanApproveBody("Looks good, no blocking issues.")).toBe(false);
  });

  test("does not match a non-APPROVE verdict", () => {
    expect(isCleanApproveBody("Verdict: CHANGES_REQUESTED")).toBe(false);
    expect(isCleanApproveBody("Verdict: DISAPPROVE")).toBe(false);
  });
});

describe("VERDICT_TERMINAL_LABEL", () => {
  test("matches 'Verdict: APPROVE'", () => {
    expect(VERDICT_TERMINAL_LABEL.test("Verdict: APPROVE")).toBe(true);
  });

  test("matches 'Verdict: COMMENT'", () => {
    expect(VERDICT_TERMINAL_LABEL.test("Verdict: COMMENT")).toBe(true);
  });

  test("matches case-insensitively", () => {
    expect(VERDICT_TERMINAL_LABEL.test("verdict: approve")).toBe(true);
    expect(VERDICT_TERMINAL_LABEL.test("VERDICT: COMMENT")).toBe(true);
  });

  test("matches with markdown bold markers around either word", () => {
    expect(VERDICT_TERMINAL_LABEL.test("**Verdict**: **APPROVE**")).toBe(true);
    expect(
      VERDICT_TERMINAL_LABEL.test("verdict: **comment** — see notes"),
    ).toBe(true);
  });

  test("matches a narrative label trailing reasoning on the same line", () => {
    expect(
      VERDICT_TERMINAL_LABEL.test(
        "All 5 acceptance criteria met. Verdict: APPROVE (posted as COMMENT — GitHub disallows self-approval via the API).",
      ),
    ).toBe(true);
  });

  test("does not match a non-terminal verdict", () => {
    expect(VERDICT_TERMINAL_LABEL.test("Verdict: CHANGES_REQUESTED")).toBe(
      false,
    );
  });

  test("does not match plain narrative text with no Verdict label", () => {
    expect(VERDICT_TERMINAL_LABEL.test("Looks good, no blocking issues.")).toBe(
      false,
    );
  });
});

describe("isTerminalReviewLabel", () => {
  test("a plain APPROVED review with no Verdict: text classifies as terminal", () => {
    expect(isTerminalReviewLabel({ state: "APPROVED", body: "LGTM" })).toBe(
      true,
    );
    expect(isTerminalReviewLabel({ state: "APPROVED", body: "" })).toBe(true);
  });

  test("a body carrying a Verdict: APPROVE or Verdict: COMMENT label classifies as terminal regardless of state", () => {
    expect(
      isTerminalReviewLabel({ state: "COMMENTED", body: "Verdict: APPROVE" }),
    ).toBe(true);
    expect(
      isTerminalReviewLabel({ state: "COMMENTED", body: "Verdict: COMMENT" }),
    ).toBe(true);
  });

  test("a non-approved review with no Verdict label is not terminal", () => {
    expect(
      isTerminalReviewLabel({
        state: "CHANGES_REQUESTED",
        body: "Please fix this.",
      }),
    ).toBe(false);
    expect(
      isTerminalReviewLabel({ state: "COMMENTED", body: "Looks good." }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reviewsAtHeadCommit / hasAnyReviewAtHead / classifyReviewState (RVD-1.1)
//
// Promoted from pr-state-reconciler.ts — pr-state-reconciler.unit.test.ts
// already exercises these thoroughly end-to-end via reconcileReviewState(),
// so this block covers the pure functions directly (now that they're
// check-helpers.ts's own exports) rather than duplicating every scenario.
// ---------------------------------------------------------------------------

function makeReviewNode(overrides: Partial<ReviewNode> = {}): ReviewNode {
  return {
    author: { login: "some-reviewer" },
    state: "COMMENTED",
    submittedAt: "2026-07-15T10:00:00.000Z",
    commit: { oid: "head-sha" },
    body: "",
    ...overrides,
  };
}

function makeReviewThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    isResolved: true,
    comments: { nodes: [{ author: { login: "some-reviewer" }, body: "" }] },
    ...overrides,
  };
}

function makeReviewData(overrides: Partial<PrReviewData> = {}): PrReviewData {
  return {
    headRefOid: "head-sha",
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    ...overrides,
  };
}

describe("reviewsAtHeadCommit", () => {
  test("returns only reviews whose commit.oid matches headRefOid", () => {
    const data = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({ commit: { oid: "head-sha" }, body: "at head" }),
          makeReviewNode({ commit: { oid: "old-sha" }, body: "stale" }),
        ],
      },
    });
    const result = reviewsAtHeadCommit(data);
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe("at head");
  });

  test("returns an empty array when no reviews exist", () => {
    expect(reviewsAtHeadCommit(makeReviewData())).toEqual([]);
  });

  test("returns an empty array when all reviews are at a stale commit", () => {
    const data = makeReviewData({
      headRefOid: "head-sha",
      reviews: { nodes: [makeReviewNode({ commit: { oid: "old-sha" } })] },
    });
    expect(reviewsAtHeadCommit(data)).toEqual([]);
  });
});

describe("hasAnyReviewAtHead", () => {
  test("true when at least one review is at head", () => {
    const data = makeReviewData({
      headRefOid: "head-sha",
      reviews: { nodes: [makeReviewNode({ commit: { oid: "head-sha" } })] },
    });
    expect(hasAnyReviewAtHead(data)).toBe(true);
  });

  test("false when no reviews exist at all", () => {
    expect(hasAnyReviewAtHead(makeReviewData())).toBe(false);
  });

  test("false when reviews exist only at a stale commit", () => {
    const data = makeReviewData({
      headRefOid: "head-sha",
      reviews: { nodes: [makeReviewNode({ commit: { oid: "old-sha" } })] },
    });
    expect(hasAnyReviewAtHead(data)).toBe(false);
  });
});

describe("classifyReviewState", () => {
  test("returns null when no review exists at head", () => {
    expect(classifyReviewState(makeReviewData())).toBeNull();
  });

  test("returns null when reviews only exist at a stale commit", () => {
    const data = makeReviewData({
      headRefOid: "head-sha",
      reviews: { nodes: [makeReviewNode({ commit: { oid: "old-sha" } })] },
    });
    expect(classifyReviewState(data)).toBeNull();
  });

  test("returns 'approved' for a real APPROVED review at head", () => {
    const data = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "head-sha" },
            body: "LGTM",
          }),
        ],
      },
    });
    expect(classifyReviewState(data)).toBe("approved");
  });

  test("returns 'approved' for a clean-approve-shaped COMMENTED review at head, from any author", () => {
    const data = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            author: { login: "out-of-band-reviewer" },
            state: "COMMENTED",
            commit: { oid: "head-sha" },
            body: "**APPROVE** — nothing else to add.",
          }),
        ],
      },
    });
    expect(classifyReviewState(data)).toBe("approved");
  });

  test("returns 'posted' for a terminal non-approve review at head with no unresolved threads or finding body", () => {
    const data = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "COMMENTED",
            commit: { oid: "head-sha" },
            body: "",
          }),
        ],
      },
      reviewThreads: { nodes: [makeReviewThread({ isResolved: true })] },
    });
    expect(classifyReviewState(data)).toBe("posted");
  });

  test("returns null for a genuine unresolved finding at head (unresolved thread)", () => {
    const data = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "CHANGES_REQUESTED",
            commit: { oid: "head-sha" },
            body: "Please fix the auth flow.",
          }),
        ],
      },
      reviewThreads: { nodes: [makeReviewThread({ isResolved: false })] },
    });
    expect(classifyReviewState(data)).toBeNull();
  });

  test("returns null for a genuine finding via non-empty body, even with all threads resolved", () => {
    const data = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "COMMENTED",
            commit: { oid: "head-sha" },
            body: "Rename this variable before merging.",
          }),
        ],
      },
      reviewThreads: { nodes: [makeReviewThread({ isResolved: true })] },
    });
    expect(classifyReviewState(data)).toBeNull();
  });

  test("an approve from one reviewer never masks an independent unresolved finding from another reviewer at head", () => {
    const data = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            author: { login: "reviewer-a" },
            state: "CHANGES_REQUESTED",
            commit: { oid: "head-sha" },
            body: "This breaks the auth flow.",
          }),
          makeReviewNode({
            author: { login: "reviewer-b" },
            state: "APPROVED",
            commit: { oid: "head-sha" },
            body: "LGTM",
          }),
        ],
      },
      reviewThreads: { nodes: [makeReviewThread({ isResolved: false })] },
    });
    expect(classifyReviewState(data)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mapReposTolerant
// ---------------------------------------------------------------------------

describe("mapReposTolerant", () => {
  let savedWarn: typeof console.warn;
  let warnCalls: unknown[][];

  beforeEach(() => {
    savedWarn = console.warn;
    warnCalls = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
  });

  afterEach(() => {
    console.warn = savedWarn;
  });

  test("flattens results across all repos when every call succeeds", async () => {
    const result = await checkHelpers.mapReposTolerant(
      ["org/repo-a", "org/repo-b"],
      "test-label",
      async (repo: string) => [`${repo}-item1`, `${repo}-item2`],
    );
    expect(result).toEqual([
      "org/repo-a-item1",
      "org/repo-a-item2",
      "org/repo-b-item1",
      "org/repo-b-item2",
    ]);
    expect(warnCalls).toHaveLength(0);
  });

  test("one repo throws mid-list — other repos' results are still returned and no exception propagates", async () => {
    const result = await checkHelpers.mapReposTolerant(
      ["org/repo-a", "org/inaccessible-repo", "org/repo-b"],
      "test-label",
      async (repo: string) => {
        if (repo === "org/inaccessible-repo") {
          throw new Error("access denied");
        }
        return [`${repo}-item`];
      },
    );
    expect(result).toEqual(["org/repo-a-item", "org/repo-b-item"]);
  });

  test("logs the failure via console.warn (not console.error) with label and repo info", async () => {
    const savedError = console.error;
    const errorCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errorCalls.push(args);
    };

    try {
      await checkHelpers.mapReposTolerant(
        ["org/inaccessible-repo"],
        "check-review",
        async () => {
          throw new Error("access denied");
        },
      );
    } finally {
      console.error = savedError;
    }

    expect(errorCalls).toHaveLength(0);
    expect(warnCalls).toHaveLength(1);
    const [message] = warnCalls[0];
    expect(String(message)).toContain("check-review");
    expect(String(message)).toContain("org/inaccessible-repo");
  });

  test("returns an empty array when every repo fails", async () => {
    const result = await checkHelpers.mapReposTolerant(
      ["org/repo-a", "org/repo-b"],
      "test-label",
      async () => {
        throw new Error("boom");
      },
    );
    expect(result).toEqual([]);
    expect(warnCalls).toHaveLength(2);
  });

  test("returns an empty array for an empty repo list without calling fn", async () => {
    let called = false;
    const result = await checkHelpers.mapReposTolerant(
      [],
      "test-label",
      async () => {
        called = true;
        return ["x"];
      },
    );
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTaskBlockedForDispatch
// ---------------------------------------------------------------------------

describe("isTaskBlockedForDispatch", () => {
  test("returns true when hitl is true", () => {
    expect(
      isTaskBlockedForDispatch({ status: "pr_open", hitl: true }),
    ).toBe(true);
  });

  test("returns true when status is 'blocked'", () => {
    expect(
      isTaskBlockedForDispatch({ status: "blocked", hitl: false }),
    ).toBe(true);
  });

  test("returns true when both hitl:true and status:'blocked'", () => {
    expect(
      isTaskBlockedForDispatch({ status: "blocked", hitl: true }),
    ).toBe(true);
  });

  test("returns false when hitl is false and status is not 'blocked'", () => {
    expect(
      isTaskBlockedForDispatch({ status: "pending", hitl: false }),
    ).toBe(false);
  });

  test("returns false when hitl is undefined and status is not 'blocked'", () => {
    expect(isTaskBlockedForDispatch({ status: "pr_open" })).toBe(false);
  });

  test("returns false for a null task", () => {
    expect(isTaskBlockedForDispatch(null)).toBe(false);
  });

  test("returns false for an undefined task", () => {
    expect(isTaskBlockedForDispatch(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrRecordBlockedForDispatch
// ---------------------------------------------------------------------------

describe("isPrRecordBlockedForDispatch", () => {
  test("returns true when blocked is true", () => {
    expect(isPrRecordBlockedForDispatch({ blocked: true })).toBe(true);
  });

  test("returns false when blocked is false", () => {
    expect(isPrRecordBlockedForDispatch({ blocked: false })).toBe(false);
  });

  test("returns false when blocked is undefined", () => {
    expect(isPrRecordBlockedForDispatch({})).toBe(false);
  });

  test("returns false when blocked is null", () => {
    expect(isPrRecordBlockedForDispatch({ blocked: null })).toBe(false);
  });

  test("returns false for a null record", () => {
    expect(isPrRecordBlockedForDispatch(null)).toBe(false);
  });

  test("returns false for an undefined record", () => {
    expect(isPrRecordBlockedForDispatch(undefined)).toBe(false);
  });
});
