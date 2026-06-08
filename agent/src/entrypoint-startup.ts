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

// Re-creates the symlink if it's missing, stale, or points at the wrong target.
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
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  }
  fs.symlinkSync(targetPath, linkPath);
}

export async function runStartup(
  agentId: string,
  deps: StartupDeps,
): Promise<void> {
  const { configClient, env, agentHome, homePath, spawnSync, writeToken, tokenPath, credentialHelperPath } = deps;

  const bundle = await configClient.getAgentConfig(agentId);

  for (const [key, value] of Object.entries(bundle.env)) {
    env[key] = value;
  }
  if (bundle.allowedTools.length > 0) {
    env.AGENT_ALLOWED_TOOLS = bundle.allowedTools.join(",");
  }

  const dotClaudeDir = path.join(agentHome, "dot-claude");
  fs.mkdirSync(dotClaudeDir, { recursive: true });
  ensureSymlink(dotClaudeDir, path.join(homePath, ".claude"));
  ensureSymlink(path.join(agentHome, "claude.json"), path.join(homePath, ".claude.json"));

  const binDir = path.resolve(import.meta.dir, "..", "scripts", "bin");
  const currentPath = env.PATH ?? "";
  if (!currentPath.startsWith(binDir)) {
    env.PATH = currentPath ? `${binDir}:${currentPath}` : binDir;
  }

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
