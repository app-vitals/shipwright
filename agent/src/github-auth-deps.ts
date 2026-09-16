/**
 * agent/src/github-auth-deps.ts
 *
 * Builds the production GitHubAuthDeps for setupGitHubAuth() — shared by
 * entrypoint-main.ts (one-shot boot call, Step 5) and index.ts
 * (retry-on-tick via github-auth-startup.ts's startGitHubAuthIfPossible())
 * so the two separate processes wire identical spawnSync/writeToken/
 * tokenPath/credentialHelperPath behavior instead of duplicating it.
 */

import { join } from "node:path";
import { createGitHubTokenManager, getBotIdentity } from "./github-app-auth.ts";
import type { GitHubAuthDeps } from "./setup-github-auth.ts";

/**
 * @param agentHome persistent agent home dir — the token file lives at `${agentHome}/gh-token`.
 * @param scriptsBin directory containing `git-credential-shipwright.sh`.
 */
export function buildGitHubAuthDeps(
  agentHome: string,
  scriptsBin: string,
): GitHubAuthDeps {
  const tokenPath = join(agentHome, "gh-token");

  return {
    env: process.env as Record<string, string | undefined>,
    createTokenManager: createGitHubTokenManager,
    getBotIdentity,
    spawnSync: (cmd, args, opts) => {
      const proc = Bun.spawnSync([cmd, ...args], {
        stdio:
          opts.stdio === "inherit"
            ? ["inherit", "inherit", "inherit"]
            : ["pipe", "pipe", "pipe"],
        env: opts.env as Record<string, string>,
      });
      return { status: proc.exitCode };
    },
    writeToken: (token: string) => {
      Bun.write(tokenPath, token);
    },
    tokenPath,
    credentialHelperPath: join(scriptsBin, "git-credential-shipwright.sh"),
  };
}
