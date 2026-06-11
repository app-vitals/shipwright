/**
 * agent/scripts/cutover-validate.ts
 * CLI entry point for validating a shipwright agent is ready for cutover.
 *
 * Calls GET /agents/{id}/config and GET /agents/{id}/crons on the shipwright
 * config service; asserts SLACK_BOT_TOKEN, GitHub auth credentials, and at
 * least one cron are present. Exits 0 on pass, non-zero with per-check report
 * on failure.
 *
 * Required env vars:
 *   SHIPWRIGHT_API_URL      — base URL of the shipwright agent API
 *   SHIPWRIGHT_AGENT_API_KEY — bearer token for the agent API
 *   AGENT_ID                — the agent ID to validate
 *
 * Usage:
 *   SHIPWRIGHT_API_URL=<url> SHIPWRIGHT_AGENT_API_KEY=<key> AGENT_ID=<id> \
 *     bun agent/scripts/cutover-validate.ts
 */

import { type CheckResult, validateCutover } from "../src/cutover-validate.ts";
import { HttpShipwrightRuntimeClient } from "../src/shipwright-runtime-client.ts";

const USAGE = `Usage: SHIPWRIGHT_API_URL=<url> SHIPWRIGHT_AGENT_API_KEY=<key> AGENT_ID=<id> bun cutover-validate.ts

Required env vars:
  SHIPWRIGHT_API_URL      — base URL of the shipwright agent API (e.g. https://shipwright.example.com)
  SHIPWRIGHT_AGENT_API_KEY — bearer token for the agent API
  AGENT_ID                — the agent ID to validate

Checks performed:
  SLACK_BOT_TOKEN   — present in the agent's env bundle
  github_auth       — GH_TOKEN or (GH_APP_ID + GH_APP_PRIVATE_KEY + GH_APP_INSTALLATION_ID)
  crons             — at least one cron job configured

Exit codes:
  0 — all checks passed
  1 — one or more checks failed (per-check report printed to stdout)`;

if (process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Error: required environment variable ${name} is not set\n`);
    console.error(USAGE);
    process.exit(1);
  }
  return val;
}

const apiUrl = requireEnv("SHIPWRIGHT_API_URL");
const apiKey = requireEnv("SHIPWRIGHT_AGENT_API_KEY");
const agentId = requireEnv("AGENT_ID");

const runtimeClient = new HttpShipwrightRuntimeClient({ apiUrl, apiKey });
const client = {
  getConfig: (id: string) => runtimeClient.getAgentConfigBundle(id),
  getCrons: (id: string) => runtimeClient.listAgentCronJobs(id),
};

let results: CheckResult[];
try {
  results = await validateCutover(client, agentId);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: failed to fetch agent config — ${msg}`);
  process.exit(1);
}

let allPassed = true;
for (const result of results) {
  const status = result.passed ? "✓" : "✗";
  console.log(`${status} ${result.name}: ${result.message}`);
  if (!result.passed) allPassed = false;
}

if (!allPassed) {
  console.error(
    "\nValidation failed. Fix the issues above before cutting over.",
  );
  process.exit(1);
}

console.log("\nAll checks passed. Agent is ready for cutover.");
