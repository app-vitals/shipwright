/**
 * plugins/shipwright/scripts/check-helpers.unit.test.ts
 *
 * Unit tests for resolveRepos(), resolveScopedRepos(), getCurrentUser(), and
 * createTaskStoreClient() in check-helpers.ts
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
import * as checkHelpers from "./check-helpers.ts";
import {
  createTaskStoreClient,
  getCurrentUser,
  resolveAllRepos,
  resolveRepoDirs,
  resolveRepos,
  resolveScopedRepos,
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
    delete process.env.SHIPWRIGHT_REPOS_DIR;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.SHIPWRIGHT_REPOS_DIR = savedEnv;
    } else {
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
    delete process.env.SHIPWRIGHT_REPOS_DIR;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.SHIPWRIGHT_REPOS_DIR = savedEnv;
    } else {
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
    delete process.env.SHIPWRIGHT_REPOS_DIR;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.SHIPWRIGHT_REPOS_DIR = savedEnv;
    } else {
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
// resolveScopedRepos
// ---------------------------------------------------------------------------

describe("resolveScopedRepos", () => {
  let tmpDir: string;
  let savedEnv: {
    apiUrl: string | undefined;
    agentId: string | undefined;
    apiKey: string | undefined;
    reposDir: string | undefined;
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "resolve-scoped-repos-test-"));
    savedEnv = {
      apiUrl: process.env.SHIPWRIGHT_API_URL,
      agentId: process.env.SHIPWRIGHT_AGENT_ID,
      apiKey: process.env.SHIPWRIGHT_AGENT_API_KEY,
      reposDir: process.env.SHIPWRIGHT_REPOS_DIR,
    };
    process.env.SHIPWRIGHT_API_URL = "https://api.example.com";
    process.env.SHIPWRIGHT_AGENT_ID = "agent-123";
    process.env.SHIPWRIGHT_AGENT_API_KEY = "test-api-key";
    delete process.env.SHIPWRIGHT_REPOS_DIR;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries({
      SHIPWRIGHT_API_URL: savedEnv.apiUrl,
      SHIPWRIGHT_AGENT_ID: savedEnv.agentId,
      SHIPWRIGHT_AGENT_API_KEY: savedEnv.apiKey,
      SHIPWRIGHT_REPOS_DIR: savedEnv.reposDir,
    })) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns the intersection of configured repos and cloned repos", async () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(reposDir, "A", "https://github.com/org/A.git");
    makeGitClone(reposDir, "B", "https://github.com/org/B.git");

    let calls = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls++;
      expect(url).toBe("https://api.example.com/agents/agent-123/config");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-api-key");
      return {
        ok: true,
        json: async () => ({ repos: ["org/A", "org/C"] }),
      } as Response;
    }) as unknown as typeof fetch;

    const result = await resolveScopedRepos(tmpDir, { fetchFn });
    expect(result).toEqual(["org/A"]);
    expect(calls).toBe(1);
  });

  test("returns [] and does not call fetch when an env var is missing", async () => {
    delete process.env.SHIPWRIGHT_AGENT_API_KEY;
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(reposDir, "A", "https://github.com/org/A.git");

    let called = false;
    const fetchFn = (async () => {
      called = true;
      return { ok: true, json: async () => ({ repos: ["org/A"] }) } as Response;
    }) as unknown as typeof fetch;

    const result = await resolveScopedRepos(tmpDir, { fetchFn });
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  test("returns [] when fetch throws", async () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(reposDir, "A", "https://github.com/org/A.git");

    const fetchFn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await resolveScopedRepos(tmpDir, { fetchFn });
    expect(result).toEqual([]);
  });

  test("returns [] on a non-2xx response", async () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(reposDir, "A", "https://github.com/org/A.git");

    const fetchFn = (async () =>
      ({ ok: false, status: 404 }) as Response) as unknown as typeof fetch;

    const result = await resolveScopedRepos(tmpDir, { fetchFn });
    expect(result).toEqual([]);
  });

  test("returns [] when the response body has no repos field", async () => {
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(reposDir, "A", "https://github.com/org/A.git");

    const fetchFn = (async () =>
      ({
        ok: true,
        json: async () => ({}),
      }) as Response) as unknown as typeof fetch;

    const result = await resolveScopedRepos(tmpDir, { fetchFn });
    expect(result).toEqual([]);
  });

  test("resolves the default fetchFn without I/O when called with no deps", async () => {
    // Omitting `deps` exercises the `deps.fetchFn ?? fetch` default-resolution
    // path. The env guard is tripped first (no API key), so the resolved fetch
    // is never called — no socket, no global override, consistent with this
    // file's unit layer ("pure logic, no I/O") and the repo's isolation rule
    // against global.fetch overrides.
    delete process.env.SHIPWRIGHT_AGENT_API_KEY;
    const reposDir = join(tmpDir, "repos");
    mkdirSync(reposDir, { recursive: true });
    makeGitClone(reposDir, "A", "https://github.com/org/A.git");

    const result = await resolveScopedRepos(tmpDir);
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
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    }
    if (savedEnv.token !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN = savedEnv.token;
    } else {
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

  test("isCleanApproveBody is not exported from check-helpers", () => {
    expect(
      (checkHelpers as Record<string, unknown>).isCleanApproveBody,
    ).toBeUndefined();
  });
});
