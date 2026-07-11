/**
 * plugins/shipwright/scripts/check-helpers.unit.test.ts
 *
 * Unit tests for resolveRepos(), getCurrentUser(), and createTaskStoreClient()
 * in check-helpers.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTaskStoreClient,
  getCurrentUser,
  isCleanApproveBody,
  resolveAllRepos,
  resolveRepoDirs,
  resolveRepos,
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
// resolveRepoDirs
// ---------------------------------------------------------------------------

describe("resolveRepoDirs", () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "resolve-repo-dirs-test-"));
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
    expect(resolveRepoDirs(tmpDir)).toEqual([]);
  });

  test("returns repo + absolute local dir path for each clone", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "example-repo",
      "https://github.com/acme/example-repo.git",
    );
    const result = resolveRepoDirs(tmpDir);
    expect(result).toEqual([
      { repo: "acme/example-repo", dir: join(reposDir, "example-repo") },
    ]);
  });

  test("returns multiple repo dirs when multiple git clones exist", () => {
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
    const result = resolveRepoDirs(tmpDir);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      repo: "acme/example-repo",
      dir: join(reposDir, "example-repo"),
    });
    expect(result).toContainEqual({
      repo: "acme/other-repo",
      dir: join(reposDir, "other-repo"),
    });
  });

  test("skips subdirs without .git directory", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    mkdirSync(join(reposDir, "not-a-repo"));
    makeGitClone(
      reposDir,
      "example-repo",
      "https://github.com/acme/example-repo.git",
    );
    const result = resolveRepoDirs(tmpDir);
    expect(result).toHaveLength(1);
  });

  test("falls back to SHIPWRIGHT_REPOS_DIR when repos/ is empty", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });

    const envReposDir = join(tmpDir, "env-repos");
    mkdirSync(envReposDir, { recursive: true });
    makeGitClone(
      envReposDir,
      "example-repo",
      "https://github.com/acme/example-repo.git",
    );

    process.env.SHIPWRIGHT_REPOS_DIR = envReposDir;
    const result = resolveRepoDirs(tmpDir);
    expect(result).toEqual([
      { repo: "acme/example-repo", dir: join(envReposDir, "example-repo") },
    ]);
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
    writeFakeGhBinary(tmpDir, "example-repo-agent[bot]");
    process.env.PATH = `${tmpDir}:${savedPath}`;
    const result = await getCurrentUser();
    expect(result).toBe("app/example-repo-agent");
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
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedEnv = {
      url: process.env.SHIPWRIGHT_TASK_STORE_URL,
      token: process.env.SHIPWRIGHT_TASK_STORE_TOKEN,
    };
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://task-store.example.com";
    process.env.SHIPWRIGHT_TASK_STORE_TOKEN = "test-token";
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
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
    mock.restore();
  });

  test("unwraps { tasks } envelope from ?ready=true", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        json: async () => ({ tasks: [FAKE_TASK], total: 1 }),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient();
    const result = await client.query(new URLSearchParams({ ready: "true" }));
    expect(result).toEqual([FAKE_TASK]);
  });

  test("unwraps paginated { tasks } envelope (returned by ?status=...)", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          tasks: [FAKE_TASK],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient();
    const result = await client.query(
      new URLSearchParams({ status: "in_progress" }),
    );
    expect(result).toEqual([FAKE_TASK]);
  });

  test("returns empty array when paginated envelope has empty tasks list", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        json: async () => ({ tasks: [], total: 0, limit: 50, offset: 0 }),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient();
    const result = await client.query(
      new URLSearchParams({ status: "in_progress" }),
    );
    expect(result).toEqual([]);
  });

  test("throws on unrecognised response shape", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        json: async () => ({ unexpected: true }),
      }) as Response) as unknown as typeof fetch;

    const client = createTaskStoreClient();
    await expect(
      client.query(new URLSearchParams({ status: "in_progress" })),
    ).rejects.toThrow("Unexpected task-store response format");
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
