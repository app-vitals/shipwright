/**
 * agent/scripts/cutover-validate.ts
 * CLI entrypoint — validates agent cutover readiness against the shipwright config API.
 *
 * Required env vars:
 *   SHIPWRIGHT_API_URL          — base URL of the shipwright config API
 *   SHIPWRIGHT_INTERNAL_API_KEY — bearer token for the config API
 *   SHIPWRIGHT_AGENT_ID         — the agent ID to validate
 *
 * Exits 0 when all checks pass, non-zero with per-check report on failure.
 */

import { HttpShipwrightConfigClient } from "../src/shipwright-config-client.ts";
import { validateCutover } from "../src/cutover-validate.ts";

const USAGE = `
Usage: SHIPWRIGHT_API_URL=<url> SHIPWRIGHT_INTERNAL_API_KEY=<key> SHIPWRIGHT_AGENT_ID=<id> \\
         bun run agent/scripts/cutover-validate.ts

Required environment variables:
  SHIPWRIGHT_API_URL          Base URL of the shipwright config API
  SHIPWRIGHT_INTERNAL_API_KEY Bearer token for the config API
  SHIPWRIGHT_AGENT_ID         The agent ID to validate

Checks performed:
  slack-token   SLACK_BOT_TOKEN is present in the agent config
  github-auth   At least one GitHub auth credential is present
                (GH_TOKEN, GITHUB_TOKEN, GITHUB_APP_PRIVATE_KEY, or GITHUB_APP_ID)
  crons         At least one cron job is configured for the agent

Exits 0 when all checks pass; exits 1 and reports failing checks on failure.
`.trim();

if (process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

function readEnv(name: string): string | undefined {
  return process.env[name];
}

const apiUrl = readEnv("SHIPWRIGHT_API_URL");
const apiKey = readEnv("SHIPWRIGHT_INTERNAL_API_KEY");
const agentId = readEnv("SHIPWRIGHT_AGENT_ID");

const missing = [
  !apiUrl && "SHIPWRIGHT_API_URL",
  !apiKey && "SHIPWRIGHT_INTERNAL_API_KEY",
  !agentId && "SHIPWRIGHT_AGENT_ID",
].filter(Boolean);

if (missing.length > 0) {
  console.error(`Error: missing required environment variable(s): ${missing.join(", ")}\n`);
  console.error(USAGE);
  process.exit(1);
}

if (!apiUrl || !apiKey || !agentId) process.exit(1);

const client = new HttpShipwrightConfigClient(apiUrl, apiKey);
const result = await validateCutover(client, agentId);

for (const check of result.checks) {
  const status = check.passed ? "PASS" : "FAIL";
  console.log(`  [${status}] ${check.name}: ${check.message}`);
}

if (!result.passed) {
  const failedNames = result.checks
    .filter((c) => !c.passed)
    .map((c) => c.name)
    .join(", ");
  console.error(`\nCutover validation FAILED — failing checks: ${failedNames}`);
  process.exit(1);
}

console.log("\nCutover validation PASSED — all checks OK");
