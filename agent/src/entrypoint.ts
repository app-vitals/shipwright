/**
 * agent/src/entrypoint.ts
 *
 * Container startup sequence for the Shipwright agent.
 *
 * Sequence:
 *   1. Validate required env vars (fail fast with clear log on missing)
 *   2. Fetch agent config from GET /agents/:id/config
 *   3. Apply env vars from config bundle to process.env
 *   4. Symlink ~/.claude → $AGENT_HOME/dot-claude
 *   5. Setup GitHub auth
 *   6. Run mise startup (install tools, prepend shims to PATH)
 *   7. Install plugins from config
 *   8. Spawn the agent server process
 *
 * Dependency-injected for testability — pass real deps in production,
 * doubles in tests.
 */

import { join } from "node:path";
import type { AgentPlugin } from "./api.ts";
import type { ShipwrightConfigClient } from "./shipwright-config-client.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<{ stdout: string; exitCode: number }>;

export interface EntrypointDeps {
  agentId: string | undefined;
  apiUrl: string | undefined;
  apiKey: string | undefined;
  agentHome: string;
  configClient: ShipwrightConfigClient;
  applyEnv: (env: Record<string, string>) => void;
  symlinkDotClaude: (target: string, linkPath: string) => void;
  setupGitHubAuth: () => Promise<void>;
  runMiseStartup: (home: string, execFn?: ExecFn) => Promise<void>;
  installPlugins: (
    execFn?: ExecFn,
    cwd?: string,
    plugins?: AgentPlugin[],
  ) => Promise<void>;
  spawnAgentServer: (cmd: string, args: string[]) => void;
  exit: (code: number) => void;
}

// ─── Main entrypoint ──────────────────────────────────────────────────────────

export async function runEntrypoint(deps: EntrypointDeps): Promise<void> {
  const {
    agentId,
    apiUrl,
    apiKey,
    agentHome,
    configClient,
    applyEnv,
    symlinkDotClaude,
    setupGitHubAuth,
    runMiseStartup,
    installPlugins,
    spawnAgentServer,
    exit,
  } = deps;

  // ─── Step 1: Validate required vars ─────────────────────────────────────────

  const missing: string[] = [];
  if (!agentId) missing.push("SHIPWRIGHT_AGENT_ID (or --agent-id)");
  if (!apiUrl) missing.push("SHIPWRIGHT_API_URL (or --api-url)");
  if (!apiKey) missing.push("SHIPWRIGHT_INTERNAL_API_KEY (or --api-key)");

  if (missing.length > 0) {
    for (const m of missing) {
      console.error(`[entrypoint] FATAL: missing required variable: ${m}`);
    }
    exit(1);
    return;
  }

  // ─── Step 2: Fetch config from Shipwright API ────────────────────────────────

  let config: Awaited<ReturnType<ShipwrightConfigClient["getConfig"]>>;
  try {
    config = await configClient.getConfig(agentId as string);
    console.log(
      `[entrypoint] fetched config for agent ${agentId}: ${Object.keys(config.env).length} env vars, ${config.plugins.length} plugins`,
    );
  } catch (err) {
    console.error(`[entrypoint] FATAL: failed to fetch agent config: ${(err as Error).message}`);
    exit(1);
    return;
  }

  // ─── Step 3: Apply env vars ──────────────────────────────────────────────────

  applyEnv(config.env);

  // ─── Step 4: Symlink ~/.claude → $AGENT_HOME/dot-claude ─────────────────────

  const dotClaudeTarget = join(agentHome, "dot-claude");
  const dotClaudeLinkPath = join(
    process.env.HOME ?? "/root",
    ".claude",
  );
  symlinkDotClaude(dotClaudeTarget, dotClaudeLinkPath);

  // ─── Step 5: GitHub auth ─────────────────────────────────────────────────────

  await setupGitHubAuth();

  // ─── Step 6: Mise startup ────────────────────────────────────────────────────

  await runMiseStartup(agentHome);

  // ─── Step 7: Install plugins ─────────────────────────────────────────────────

  await installPlugins(undefined, undefined, config.plugins);

  // ─── Step 8: Spawn agent server ──────────────────────────────────────────────

  spawnAgentServer("bun", ["run", join(import.meta.dir, "run-agent.ts")]);
}
