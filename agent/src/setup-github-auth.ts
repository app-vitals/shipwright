/**
 * agent/src/setup-github-auth.ts
 *
 * Wires GitHub authentication on agent startup.
 *
 * - GitHub App path: mints installation token, writes to token file,
 *   configures git credential helper + author identity, starts 30-min refresh.
 * - PAT path: runs `gh auth setup-git` (legacy flow preserved).
 * - Neither: skips silently.
 */

import type { BotIdentity } from "./github-app-auth.ts";

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

export async function setupGitHubAuth(deps: GitHubAuthDeps): Promise<void> {
  const {
    env,
    createTokenManager,
    getBotIdentity,
    spawnSync,
    writeToken,
    tokenPath,
    credentialHelperPath,
    logger,
  } = deps;

  const appId = env.GH_APP_ID;
  const installationId = env.GH_APP_INSTALLATION_ID;
  const privateKey = env.GH_APP_PRIVATE_KEY;

  if (appId && installationId && privateKey) {
    console.log(
      "[entrypoint] GitHub App credentials detected — initializing token manager",
    );
    const manager = createTokenManager();
    const token = await manager.getToken();
    writeToken(token);
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

    const { slug, userId } = await getBotIdentity();
    const botEmail = `${userId}+${slug}[bot]@users.noreply.github.com`;
    runOrWarn(spawnSync, "git", ["config", "--global", "user.name", `${slug}[bot]`], env, logger);
    runOrWarn(spawnSync, "git", ["config", "--global", "user.email", botEmail], env, logger);

    manager.startBackgroundRefresh(async (refreshedToken) => {
      writeToken(refreshedToken);
    });
    console.log(
      `[entrypoint] GitHub App auth configured as ${slug}[bot] (user ${userId}), background refresh started`,
    );
    return;
  }

  if (env.GH_TOKEN) {
    runOrWarn(spawnSync, "gh", ["auth", "setup-git"], env, logger);
    console.log(
      "[entrypoint] GitHub PAT auth configured — git credential helper installed",
    );
    return;
  }

  console.log(
    "[entrypoint] No GitHub credentials configured — skipping GitHub setup",
  );
}
