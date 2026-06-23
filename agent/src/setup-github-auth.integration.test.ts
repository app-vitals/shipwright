/**
 * Tests for agent/src/setup-github-auth.ts
 *
 * Tests the GitHub auth initialization logic extracted from entrypoint.ts.
 * Uses full dependency injection — no real GitHub API calls, no real git/gh processes.
 */

import { describe, expect, mock, test } from "bun:test";
import type { BotIdentity } from "./github-app-auth.ts";
import { type GitHubAuthDeps, setupGitHubAuth } from "./setup-github-auth.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTokenManager(token = "ghs_test_token") {
  const getToken = mock(async () => token);
  const startBackgroundRefresh = mock(
    (_onRefresh: (t: string) => Promise<void>) => {},
  );
  return { getToken, startBackgroundRefresh };
}

function makeSpawnSync(status = 0) {
  return mock(
    (
      _cmd: string,
      _args: string[],
      _opts: {
        stdio: string;
        env: Record<string, string | undefined>;
      },
    ) => ({ status }),
  );
}

function makeBotIdentity(
  identity: BotIdentity = {
    slug: "keanu-hifriends",
    name: "Keanu HiFriends",
    userId: 987654,
  },
) {
  return mock(async () => identity);
}

function neverCalledBotIdentity() {
  return mock(async (): Promise<BotIdentity> => {
    throw new Error("should not be called");
  });
}

const TEST_TOKEN_PATH = "/tmp/test-vitals-agent-gh-token";
const TEST_HELPER_PATH = "/tmp/test-bin/git-credential-vitals.sh";

function makeWriteToken() {
  return mock((_token: string) => {});
}

function neverCalledWriteToken() {
  return mock((_token: string) => {
    throw new Error("should not be called");
  });
}

// ─── Tests: App path ──────────────────────────────────────────────────────────

describe("setupGitHubAuth — App path", () => {
  test("writes token to file, registers credential helper via git config, configures bot identity, starts background refresh", async () => {
    const { getToken, startBackgroundRefresh } =
      makeTokenManager("ghs_app_token");
    const spawnSync = makeSpawnSync();
    const writeToken = makeWriteToken();
    const getBotIdentity = makeBotIdentity({
      slug: "keanu-hifriends",
      name: "Keanu HiFriends",
      userId: 987654,
    });

    const deps: GitHubAuthDeps = {
      env: {
        GH_APP_ID: "123",
        GH_APP_INSTALLATION_ID: "456",
        GH_APP_PRIVATE_KEY: "fake-private-key",
      },
      createTokenManager: mock(() => ({ getToken, startBackgroundRefresh })),
      getBotIdentity,
      spawnSync,
      writeToken,
      tokenPath: TEST_TOKEN_PATH,
      credentialHelperPath: TEST_HELPER_PATH,
    };

    await setupGitHubAuth(deps);

    expect(deps.createTokenManager).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(1);

    // App path must NOT mutate env.GH_TOKEN — the credential helper reads from
    // GH_TOKEN_FILE on disk, not from a process-env var that doesn't propagate
    // to subprocesses through the kernel-level env snapshot.
    expect(deps.env.GH_TOKEN).toBeUndefined();
    expect(deps.env.GH_TOKEN_FILE).toBe(TEST_TOKEN_PATH);

    // Token written to disk via the injected writeToken
    expect(writeToken).toHaveBeenCalledTimes(1);
    expect(writeToken).toHaveBeenCalledWith("ghs_app_token");

    expect(getBotIdentity).toHaveBeenCalledTimes(1);

    // Credential helper registered via git config (no `gh auth setup-git`)
    const expectedEnv = expect.objectContaining({
      GH_TOKEN_FILE: TEST_TOKEN_PATH,
    });
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      [
        "config",
        "--global",
        "credential.https://github.com.helper",
        `!${TEST_HELPER_PATH}`,
      ],
      { stdio: "inherit", env: expectedEnv },
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["config", "--global", "user.name", "keanu-hifriends[bot]"],
      { stdio: "inherit", env: expectedEnv },
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      [
        "config",
        "--global",
        "user.email",
        "987654+keanu-hifriends[bot]@users.noreply.github.com",
      ],
      { stdio: "inherit", env: expectedEnv },
    );
    // safe.directory always set unconditionally
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["config", "--global", "safe.directory", "*"],
      { stdio: "inherit", env: expect.any(Object) },
    );
    // No `gh auth setup-git` invocation on the App path anymore
    for (const call of spawnSync.mock.calls) {
      expect(call[0]).not.toBe("gh");
    }
    expect(spawnSync).toHaveBeenCalledTimes(4);
    expect(startBackgroundRefresh).toHaveBeenCalledTimes(1);
  });

  test("logs an error when git config credential helper registration exits non-zero", async () => {
    const { getToken, startBackgroundRefresh } = makeTokenManager();
    const spawnSync = makeSpawnSync(1);
    const errorSpy = mock((..._args: unknown[]) => {});

    await setupGitHubAuth({
      env: {
        GH_APP_ID: "123",
        GH_APP_INSTALLATION_ID: "456",
        GH_APP_PRIVATE_KEY: "fake-private-key",
      },
      createTokenManager: mock(() => ({ getToken, startBackgroundRefresh })),
      getBotIdentity: makeBotIdentity(),
      spawnSync,
      writeToken: makeWriteToken(),
      tokenPath: TEST_TOKEN_PATH,
      credentialHelperPath: TEST_HELPER_PATH,
      logger: { error: errorSpy },
    });

    expect(errorSpy).toHaveBeenCalled();
    // call[0] = safe.directory failure (fires first, unconditionally)
    const safeDirectoryCall = errorSpy.mock.calls[0]?.[0] as string;
    expect(safeDirectoryCall).toContain("safe.directory");
    expect(safeDirectoryCall).toContain("status 1");
    // call[1] = credential helper failure (the actual subject of this test)
    const credHelperCall = errorSpy.mock.calls[1]?.[0] as string;
    expect(credHelperCall).toContain("credential");
    expect(credHelperCall).toContain("status 1");
  });

  test("background refresh callback rewrites the token file only — no env mutation, no further spawnSync calls", async () => {
    let capturedCallback: ((t: string) => Promise<void>) | null = null;
    const getToken = mock(async () => "ghs_first_token");
    const startBackgroundRefresh = mock((cb: (t: string) => Promise<void>) => {
      capturedCallback = cb;
    });
    const spawnSync = makeSpawnSync();
    const writeToken = makeWriteToken();

    const deps: GitHubAuthDeps = {
      env: {
        GH_APP_ID: "123",
        GH_APP_INSTALLATION_ID: "456",
        GH_APP_PRIVATE_KEY: "fake-private-key",
      },
      createTokenManager: mock(() => ({ getToken, startBackgroundRefresh })),
      getBotIdentity: makeBotIdentity(),
      spawnSync,
      writeToken,
      tokenPath: TEST_TOKEN_PATH,
      credentialHelperPath: TEST_HELPER_PATH,
    };

    await setupGitHubAuth(deps);
    const writeCallsBeforeRefresh = writeToken.mock.calls.length;
    const spawnCallsBeforeRefresh = spawnSync.mock.calls.length;

    expect(capturedCallback).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    await capturedCallback!("ghs_refreshed_token");

    // refresh writes the new token to the file...
    expect(writeToken.mock.calls.length).toBe(writeCallsBeforeRefresh + 1);
    expect(writeToken).toHaveBeenLastCalledWith("ghs_refreshed_token");
    // ...and does NOT mutate env.GH_TOKEN or spawn anything
    expect(deps.env.GH_TOKEN).toBeUndefined();
    expect(spawnSync.mock.calls.length).toBe(spawnCallsBeforeRefresh);
  });
});

