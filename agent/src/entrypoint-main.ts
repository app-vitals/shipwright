/**
 * agent/src/entrypoint-main.ts
 *
 * Production CLI entry point — invoked by the Dockerfile ENTRYPOINT.
 *
 * Wires all real dependencies and calls runEntrypoint().
 * Run via: bun run agent/src/entrypoint-main.ts [--agent-id X] [--api-url Y] [--api-key Z]
 *
 * The health server is started in-process on SHIPWRIGHT_HEALTH_PORT (default 3459)
 * BEFORE the startup sequence so K8s liveness probes are reachable during init.
 * The agent server (index.ts) runs as a subprocess — spawnAgentServer.
 */

import { join } from "node:path";
import { parseCliArgs } from "./cli-args.ts";
import { runEntrypoint } from "./entrypoint.ts";
import { createGitHubTokenManager, getBotIdentity } from "./github-app-auth.ts";
import { DEFAULT_HEALTH_PORT, startHealthServer } from "./health.ts";
import { setupGitHubAuth } from "./setup-github-auth.ts";
import {
  ensureDotClaudeSymlink,
  installPlugins,
  runMiseStartup,
} from "./setup.ts";
import { HttpShipwrightRuntimeClient } from "./shipwright-runtime-client.ts";

// ─── Health server (in-process, before startup sequence) ─────────────────────
// Start the health server immediately so liveness probes are reachable during
// the full startup sequence (config fetch, mise, plugin install, etc.).
const healthPort = Number(
  process.env.SHIPWRIGHT_HEALTH_PORT ?? DEFAULT_HEALTH_PORT,
);
console.log(`[entrypoint-main] starting health server on port ${healthPort}`);
startHealthServer(healthPort);

const { agentId, apiUrl, apiKey } = parseCliArgs(
  process.argv.slice(2),
  process.env as Record<string, string | undefined>,
);

const agentHome =
  process.env.AGENT_HOME ??
  join(process.env.HOME ?? "/root", ".shipwright-agent");

const runtimeClient = new HttpShipwrightRuntimeClient({
  apiUrl: apiUrl ?? "",
  apiKey: apiKey ?? "",
});
const configClient = {
  getConfig: (id: string) => runtimeClient.getAgentConfigBundle(id),
};

const SCRIPTS_BIN = join(import.meta.dir, "..", "scripts", "bin");
const TOKEN_PATH = join(agentHome, "gh-token");

const spawnSyncFn: Parameters<typeof setupGitHubAuth>[0]["spawnSync"] = (
  cmd,
  args,
  opts,
) => {
  const proc = Bun.spawnSync([cmd, ...args], {
    stdio:
      opts.stdio === "inherit"
        ? ["inherit", "inherit", "inherit"]
        : ["pipe", "pipe", "pipe"],
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
  symlinkDotClaude: ensureDotClaudeSymlink,
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
  startupTimeoutMs: (() => {
    const ms = Number(process.env.SHIPWRIGHT_STARTUP_TIMEOUT_MS);
    return Number.isFinite(ms) ? ms : undefined;
  })(),
});
