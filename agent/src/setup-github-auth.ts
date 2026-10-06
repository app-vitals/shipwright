/**
 * agent/src/setup-github-auth.ts
 *
 * Wires GitHub authentication on agent startup.
 *
 * - GitHub App path (GH_APP_ID + GH_APP_PRIVATE_KEY): engages only if the
 *   GH_APP_INSTALLATION_ID pin is set or installation discovery finds at
 *   least one usable in-scope installation. Mints the default installation's
 *   token into the token file (plus per-owner files when two or more are
 *   usable), configures the git credential helper + author identity, and
 *   starts exactly one background refresh.
 * - PAT path: runs `gh auth setup-git` (legacy flow preserved) whenever App
 *   auth did not engage.
 * - Neither: skips; the caller retries on its next tick.
 *
 * Resolves true iff App auth activated. Not safely re-invokable after it
 * resolves true — each activation starts its own refresh interval — so
 * callers gate repeat calls on that result (github-auth-startup.ts).
 */

import type { TokenFilesInput } from "./gh-token-files.ts";
import type { BotIdentity } from "./github-app-auth.ts";
import type { InstallationsSnapshot } from "./github-installations.ts";

interface TokenManagerLike {
  getToken(): Promise<string>;
  startBackgroundRefresh(onRefresh: (token: string) => Promise<void>): void;
}

export interface GitHubAuthDeps {
  env: Record<string, string | undefined>;
  createTokenManager: () => TokenManagerLike;
  getBotIdentity: () => Promise<BotIdentity>;
  spawnSync: (
    cmd: string,
    args: string[],
    opts: {
      stdio: "inherit" | "pipe" | "ignore";
      env: Record<string, string | undefined>;
    },
  ) => { status: number | null };
  writeToken: (token: string) => void;
  tokenPath: string;
  credentialHelperPath: string;
  logger?: { error: (...args: unknown[]) => void };
  /**
   * Installation discovery. When absent, App auth requires the
   * GH_APP_INSTALLATION_ID pin and uses the single-installation token
   * manager (the pre-discovery behavior).
   */
  installations?: GitHubInstallationsDeps;
}

/** The slice of GitHubInstallationsManager setupGitHubAuth drives. */
export interface InstallationsManagerLike {
  reconcile(scopeOwners: string[] | null): Promise<void>;
  getState(): InstallationsSnapshot;
  getToken(installationId: number): Promise<string>;
  start(): void;
}

export interface GitHubInstallationsDeps {
  /**
   * Builds a manager; it must call `onTokensChanged` whenever a token may
   * have changed (mint, or installation set/health change).
   */
  createManager: (onTokensChanged: () => void) => InstallationsManagerLike;
  /** Scoped repo owners, or null while scope is unsynced (pinned-only). */
  getScopeOwners: () => string[] | null;
  writeTokenFiles: (input: TokenFilesInput) => void;
  /** Called once with the manager App auth activated with. */
  onActivated?: (manager: InstallationsManagerLike) => void;
}

function runOrWarn(
  spawnSync: GitHubAuthDeps["spawnSync"],
  cmd: string,
  args: string[],
  env: Record<string, string | undefined>,
  logger: { error: (...args: unknown[]) => void } = console,
): void {
  const { status } = spawnSync(cmd, args, { stdio: "inherit", env });
  if (status !== 0) {
    logger.error(
      `[entrypoint] ${cmd} ${args.join(" ")} exited with status ${status} — git auth may be broken`,
    );
  }
}

export async function setupGitHubAuth(deps: GitHubAuthDeps): Promise<boolean> {
  const { env, spawnSync, logger } = deps;

  // Repos on the PVC may be owned by root (uid 0) while the agent runs as uid 1000.
  // Set safe.directory unconditionally so git can operate on them regardless of auth path.
  runOrWarn(
    spawnSync,
    "git",
    ["config", "--global", "safe.directory", "*"],
    env,
    logger,
  );

  const appId = env.GH_APP_ID;
  const installationId = env.GH_APP_INSTALLATION_ID;
  const privateKey = env.GH_APP_PRIVATE_KEY;

  if (appId && privateKey) {
    if (deps.installations) {
      const pending = await prepareInstallations(deps, deps.installations);
      if (pending) {
        const identity = await configureAppGit(deps);
        // Started only after git config succeeded, so a failed setup (retried
        // next tick) never leaves a refresh interval behind.
        pending.start();
        logAppConfigured(identity);
        return true;
      }
    }
    if (installationId) {
      await setupPinnedTokenManager(deps);
      return true;
    }
  }

  if (env.GH_TOKEN) {
    runOrWarn(spawnSync, "gh", ["auth", "setup-git"], env, logger);
    console.log(
      "[entrypoint] GitHub PAT auth configured — git credential helper installed",
    );
    return false;
  }

  console.log(
    "[entrypoint] No usable GitHub credentials — skipping GitHub setup",
  );
  return false;
}