// ─── Tests: PAT path ─────────────────────────────────────────────────────────

describe("setupGitHubAuth — PAT path", () => {
  test("calls spawnSync with gh auth setup-git when only GH_TOKEN is set", async () => {
    const spawnSync = makeSpawnSync();
    const createTokenManager = mock(() => {
      throw new Error("should not be called");
    });
    const getBotIdentity = neverCalledBotIdentity();
    const writeToken = neverCalledWriteToken();

    const deps: GitHubAuthDeps = {
      env: { GH_TOKEN: "ghp_test_pat" },
      createTokenManager,
      getBotIdentity,
      spawnSync,
      writeToken,
      tokenPath: TEST_TOKEN_PATH,
      credentialHelperPath: TEST_HELPER_PATH,
    };

    await setupGitHubAuth(deps);

    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["config", "--global", "safe.directory", "*"],
      { stdio: "inherit", env: expect.any(Object) },
    );
    expect(spawnSync).toHaveBeenCalledWith("gh", ["auth", "setup-git"], {
      stdio: "inherit",
      env: expect.objectContaining({ GH_TOKEN: "ghp_test_pat" }),
    });
    expect(createTokenManager).not.toHaveBeenCalled();
    expect(getBotIdentity).not.toHaveBeenCalled();
    expect(writeToken).not.toHaveBeenCalled();
    // PAT path doesn't touch GH_TOKEN_FILE — it relies on gh's helper
    expect(deps.env.GH_TOKEN_FILE).toBeUndefined();
  });
});

// ─── Tests: Skip path ────────────────────────────────────────────────────────

describe("setupGitHubAuth — no auth configured", () => {
  test("skips all GitHub setup when neither GH_TOKEN nor GH_APP_* vars are set", async () => {
    const spawnSync = makeSpawnSync();
    const createTokenManager = mock(() => {
      throw new Error("should not be called");
    });
    const getBotIdentity = neverCalledBotIdentity();
    const writeToken = neverCalledWriteToken();

    const deps: GitHubAuthDeps = {
      env: {},
      createTokenManager,
      getBotIdentity,
      spawnSync,
      writeToken,
      tokenPath: TEST_TOKEN_PATH,
      credentialHelperPath: TEST_HELPER_PATH,
    };

    await setupGitHubAuth(deps);

    // safe.directory is set even when no auth is configured
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["config", "--global", "safe.directory", "*"],
      { stdio: "inherit", env: expect.any(Object) },
    );
    expect(createTokenManager).not.toHaveBeenCalled();
    expect(getBotIdentity).not.toHaveBeenCalled();
    expect(writeToken).not.toHaveBeenCalled();
  });

  test("skips when only some GH_APP_* vars are present (incomplete)", async () => {
    const spawnSync = makeSpawnSync();
    const createTokenManager = mock(() => {
      throw new Error("should not be called");
    });
    const getBotIdentity = neverCalledBotIdentity();
    const writeToken = neverCalledWriteToken();

    const deps: GitHubAuthDeps = {
      env: { GH_APP_ID: "123" },
      createTokenManager,
      getBotIdentity,
      spawnSync,
      writeToken,
      tokenPath: TEST_TOKEN_PATH,
      credentialHelperPath: TEST_HELPER_PATH,
    };

    await setupGitHubAuth(deps);

    // safe.directory is set even with incomplete GH_APP_* vars
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["config", "--global", "safe.directory", "*"],
      { stdio: "inherit", env: expect.any(Object) },
    );
    expect(createTokenManager).not.toHaveBeenCalled();
    expect(getBotIdentity).not.toHaveBeenCalled();
    expect(writeToken).not.toHaveBeenCalled();
  });
});
