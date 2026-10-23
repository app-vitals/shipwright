/**
 * agent/src/entrypoint-main.ts
 *
 * Production CLI entry point — invoked by the Dockerfile ENTRYPOINT.
 *
 * Wires all real dependencies and calls runEntrypoint().
 * Run via: bun run agent/src/entrypoint-main.ts [--agent-id X] [--api-url Y] [--api-key Z]
 *
 * The agent server (index.ts) runs as a subprocess (spawnAgentServer) and owns
 * the single health server. Do NOT start a health server here too — index.ts
 * binds the same port, so a second listener would fail with EADDRINUSE and crash
 * the agent on startup.
 */

import { join } from "node:path";
import { applyEnvToProcess } from "@app-vitals/agent-runtime/anthropic-federation-guard";
import { parseCliArgs } from "@app-vitals/agent-runtime/cli-args";
import { runEntrypoint } from "@app-vitals/agent-runtime/entrypoint";
import { buildGitHubAuthDeps } from "@app-vitals/agent-runtime/github-auth-deps";
import {
  ensureDotClaudeSymlink,
  installPlugins,
  runMiseStartup,
} from "@app-vitals/agent-runtime/setup";
import { setupGitHubAuth } from "@app-vitals/agent-runtime/setup-github-auth";
import { HttpShipwrightRuntimeClient } from "@app-vitals/agent-runtime/shipwright-runtime-client";

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

await runEntrypoint({
  agentId,
  apiUrl,
  apiKey,
  agentHome,
  configClient,
  // WIF-2.1: skips the Anthropic credential keys when federation is active.
  applyEnv: (env: Record<string, string>) => applyEnvToProcess(env),
  symlinkDotClaude: ensureDotClaudeSymlink,
  setupGitHubAuth: async () => {
    await setupGitHubAuth(buildGitHubAuthDeps(agentHome, SCRIPTS_BIN));
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
