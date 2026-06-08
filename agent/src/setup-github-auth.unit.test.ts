/**
 * agent/src/setup-github-auth.unit.test.ts
 *
 * Unit tests for setupGitHubAuth — three branches:
 *   1. GitHub App path (GH_APP_ID + GH_APP_INSTALLATION_ID + GH_APP_PRIVATE_KEY)
 *   2. PAT path (GH_TOKEN only)
 *   3. Skip path (neither configured)
 *
 * All external I/O is injected via GitHubAuthDeps — no real network or fs.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { setupGitHubAuth } from "./setup-github-auth.ts";
import type { GitHubAuthDeps } from "./setup-github-auth.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface SpawnCall {
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
}

interface TokenManagerStub {
  tokens: string[];
  refreshCallbacks: Array<(token: string) => Promise<void>>;
  getTokenCallCount: number;
  startRefreshCallCount: number;
}

function makeTokenManagerStub(tokens: string[]): {
  stub: TokenManagerStub;
  factory: () => { getToken(): Promise<string>; startBackgroundRefresh(fn: (t: string) => Promise<void>): void };
} {
  const stub: TokenManagerStub = {
    tokens: [...tokens],
    refreshCallbacks: [],
    getTokenCallCount: 0,
    startRefreshCallCount: 0,
  };
  let callIdx = 0;
  return {
    stub,
    factory: () => ({
      async getToken() {
        stub.getTokenCallCount++;
        return stub.tokens[callIdx++] ?? "fallback-token";
      },
      startBackgroundRefresh(fn: (t: string) => Promise<void>) {
        stub.startRefreshCallCount++;
        stub.refreshCallbacks.push(fn);
      },
    }),
  };
}

function makeDeps(
  env: Record<string, string | undefined>,
  tokenManagerTokens: string[] = ["initial-token"],
): {
  deps: GitHubAuthDeps;
  spawnCalls: SpawnCall[];
  writtenTokens: string[];
  stub: TokenManagerStub;
} {
  const spawnCalls: SpawnCall[] = [];
  const writtenTokens: string[] = [];
  const { stub, factory } = makeTokenManagerStub(tokenManagerTokens);

  const deps: GitHubAuthDeps = {
    env: { ...env },
    createTokenManager: factory,
    getBotIdentity: async () => ({
      slug: "test-bot",
      name: "Test Bot",
      userId: 12345,
    }),
    spawnSync: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, env: opts.env });
      return { status: 0 };
    },
    writeToken: (token) => {
      writtenTokens.push(token);
    },
    tokenPath: "/run/test/gh-token",
    credentialHelperPath: "/usr/local/bin/git-credential-vitals",
  };

  return { deps, spawnCalls, writtenTokens, stub };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("setupGitHubAuth — GitHub App path", () => {
  const appEnv = {
    GH_APP_ID: "123",
    GH_APP_INSTALLATION_ID: "456",
    GH_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
  };

  it("mints a token and writes it to the token file", async () => {
    const { deps, writtenTokens } = makeDeps(appEnv);
    await setupGitHubAuth(deps);
    expect(writtenTokens.length).toBeGreaterThan(0);
    expect(writtenTokens[0]).toBe("initial-token");
  });

  it("sets GH_TOKEN_FILE in env to tokenPath", async () => {
    const { deps } = makeDeps(appEnv);
    await setupGitHubAuth(deps);
    expect(deps.env.GH_TOKEN_FILE).toBe("/run/test/gh-token");
  });

  it("configures git credential helper", async () => {
    const { deps, spawnCalls } = makeDeps(appEnv);
    await setupGitHubAuth(deps);
    const gitConfigCall = spawnCalls.find(
      (c) =>
        c.cmd === "git" &&
        c.args.includes("credential.https://github.com.helper"),
    );
    expect(gitConfigCall).toBeDefined();
    expect(gitConfigCall?.args.some((a) => a.includes("git-credential-vitals"))).toBe(true);
  });

  it("configures git user.name and user.email as bot identity", async () => {
    const { deps, spawnCalls } = makeDeps(appEnv);
    await setupGitHubAuth(deps);

    const nameCall = spawnCalls.find(
      (c) => c.cmd === "git" && c.args.includes("user.name"),
    );
    expect(nameCall).toBeDefined();
    expect(nameCall?.args).toContain("test-bot[bot]");

    const emailCall = spawnCalls.find(
      (c) => c.cmd === "git" && c.args.includes("user.email"),
    );
    expect(emailCall).toBeDefined();
    expect(emailCall?.args[emailCall?.args.length - 1]).toContain("test-bot[bot]@users.noreply.github.com");
  });

  it("starts background refresh", async () => {
    const { deps, stub } = makeDeps(appEnv);
    await setupGitHubAuth(deps);
    expect(stub.startRefreshCallCount).toBe(1);
  });
});

describe("setupGitHubAuth — PAT path", () => {
  it("runs gh auth setup-git when only GH_TOKEN is set", async () => {
    const { deps, spawnCalls, writtenTokens, stub } = makeDeps({
      GH_TOKEN: "ghp_test123",
    });
    await setupGitHubAuth(deps);

    // No token minted or written
    expect(writtenTokens.length).toBe(0);
    // No background refresh
    expect(stub.startRefreshCallCount).toBe(0);

    const ghCall = spawnCalls.find(
      (c) => c.cmd === "gh" && c.args.includes("setup-git"),
    );
    expect(ghCall).toBeDefined();
    expect(ghCall?.args).toEqual(["auth", "setup-git"]);
  });
});

describe("setupGitHubAuth — skip path", () => {
  it("does nothing when no GitHub credentials are configured", async () => {
    const { deps, spawnCalls, writtenTokens } = makeDeps({});
    await setupGitHubAuth(deps);

    expect(spawnCalls.length).toBe(0);
    expect(writtenTokens.length).toBe(0);
  });
});
