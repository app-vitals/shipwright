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
import {
  createPrRecordQuery,
  createTaskStatusQuery,
  createTaskStoreClient,
  getCurrentUser,
  isCleanApproveBody,
  resolveAllRepos,
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

  test("defaults to true when the field is missing entirely", () => {
    expect(checkHelpers.parseAllowSelfReview("no policy here")).toBe(true);
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

  test("defaults to true when the policy file does not exist", () => {
    expect(checkHelpers.readAllowSelfReview(tmpDir)).toBe(true);
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
function writeFailingGhBinary(dir: string, exitCode: number, stderr: string): string {
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

  test("returns login as-is for a regular PAT user", () => {
    writeFakeGhBinary(tmpDir, "dmcaulay");
    process.env.PATH = `${tmpDir}:${savedPath}`;
    const result = getCurrentUser();
    expect(result).toBe("dmcaulay");
  });

  test("normalises [bot] suffix to app/ prefix for GitHub App identity", () => {
    writeFakeGhBinary(tmpDir, "my-app[bot]");
    process.env.PATH = `${tmpDir}:${savedPath}`;
    const result = getCurrentUser();
    expect(result).toBe("app/my-app");
  });

  test("handles hyphenated app name in [bot] normalisation", () => {
    writeFakeGhBinary(tmpDir, "example-repo-agent[bot]");
    process.env.PATH = `${tmpDir}:${savedPath}`;
    const result = getCurrentUser();
    expect(result).toBe("app/example-repo-agent");
  });

  test("throws when gh exits non-zero", () => {
    writeFailingGhBinary(tmpDir, 1, "not authenticated");
    process.env.PATH = `${tmpDir}:${savedPath}`;
    expect(() => getCurrentUser()).toThrow("gh api graphql failed");
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

    expect(capturedUrl).toBe(
      "https://task-store.example.com/tasks/T-1",
    );
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

  test("returns { status, addedAt } when a linked task is found with both fields present", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          tasks: [
            { id: "T-1", title: "Do the thing", status: "in_progress", addedAt: "2026-05-01T00:00:00.000Z" },
          ],
        }),
      }) as Response) as unknown as typeof fetch;

    const query = createTaskStatusQuery({ fetchFn: fakeFetch });
    const result = await query("acme/example-repo", 42);
    expect(result).toEqual({
      status: "in_progress",
      addedAt: "2026-05-01T00:00:00.000Z",
    });
  });

  test("returns { status, addedAt: undefined } when the matched task has no addedAt", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          tasks: [{ id: "T-1", title: "Do the thing", status: "pending" }],
        }),
      }) as Response) as unknown as typeof fetch;

    const query = createTaskStatusQuery({ fetchFn: fakeFetch });
    const result = await query("acme/example-repo", 42);
    expect(result).toEqual({ status: "pending", addedAt: undefined });
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
