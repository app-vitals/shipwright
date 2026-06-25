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
  readShipwrightConfig,
  resolveAllRepos,
  resolveRepos,
} from "./check-helpers.ts";

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
      "patrol",
      "https://github.com/app-vitals/patrol.git",
    );
    const result = resolveRepos(tmpDir);
    expect(result).toContain("acme/example-repo");
    expect(result).toContain("app-vitals/patrol");
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
      "patrol",
      "https://github.com/app-vitals/patrol.git",
    );

    process.env.SHIPWRIGHT_REPOS_DIR = envReposDir;
    const result = resolveRepos(tmpDir);
    // repos/ is non-empty, so env var is ignored
    expect(result).toContain("acme/example-repo");
    expect(result).not.toContain("app-vitals/patrol");
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
// readShipwrightConfig
// ---------------------------------------------------------------------------

describe("readShipwrightConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "shipwright-config-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns null when config file does not exist", () => {
    expect(readShipwrightConfig(tmpDir)).toBeNull();
  });

  test("returns null when config file has non-github taskStore", () => {
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(
      join(tmpDir, "state", "shipwright.config.json"),
      JSON.stringify({ taskStore: "todos" }),
    );
    expect(readShipwrightConfig(tmpDir)).toBeNull();
  });

  test("returns null when config has github taskStore but missing owner/repo", () => {
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(
      join(tmpDir, "state", "shipwright.config.json"),
      JSON.stringify({ taskStore: "github", github: {} }),
    );
    expect(readShipwrightConfig(tmpDir)).toBeNull();
  });

  test("returns null when config file contains invalid JSON", () => {
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(
      join(tmpDir, "state", "shipwright.config.json"),
      "not valid json",
    );
    expect(readShipwrightConfig(tmpDir)).toBeNull();
  });

  test("returns owner and repo for valid github taskStore config", () => {
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(
      join(tmpDir, "state", "shipwright.config.json"),
      JSON.stringify({
        taskStore: "github",
        github: { owner: "app-vitals", repo: "shipwright" },
      }),
    );
    expect(readShipwrightConfig(tmpDir)).toEqual({
      owner: "app-vitals",
      repo: "shipwright",
    });
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

  test("returns default fallback when no config and no scanned repos", () => {
    expect(resolveAllRepos(tmpDir)).toEqual(["app-vitals/shipwright"]);
  });

  test("returns scanned repos when no shipwright config present", () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "patrol",
      "https://github.com/app-vitals/patrol.git",
    );
    expect(resolveAllRepos(tmpDir)).toEqual(["app-vitals/patrol"]);
  });

  test("places config repo first when shipwright config is present", () => {
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(
      join(tmpDir, "state", "shipwright.config.json"),
      JSON.stringify({
        taskStore: "github",
        github: { owner: "app-vitals", repo: "shipwright" },
      }),
    );
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "other-repo",
      "https://github.com/example-org/other-repo.git",
    );
    const result = resolveAllRepos(tmpDir);
    expect(result[0]).toBe("app-vitals/shipwright");
    expect(result).toContain("example-org/other-repo");
  });

  test("deduplicates config repo when it also appears in scanned repos", () => {
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(
      join(tmpDir, "state", "shipwright.config.json"),
      JSON.stringify({
        taskStore: "github",
        github: { owner: "app-vitals", repo: "shipwright" },
      }),
    );
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "shipwright",
      "https://github.com/app-vitals/shipwright.git",
    );
    makeGitClone(
      reposDir,
      "other-repo",
      "https://github.com/example-org/other-repo.git",
    );
    const result = resolveAllRepos(tmpDir);
    expect(result.filter((r) => r === "app-vitals/shipwright")).toHaveLength(1);
    expect(result[0]).toBe("app-vitals/shipwright");
  });

  test("falls back to scanned repos when config has non-github taskStore", () => {
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(
      join(tmpDir, "state", "shipwright.config.json"),
      JSON.stringify({ taskStore: "todos" }),
    );
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(
      reposDir,
      "patrol",
      "https://github.com/app-vitals/patrol.git",
    );
    expect(resolveAllRepos(tmpDir)).toEqual(["app-vitals/patrol"]);
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

  test("handles bare Task[] response (returned by ?ready=true)", async () => {
    mock.module("node:fetch", () => ({}));
    globalThis.fetch = (async () =>
      ({
        ok: true,
        json: async () => [FAKE_TASK],
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
