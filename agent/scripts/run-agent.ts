// no test: local dev launcher — spawns a subprocess

/**
 * agent/scripts/run-agent.ts
 *
 * Local development launcher for the Shipwright agent.
 * Fetches agent config, sets env vars, then spawns the agent process.
 *
 * Usage:
 *   bun run agent/scripts/run-agent.ts --agent-id <id> [--dry-run]
 *
 * Env: Bun auto-loads .env from CWD — no dotenv dep needed.
 */

import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { getArg, hasFlag } from "./cli-args.ts";
import { HttpShipwrightConfigClient } from "../src/shipwright-config-client.ts";

// ─── Args ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function requireArg(name: string): string {
  const val = getArg(name, argv);
  if (!val) {
    console.error(`Error: ${name} is required`);
    console.error("Usage: bun run agent/scripts/run-agent.ts --agent-id <id> [--dry-run]");
    process.exit(1);
  }
  return val;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Error: required environment variable ${name} is not set`);
    process.exit(1);
  }
  return val;
}

const agentId = requireArg("--agent-id");
const dryRun = hasFlag("--dry-run", argv);

const apiUrl = requireEnv("SHIPWRIGHT_API_URL");
const apiKey = requireEnv("SHIPWRIGHT_INTERNAL_API_KEY");

// ─── Fetch config ─────────────────────────────────────────────────────────────

const configClient = new HttpShipwrightConfigClient({ apiUrl, apiKey });

console.log(`[run-agent] Fetching config for agent ${agentId}...`);
const bundle = await configClient.getConfig(agentId);

// ─── Build env ────────────────────────────────────────────────────────────────

const agentHome = path.join(
  os.homedir(),
  `.shipwright-agent-${agentId.slice(-8)}`,
);

const agentEnv: Record<string, string> = {
  ...process.env as Record<string, string>,
  ...bundle.env,
  SHIPWRIGHT_AGENT_ID: agentId,
  SHIPWRIGHT_API_URL: apiUrl,
  SHIPWRIGHT_INTERNAL_API_KEY: apiKey,
  AGENT_HOME: agentHome,
};

if (bundle.allowedTools.length > 0) {
  agentEnv.AGENT_ALLOWED_TOOLS = bundle.allowedTools.join(",");
}

// ─── Launch ───────────────────────────────────────────────────────────────────

const agentIndex = path.resolve(import.meta.dir, "..", "src", "index.ts");

if (dryRun) {
  console.log("[run-agent] Dry run — would spawn:");
  console.log(`  bun run ${agentIndex}`);
  console.log("  AGENT_HOME:", agentHome);
  console.log("  Env keys from bundle:", Object.keys(bundle.env));
  process.exit(0);
}

console.log(`[run-agent] Starting agent (AGENT_HOME=${agentHome})...`);

const result = spawnSync("bun", ["run", agentIndex], {
  stdio: "inherit",
  env: agentEnv,
});

process.exit(result.status ?? 1);