/** Points git at the token file and sets the App bot as commit author. */
async function configureAppGit(deps: GitHubAuthDeps): Promise<AppIdentity> {
  const { env, spawnSync, tokenPath, credentialHelperPath, logger } = deps;
  env.GH_TOKEN_FILE = tokenPath;
  runOrWarn(
    spawnSync,
    "git",
    [
      "config",
      "--global",
      "credential.https://github.com.helper",
      `!${credentialHelperPath}`,
    ],
    env,
    logger,
  );
  // Makes git send the repo path to the helper so it can pick the per-owner
  // token. Host-scoped only; the helper ignores it unless gh-token.d exists.
  runOrWarn(
    spawnSync,
    "git",
    ["config", "--global", "credential.https://github.com.useHttpPath", "true"],
    env,
    logger,
  );

  const { slug, userId } = await deps.getBotIdentity();
  const botEmail = `${userId}+${slug}[bot]@users.noreply.github.com`;
  runOrWarn(
    spawnSync,
    "git",
    ["config", "--global", "user.name", `${slug}[bot]`],
    env,
    logger,
  );
  runOrWarn(
    spawnSync,
    "git",
    ["config", "--global", "user.email", botEmail],
    env,
    logger,
  );
  return { slug, userId };
}

type AppIdentity = Pick<BotIdentity, "slug" | "userId">;

function logAppConfigured({ slug, userId }: AppIdentity): void {
  console.log(
    `[entrypoint] GitHub App auth configured as ${slug}[bot] (user ${userId}), background refresh started`,
  );
}

/** Single pinned installation via its own token manager (pre-discovery path). */
async function setupPinnedTokenManager(deps: GitHubAuthDeps): Promise<void> {
  console.log(
    "[entrypoint] GitHub App credentials detected — initializing token manager",
  );
  const manager = deps.createTokenManager();
  deps.writeToken(await manager.getToken());
  const identity = await configureAppGit(deps);
  manager.startBackgroundRefresh(async (refreshedToken) => {
    deps.writeToken(refreshedToken);
  });
  logAppConfigured(identity);
}

/**
 * Discovers installations and, if the pin or at least one in-scope
 * installation is usable, writes the token files and returns a `start`
 * handle that begins the manager's single refresh timer and publishes it via
 * `onActivated`. Returns null (nothing written or started) otherwise.
 */
async function prepareInstallations(
  deps: GitHubAuthDeps,
  inst: GitHubInstallationsDeps,
): Promise<{ start: () => void } | null> {
  let active = false;
  let writing: Promise<unknown> = Promise.resolve();
  const manager = inst.createManager(() => {
    if (!active) return;
    writing = writing.then(() => writeInstallationTokens(manager, inst, deps));
  });

  await manager.reconcile(inst.getScopeOwners());
  const { installations } = manager.getState();
  if (!installations.some((i) => i.health !== "broken")) return null;

  console.log(
    `[entrypoint] GitHub App credentials detected — ${installations.length} installation(s) selected`,
  );
  if (!(await writeInstallationTokens(manager, inst, deps, true))) return null;

  return {
    start: () => {
      active = true;
      manager.start();
      inst.onActivated?.(manager);
    },
  };
}

/**
 * Writes `gh-token` (default installation) and per-owner tokens for every
 * installation that mints. Returns false if no default token could be minted.
 * Never throws unless `throwOnError` — refresh-time failures keep the last
 * good files.
 */
async function writeInstallationTokens(
  manager: InstallationsManagerLike,
  inst: GitHubInstallationsDeps,
  deps: GitHubAuthDeps,
  throwOnError = false,
): Promise<boolean> {
  try {
    const { installations, defaultId } = manager.getState();
    const ownerTokens: Record<string, string> = {};
    const tokenById = new Map<number, string>();
    for (const i of installations) {
      if (i.health === "broken") continue;
      try {
        const token = await manager.getToken(i.id);
        tokenById.set(i.id, token);
        if (i.owner) ownerTokens[i.owner] = token;
      } catch {
        // a broken/unmintable installation never blocks the others
      }
    }
    const defaultToken =
      (defaultId !== null ? tokenById.get(defaultId) : undefined) ??
      tokenById.values().next().value;
    if (defaultToken === undefined) return false;
    inst.writeTokenFiles({ defaultToken, ownerTokens });
    return true;
  } catch (err) {
    if (throwOnError) throw err;
    (deps.logger ?? console).error(
      "[github-auth] token file write failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
