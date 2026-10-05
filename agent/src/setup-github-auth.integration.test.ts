/**
 * Tests for agent/src/setup-github-auth.ts
 *
 * Tests the GitHub auth initialization logic extracted from entrypoint.ts.
 * Uses full dependency injection — no real GitHub API calls, no real git/gh processes.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentReposRef } from "./agent-repos-ref.ts";
import { writeTokenFiles } from "./gh-token-files.ts";
import type { BotIdentity } from "./github-app-auth.ts";
import {
  createGitHubAuthActiveRef,
  createGitHubAuthStartGuard,
  createGitHubInstallationsManagerRef,
  reconcileGitHubInstallations,
  startGitHubAuthIfPossible,
} from "./github-auth-startup.ts";
import { GitHubInstallationsManager } from "./github-installations.ts";
import {
  type GitHubAuthDeps,
  type GitHubInstallationsDeps,
  setupGitHubAuth,
} from "./setup-github-auth.ts";

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
      [
        "config",
        "--global",
        "credential.https://github.com.useHttpPath",
        "true",
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
    expect(spawnSync).toHaveBeenCalledTimes(5);
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

// ─── Tests: installations manager (MGI-2.4) ─────────────────────────────────

type RawInstall = { id: number; owner: string };

/**
 * Real GitHubInstallationsManager with injected auth/fetch/clock and a fake
 * setIntervalFn, plus real token files in a temp agent home.
 */
