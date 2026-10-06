/**
 * agent/src/github-auth-deps.ts
 *
 * Builds the production GitHubAuthDeps for setupGitHubAuth() — shared by
 * entrypoint-main.ts (one-shot boot call, Step 5) and index.ts
 * (retry-on-tick via github-auth-startup.ts's startGitHubAuthIfPossible())
 * so the two separate processes wire identical spawnSync/writeToken/
 * tokenPath/credentialHelperPath behavior instead of duplicating it.
 *
 * Only index.ts enables installation discovery (`withInstallations`): it owns
 * repo scope (agentReposRef) and the per-owner `gh-token.d/` files. The
 * entrypoint process keeps the single pinned-installation path, whose
 * refresh rewrites `gh-token` only so it never clobbers index.ts's per-owner
 * files.
 */

import { join } from "node:path";
import { createAppAuth } from "@octokit/auth-app";
import { agentReposRef } from "./agent-repos-ref.ts";
import { writeFileAtomic, writeTokenFiles } from "./gh-token-files.ts";
import {
  createGitHubTokenManager,
  type GitHubTokenManager,
  getBotIdentity,
} from "./github-app-auth.ts";
import {
  githubInstallationsManagerRef,
  scopeOwnersOf,
} from "./github-auth-startup.ts";
import { GitHubInstallationsManager } from "./github-installations.ts";
import {
  type GitHubInstallationsReporter,
  NoopGitHubInstallationsReporter,
  startInstallationsHeartbeat,
} from "./github-installations-reporter.ts";
import type {
  GitHubAuthDeps,
  GitHubInstallationsDeps,
} from "./setup-github-auth.ts";

type InstallationAuthFn = ConstructorParameters<
  typeof GitHubTokenManager
>[0]["auth"];

/** Production installations manager built from live GH_APP_* env vars. */
function createInstallationsManager(
  onTokensChanged: () => void,
  reporter: GitHubInstallationsReporter,
): GitHubInstallationsManager {
  const env = process.env;
  const appAuth = createAppAuth({
    appId: env.GH_APP_ID ?? "",
    privateKey: (env.GH_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  });
  const auth: InstallationAuthFn = async (params) =>
    appAuth(
      params as Parameters<typeof appAuth>[0],
    ) as ReturnType<InstallationAuthFn>;
  const pin = Number(env.GH_APP_INSTALLATION_ID);
  const manager: GitHubInstallationsManager = new GitHubInstallationsManager({
    auth,
    pinnedId: Number.isInteger(pin) && pin > 0 ? pin : null,
    onEvent: (event) => {
      if (event.type === "minted") onTokensChanged();
    },
    onChange: (state) => {
      onTokensChanged();
      void reporter.report(state);
    },
  });
  startInstallationsHeartbeat(reporter, () => manager.getState());
  return manager;
}

/**
 * @param agentHome persistent agent home dir — the token file lives at `${agentHome}/gh-token`.
 * @param scriptsBin directory containing `git-credential-shipwright.sh`.
 * @param opts.withInstallations enable installation discovery (index.ts only).
 */
export function buildGitHubAuthDeps(
  agentHome: string,
  scriptsBin: string,
  opts: {
    withInstallations?: boolean;
    installationsReporter?: GitHubInstallationsReporter;
  } = {},
): GitHubAuthDeps {
  const tokenPath = join(agentHome, "gh-token");

  const installations: GitHubInstallationsDeps | undefined =
    opts.withInstallations
      ? {
          createManager: (onTokensChanged) =>
            createInstallationsManager(
              onTokensChanged,
              opts.installationsReporter ??
                new NoopGitHubInstallationsReporter(),
            ),
          getScopeOwners: () => scopeOwnersOf(agentReposRef),
          writeTokenFiles: (input) => writeTokenFiles(agentHome, input),
          onActivated: (manager) => githubInstallationsManagerRef.set(manager),
        }
      : undefined;

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
    // Single-installation path: `gh-token` only — `gh-token.d/` belongs to
    // the installations manager (see module docstring).
    writeToken: (token: string) => {
      writeFileAtomic(tokenPath, token);
    },
    tokenPath,
    credentialHelperPath: join(scriptsBin, "git-credential-shipwright.sh"),
    installations,
  };
}
