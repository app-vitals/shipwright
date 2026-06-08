/**
 * agent/src/entrypoint-main.ts
 *
 * Production CLI entry point — invoked by the Dockerfile ENTRYPOINT.
 *
 * Wires all real dependencies and calls runEntrypoint().
 * Run via: bun run agent/src/entrypoint-main.ts [--agent-id X] [--api-url Y] [--api-key Z]
 */

import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseCliArgs } from "./cli-args.ts";
import { runEntrypoint } from "./entrypoint.ts";
import {
  createGitHubTokenManager,
  getBotIdentity,
} from "./github-app-auth.ts";
import { installPlugins, runMiseStartup } from "./setup.ts";
import { setupGitHubAuth } from "./setup-github-auth.ts";
import { HttpShipwrightConfigClient } from "./shipwright-config-client.ts";

const { agentId, apiUrl, apiKey } = parseCliArgs(
  process.argv.slice(2),
  process.env as Record<string, string | undefined>,
);

const agentHome =
  process.env.AGENT_HOME ?? join(process.env.HOME ?? "/root", ".shipwright-agent");

const configClient = apiUrl && apiKey
  ? new HttpShipwrightConfigClient({ apiUrl, apiKey })
  : new HttpShipwrightConfigClient({
      apiUrl: apiUrl ?? "",
      apiKey: apiKey ?? "",
    });

const SCRIPTS_BIN = join(import.meta.dir, "..", "scripts", "bin");
const TOKEN_PATH = join(agentHome, "gh-token");

const spawnSyncFn: Parameters<typeof setupGitHubAuth>[0]["spawnSync"] = (
  cmd,
  args,
  opts,
) => {
  const proc = Bun.spawnSync([cmd, ...args], {
    stdio: opts.stdio === "inherit" ? ["inherit", "inherit", "inherit"] : ["pipe", "pipe", "pipe"],
    env: opts.env as Record<string, string>,
  });
  return { status: proc.exitCode };
};

await runEntrypoint({
  agentId,
  apiUrl,
  apiKey,
  agentHome,
  configClient,
  applyEnv: (env: Record<string, string>) => {
    for (const [k, v] of Object.entries(env)) {
      process.env[k] = v;
    }
  },
  symlinkDotClaude: (target: string, linkPath: string) => {
    if (existsSync(linkPath)) {
      // Remove stale symlink or directory before relinking
      unlinkSync(linkPath);
    }
    symlinkSync(target, linkPath);
    console.log(`[entrypoint] symlinked ${linkPath} → ${target}`);
  },
  setupGitHubAuth: async () => {
    await setupGitHubAuth({
      env: process.env as Record<string, string | undefined>,
      createTokenManager: createGitHubTokenManager,
      getBotIdentity,
      spawnSync: spawnSyncFn,
      writeToken: (token: string) => {
        Bun.write(TOKEN_PATH, token);
      },
      tokenPath: TOKEN_PATH,
      credentialHelperPath: join(SCRIPTS_BIN, "git-credential-shipwright.sh"),
    });
  },
  runMiseStartup,
  installPlugins,
  spawnAgentServer: (cmd: string, args: string[]) => {
    // Detach — let the agent server run as the main process
    const proc = Bun.spawn([cmd, ...args], {
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env as Record<string, string>,
    });
    // Transfer control — wait for the server process to exit
    proc.exited.then((code) => {
      process.exit(code ?? 0);
    });
  },
  exit: (code: number) => {
    process.exit(code);
  },
});
