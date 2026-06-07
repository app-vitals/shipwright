/**
 * plugins/shipwright/scripts/check-helpers.unit.test.ts
 *
 * Unit tests for resolveRepos() and getCurrentUser() in check-helpers.ts
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
import { getCurrentUser, resolveRepos } from "./check-helpers.ts";

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
      "vitals-os",
      "https://github.com/app-vitals/vitals-os.git",
    );
    const result = resolveRepos(tmpDir);
    expect(result).toContain("app-vitals/vitals-os");
  });

  test("parses SSH remote URL from git clone in repos/", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "vitals-os",
      "git@github.com:app-vitals/vitals-os.git",
    );
    const result = resolveRepos(tmpDir);
    expect(result).toContain("app-vitals/vitals-os");
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
      "vitals-os",
      "https://github.com/app-vitals/vitals-os.git",
    );
    makeGitClone(
      reposDir,
      "patrol",
      "https://github.com/example-org/example-repo.git",
    );
    const result = resolveRepos(tmpDir);
    expect(result).toContain("app-vitals/vitals-os");
    expect(result).toContain("example-org/example-repo");
    expect(result).toHaveLength(2);
  });

  test("skips subdirs without .git directory", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    // Not a git clone — just a regular dir
    mkdirSync(join(reposDir, "not-a-repo"));
    makeGitClone(
      reposDir,
      "vitals-os",
      "https://github.com/app-vitals/vitals-os.git",
    );
    const result = resolveRepos(tmpDir);
    expect(result).toHaveLength(1);
    expect(result).toContain("app-vitals/vitals-os");
  });

  test("falls back to SHIPWRIGHT_REPOS_DIR when repos/ is empty", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true }); // empty repos/ dir

    const envReposDir = join(tmpDir, "env-repos");
    mkdirSync(envReposDir, { recursive: true });
    makeGitClone(
      envReposDir,
      "vitals-os",
      "https://github.com/app-vitals/vitals-os.git",
    );

    process.env.SHIPWRIGHT_REPOS_DIR = envReposDir;
    const result = resolveRepos(tmpDir);
    expect(result).toContain("app-vitals/vitals-os");
  });

  test("falls back to SHIPWRIGHT_REPOS_DIR when repos/ does not exist", () => {
    // No repos/ dir at all
    const envReposDir = join(tmpDir, "env-repos");
    mkdirSync(envReposDir, { recursive: true });
    makeGitClone(
      envReposDir,
      "vitals-os",
      "git@github.com:app-vitals/vitals-os.git",
    );

    process.env.SHIPWRIGHT_REPOS_DIR = envReposDir;
    const result = resolveRepos(tmpDir);
    expect(result).toContain("app-vitals/vitals-os");
  });

  test("repos/ takes priority over SHIPWRIGHT_REPOS_DIR when non-empty", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "vitals-os",
      "https://github.com/app-vitals/vitals-os.git",
    );

    const envReposDir = join(tmpDir, "env-repos");
    mkdirSync(envReposDir, { recursive: true });
    makeGitClone(
      envReposDir,
      "patrol",
      "https://github.com/example-org/example-repo.git",
    );

    process.env.SHIPWRIGHT_REPOS_DIR = envReposDir;
    const result = resolveRepos(tmpDir);
    // repos/ is non-empty, so env var is ignored
    expect(result).toContain("app-vitals/vitals-os");
    expect(result).not.toContain("example-org/example-repo");
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
    writeFakeGhBinary(tmpDir, "vitals-os-agent[bot]");
    process.env.PATH = `${tmpDir}:${savedPath}`;
    const result = await getCurrentUser();
    expect(result).toBe("app/vitals-os-agent");
  });
});
