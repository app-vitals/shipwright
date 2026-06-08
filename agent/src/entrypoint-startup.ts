/**
 * agent/src/entrypoint-startup.ts
 *
 * Extracted startup logic for the agent entrypoint.
 * Pure function over injected deps — testable without real fs mutations or network.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ShipwrightConfigClient } from "./shipwright-config-client.ts";
import type { GitHubAuthDeps } from "./setup-github-auth.ts";
import { setupGitHubAuth } from "./setup-github-auth.ts";

export interface StartupDeps {
  configClient: ShipwrightConfigClient;
  env: Record<string, string | undefined>;
  agentHome: string;
  homePath: string;
  spawnSync: GitHubAuthDeps["spawnSync"];
  writeToken: (token: string) => void;
  tokenPath: string;
  credentialHelperPath: string;
  createTokenManager: GitHubAuthDeps["createTokenManager"];
  getBotIdentity: GitHubAuthDeps["getBotIdentity"];
}

/**
 * Ensures a symlink at linkPath points to targetPath.
 * Removes any existing symlink or file at linkPath before creating the new one.
 * Skips if the symlink already points to the correct target.
 */
function ensureSymlink(targetPath: string, linkPath: string): void {
  try {
    const existing = fs.readlinkSync(linkPath);
    if (existing === targetPath) return;
    fs.unlinkSync(linkPath);
  } catch (err) {
    // EINVAL = not a symlink (regular file/dir), ENOENT = doesn't exist
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EINVAL") throw err;
    if (code === "EINVAL") {
      // It's a real directory or file — remove it
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  }
  fs.symlinkSync(targetPath, linkPath);
}

/**
 * Core startup sequence — call this after validating required env vars.
 * Side-effectful operations are all injected via deps for testability.
 */
export async function runStartup(
  agentId: string,
  deps: StartupDeps,
): Promise<void> {
  const { configClient, env, agentHome, homePath, spawnSync, writeToken, tokenPath, credentialHelperPath } = deps;

  // 1. Fetch config bundle
  const bundle = await configClient.getAgentConfig(agentId);

  // 2. Apply env vars from bundle
  for (const [key, value] of Object.entries(bundle.env)) {
    env[key] = value;
  }

  // 3. Set AGENT_ALLOWED_TOOLS if non-empty
  if (bundle.allowedTools.length > 0) {
    env.AGENT_ALLOWED_TOOLS = bundle.allowedTools.join(",");
  }

  // 4. Create AGENT_HOME/dot-claude directory (PVC mount point for ~/.claude)
  const dotClaudeDir = path.join(agentHome, "dot-claude");
  fs.mkdirSync(dotClaudeDir, { recursive: true });

  // 5. Symlink ~/.claude → AGENT_HOME/dot-claude
  ensureSymlink(dotClaudeDir, path.join(homePath, ".claude"));

  // 6. Symlink ~/.claude.json → AGENT_HOME/claude.json
  ensureSymlink(
    path.join(agentHome, "claude.json"),
    path.join(homePath, ".claude.json"),
  );

  // 7. Prepend agent scripts/bin to PATH
  const binDir = path.resolve(import.meta.dir, "..", "scripts", "bin");
  const currentPath = env.PATH ?? "";
  if (!currentPath.startsWith(binDir)) {
    env.PATH = currentPath ? `${binDir}:${currentPath}` : binDir;
  }

  // 8. Wire GitHub auth (createTokenManager and getBotIdentity injected via deps
  //    so callers — including the entrypoint — can supply real or stub factories)
  await setupGitHubAuth({
    env,
    createTokenManager: deps.createTokenManager,
    getBotIdentity: deps.getBotIdentity,
    spawnSync,
    writeToken,
    tokenPath,
    credentialHelperPath,
  });
}
