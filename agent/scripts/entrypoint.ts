// no test: pure-side-effects entrypoint

/**
 * agent/scripts/entrypoint.ts
 *
 * Container entrypoint for the Shipwright agent.
 *
 * 1. Validates required env vars (dies clearly if missing)
 * 2. Fetches agent config from SHIPWRIGHT_API_URL
 * 3. Applies env vars from the config bundle
 * 4. Symlinks ~/.claude → AGENT_HOME/dot-claude (PVC mount point)
 * 5. Symlinks ~/.claude.json → AGENT_HOME/claude.json
 * 6. Prepends agent/scripts/bin to PATH
 * 7. Wires GitHub auth
 * 8. Dynamic-imports agent/src/index.ts to start the agent
 */

import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { HttpShipwrightConfigClient } from "../src/shipwright-config-client.ts";
import { runStartup } from "../src/entrypoint-startup.ts";
import { createGitHubTokenManager, getBotIdentity } from "../src/github-app-auth.ts";
import { resolveTokenPath, writeToken } from "../src/github-token-store.ts";

// ─── Require env ──────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`[entrypoint] Error: required environment variable ${name} is not set`);
    process.exit(1);
  }
  return val;
}

const apiUrl = requireEnv("SHIPWRIGHT_API_URL");
const apiKey = requireEnv("SHIPWRIGHT_INTERNAL_API_KEY");
const agentId = requireEnv("SHIPWRIGHT_AGENT_ID");

const agentHome = process.env.AGENT_HOME ?? "/data/agent-home";
const homePath = os.homedir();

// ─── Run startup ──────────────────────────────────────────────────────────────

const configClient = new HttpShipwrightConfigClient(apiUrl, apiKey);
const tokenPath = resolveTokenPath(process.env);
const credentialHelperPath = path.resolve(import.meta.dir, "bin/git-credential-shipwright.sh");

await runStartup(agentId, {
  configClient,
  env: process.env as Record<string, string | undefined>,
  agentHome,
  homePath,
  spawnSync: (cmd, args, opts) => {
    const result = spawnSync(cmd, args, opts);
    return { status: result.status };
  },
  writeToken: (token) => writeToken(token, tokenPath),
  tokenPath,
  credentialHelperPath,
  createTokenManager: createGitHubTokenManager,
  getBotIdentity,
});

// ─── Start agent ──────────────────────────────────────────────────────────────

// Dynamic import so all env mutations above are visible before index.ts loads.
await import("../src/index.ts");