function makeInstallationsHarness(
  opts: {
    installs?: RawInstall[];
    pin?: number;
    scopeOwners?: string[] | null;
    discoveryStatus?: number;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "mgi-24-"));
  let installs = opts.installs ?? [];
  let discoveryStatus = opts.discoveryStatus ?? 200;
  let scopeOwners = opts.scopeOwners === undefined ? null : opts.scopeOwners;
  const intervals: { fn: () => void; cleared: boolean }[] = [];
  const created: GitHubInstallationsManager[] = [];
  const activated: unknown[] = [];

  const auth = async (p?: { type: string; installationId?: number }) => {
    if (p?.type === "app")
      return { token: "jwt", expiresAt: "", type: "app", tokenType: "app" };
    return {
      token: `ghs_inst_${p?.installationId}`,
      expiresAt: new Date(Date.UTC(2030, 0, 1)).toISOString(),
      type: "token",
      tokenType: "installation",
    };
  };
  const fetchFn = (async () =>
    new Response(
      JSON.stringify(
        installs.map((i) => ({
          id: i.id,
          account: { login: i.owner },
          suspended_at: null,
        })),
      ),
      { status: discoveryStatus },
    )) as unknown as typeof fetch;
  const setIntervalFn = ((fn: () => void) => {
    const rec = { fn, cleared: false };
    intervals.push(rec);
    return rec as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  const clearIntervalFn = ((h: { cleared: boolean }) => {
    h.cleared = true;
  }) as unknown as typeof clearInterval;

  const installations: GitHubInstallationsDeps = {
    createManager: (onTokensChanged) => {
      const m = new GitHubInstallationsManager({
        auth,
        fetchFn,
        clock: { now: () => new Date(Date.UTC(2029, 0, 1)) },
        setIntervalFn,
        clearIntervalFn,
        pinnedId: opts.pin ?? null,
        onEvent: (e) => {
          if (e.type === "minted") onTokensChanged();
        },
        onChange: () => onTokensChanged(),
      });
      created.push(m);
      return m;
    },
    getScopeOwners: () => scopeOwners,
    writeTokenFiles: (input) => writeTokenFiles(home, input),
    onActivated: (m) => activated.push(m),
  };

  const env: Record<string, string | undefined> = {
    GH_APP_ID: "123",
    GH_APP_PRIVATE_KEY: "fake-private-key",
  };
  if (opts.pin !== undefined) env.GH_APP_INSTALLATION_ID = String(opts.pin);

  return {
    home,
    env,
    installations,
    intervals,
    created,
    activated,
    tokenPath: join(home, "gh-token"),
    setInstalls: (i: RawInstall[]) => {
      installs = i;
    },
    setScopeOwners: (o: string[] | null) => {
      scopeOwners = o;
    },
    setDiscoveryStatus: (s: number) => {
      discoveryStatus = s;
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** Lets fire-and-forget token-file writes settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("setupGitHubAuth — installations manager", () => {
  let logSpy: ReturnType<typeof spyOn>;
  const harnesses: { cleanup: () => void }[] = [];
  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    for (const h of harnesses.splice(0)) h.cleanup();
  });
  function harness(opts: Parameters<typeof makeInstallationsHarness>[0]) {
    const h = makeInstallationsHarness(opts);
    harnesses.push(h);
    return h;
  }

  test("pinned-only (unsynced scope) produces the same spawnSync calls and token file as the legacy pinned path", async () => {
    // Legacy pinned path (no installations deps) — today's behavior.
    const legacy = harness({ pin: 456 });
    const legacySpawn = makeSpawnSync();
    const legacyTm = makeTokenManager("ghs_inst_456");
    const legacyActivated = await setupGitHubAuth({
      env: { ...legacy.env },
      createTokenManager: mock(() => legacyTm),
      getBotIdentity: makeBotIdentity(),
      spawnSync: legacySpawn,
      writeToken: (t) => writeTokenFiles(legacy.home, { defaultToken: t }),
      tokenPath: legacy.tokenPath,
      credentialHelperPath: TEST_HELPER_PATH,
    });

    const h = harness({
      pin: 456,
      installs: [
        { id: 456, owner: "acme" },
        { id: 789, owner: "other" },
      ],
      scopeOwners: null,
    });
    const spawnSync = makeSpawnSync();
    const createTokenManager = mock(() => makeTokenManager());
    const activated = await setupGitHubAuth({
      env: h.env,
      createTokenManager,
      getBotIdentity: makeBotIdentity(),
      spawnSync,
      writeToken: neverCalledWriteToken(),
      tokenPath: h.tokenPath,
      credentialHelperPath: TEST_HELPER_PATH,
      installations: h.installations,
    });

    expect(legacyActivated).toBe(true);
    expect(activated).toBe(true);
    const norm = (calls: unknown[][], tokenPath: string) =>
      JSON.stringify(calls).replaceAll(tokenPath, "<TOKEN_PATH>");
    expect(norm(spawnSync.mock.calls, h.tokenPath)).toBe(
      norm(legacySpawn.mock.calls, legacy.tokenPath),
    );
    expect(readFileSync(h.tokenPath, "utf8")).toBe(
      readFileSync(legacy.tokenPath, "utf8"),
    );
    expect(existsSync(join(h.home, "gh-token.d"))).toBe(false);
    expect(h.env.GH_TOKEN_FILE).toBe(h.tokenPath);
    expect(createTokenManager).not.toHaveBeenCalled();
    expect(h.intervals).toHaveLength(1);
    expect(h.activated).toEqual([h.created[0]]);
  });

  test("App id + key with two in-scope installations activates and writes per-owner token files", async () => {
    const h = harness({
      installs: [
        { id: 11, owner: "Acme" },
        { id: 22, owner: "other" },
        { id: 33, owner: "out-of-scope" },
      ],
      scopeOwners: ["acme", "other"],
    });
    const spawnSync = makeSpawnSync();
    const activated = await setupGitHubAuth({
      env: h.env,
      createTokenManager: mock(() => {
        throw new Error("should not be called");
      }),
      getBotIdentity: makeBotIdentity(),
      spawnSync,
      writeToken: neverCalledWriteToken(),
      tokenPath: h.tokenPath,
      credentialHelperPath: TEST_HELPER_PATH,
      installations: h.installations,
    });

    expect(activated).toBe(true);
    expect(readFileSync(h.tokenPath, "utf8")).toBe("ghs_inst_11");
    expect(readdirSync(join(h.home, "gh-token.d")).sort()).toEqual([
      "acme",
      "other",
    ]);
    expect(readFileSync(join(h.home, "gh-token.d", "acme"), "utf8")).toBe(
      "ghs_inst_11",
    );
    expect(readFileSync(join(h.home, "gh-token.d", "other"), "utf8")).toBe(
      "ghs_inst_22",
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      [
        "config",
        "--global",
        "credential.https://github.com.helper",
        `!${TEST_HELPER_PATH}`,
      ],
      expect.any(Object),
    );
    expect(h.intervals).toHaveLength(1);
    expect(h.activated).toHaveLength(1);
  });

  test("App id + key + PAT with zero installations stays on the PAT path", async () => {
    const h = harness({ installs: [], scopeOwners: ["acme"] });
    h.env.GH_TOKEN = "ghp_test_pat";
    const spawnSync = makeSpawnSync();
    const activated = await setupGitHubAuth({
      env: h.env,
      createTokenManager: mock(() => {
        throw new Error("should not be called");
      }),
      getBotIdentity: neverCalledBotIdentity(),
      spawnSync,
      writeToken: neverCalledWriteToken(),
      tokenPath: h.tokenPath,
      credentialHelperPath: TEST_HELPER_PATH,
      installations: h.installations,
    });

    expect(activated).toBe(false);
    expect(spawnSync).toHaveBeenCalledWith("gh", ["auth", "setup-git"], {
      stdio: "inherit",
      env: expect.objectContaining({ GH_TOKEN: "ghp_test_pat" }),
    });
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(h.env.GH_TOKEN_FILE).toBeUndefined();
    expect(existsSync(h.tokenPath)).toBe(false);
    expect(h.intervals).toHaveLength(0);
    expect(h.activated).toHaveLength(0);
  });

  test("App id + key, no PAT, and only out-of-scope installations skips setup without activating", async () => {
    const h = harness({
      installs: [{ id: 11, owner: "elsewhere" }],
      scopeOwners: ["acme"],
    });
    const spawnSync = makeSpawnSync();
    const activated = await setupGitHubAuth({
      env: h.env,
      createTokenManager: mock(() => {
        throw new Error("should not be called");
      }),
      getBotIdentity: neverCalledBotIdentity(),
      spawnSync,
      writeToken: neverCalledWriteToken(),
      tokenPath: h.tokenPath,
      credentialHelperPath: TEST_HELPER_PATH,
      installations: h.installations,
    });

    expect(activated).toBe(false);
    expect(spawnSync).toHaveBeenCalledTimes(1); // safe.directory only
    expect(h.intervals).toHaveLength(0);
  });

  test("a pin whose discovery fails falls back to the legacy pinned token manager", async () => {
    const h = harness({ pin: 456, discoveryStatus: 503 });
    const tm = makeTokenManager("ghs_legacy_456");
    const writeToken = makeWriteToken();
    const activated = await setupGitHubAuth({
      env: h.env,
      createTokenManager: mock(() => tm),
      getBotIdentity: makeBotIdentity(),
      spawnSync: makeSpawnSync(),
      writeToken,
      tokenPath: h.tokenPath,
      credentialHelperPath: TEST_HELPER_PATH,
      installations: h.installations,
    });

    expect(activated).toBe(true);
    expect(writeToken).toHaveBeenCalledWith("ghs_legacy_456");
    expect(tm.startBackgroundRefresh).toHaveBeenCalledTimes(1);
    expect(h.intervals).toHaveLength(0);
    expect(h.activated).toHaveLength(0);
  });

  test("after N config-sync ticks there is still exactly one refresh interval, and reconcile picks up new installations", async () => {
    const h = harness({ installs: [], scopeOwners: ["acme", "other"] });
    const activeRef = createGitHubAuthActiveRef();
    const guard = createGitHubAuthStartGuard();
    const managerRef = createGitHubInstallationsManagerRef();
    const reposRef = createAgentReposRef();
    h.installations.onActivated = (m) => managerRef.set(m);
    const spawnSync = makeSpawnSync();

    const tick = async () => {
      reposRef.set(["acme/api", "other/web"]);
      await reconcileGitHubInstallations(managerRef, reposRef);
      return startGitHubAuthIfPossible({
        env: h.env,
        isActive: activeRef.isActive,
        markActive: () => activeRef.setActive(true),
        guard,
        setupGitHubAuth: () =>
          setupGitHubAuth({
            env: h.env,
            createTokenManager: mock(() => {
              throw new Error("should not be called");
            }),
            getBotIdentity: makeBotIdentity(),
            spawnSync,
            writeToken: neverCalledWriteToken(),
            tokenPath: h.tokenPath,
            credentialHelperPath: TEST_HELPER_PATH,
            installations: h.installations,
          }),
      });
    };

    // Zero installations: not active, retried each tick, no interval.
    expect(await tick()).toBe(false);
    expect(await tick()).toBe(false);
    expect(activeRef.isActive()).toBe(false);
    expect(h.intervals).toHaveLength(0);

    // One installation appears: activates exactly once.
    h.setInstalls([{ id: 11, owner: "acme" }]);
    expect(await tick()).toBe(true);
    for (let i = 0; i < 5; i++) expect(await tick()).toBe(false);
    expect(h.intervals).toHaveLength(1);
    expect(h.intervals[0].cleared).toBe(false);
    expect(existsSync(join(h.home, "gh-token.d"))).toBe(false);

    // A second in-scope installation is picked up by a later tick's reconcile.
    h.setInstalls([
      { id: 11, owner: "acme" },
      { id: 22, owner: "other" },
    ]);
    await tick();
    await flush();
    expect(h.intervals).toHaveLength(1);
    expect(readFileSync(h.tokenPath, "utf8")).toBe("ghs_inst_11");
    expect(readFileSync(join(h.home, "gh-token.d", "other"), "utf8")).toBe(
      "ghs_inst_22",
    );
  });
});
