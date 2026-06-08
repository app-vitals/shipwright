/**
 * agent/scripts/cutover-values.ts
 * CLI entrypoint — prints a Helm values patch for the client-agent cutover.
 *
 * Required env vars:
 *   AGENT_ID              — the agent ID to patch for
 *   SHIPWRIGHT_IMAGE_TAG  — the shipwright image tag to deploy
 *   SHIPWRIGHT_API_URL    — base URL of the shipwright config API
 *
 * Usage:
 *   AGENT_ID=<id> SHIPWRIGHT_IMAGE_TAG=<tag> SHIPWRIGHT_API_URL=<url> \
 *     bun run agent/scripts/cutover-values.ts
 */

import { generateCutoverValues } from "../src/cutover-values.ts";

const USAGE = `
Usage: AGENT_ID=<id> SHIPWRIGHT_IMAGE_TAG=<tag> SHIPWRIGHT_API_URL=<url> \\
         bun run agent/scripts/cutover-values.ts

Required environment variables:
  AGENT_ID              The agent ID to generate the values patch for
  SHIPWRIGHT_IMAGE_TAG  The shipwright container image tag to deploy
  SHIPWRIGHT_API_URL    Base URL of the shipwright config API

Example output (yaml):
  agent:
    image:
      repository: ghcr.io/app-vitals/shipwright-agent
      tag: "sha-abc1234"
    env:
      SHIPWRIGHT_API_URL: "https://shipwright.example.com"
      SHIPWRIGHT_INTERNAL_API_KEY: ""  # populate from secret
      SHIPWRIGHT_AGENT_ID: "agent-xyz"
    removeEnv:
      - VITALS_OS_API_URL
      - VITALS_INTERNAL_API_KEY
      - VITALS_OS_AGENT_USER_ID
`.trim();

if (process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

function readEnv(name: string): string | undefined {
  return process.env[name];
}

const agentId = readEnv("AGENT_ID");
const imageTag = readEnv("SHIPWRIGHT_IMAGE_TAG");
const shipwrightApiUrl = readEnv("SHIPWRIGHT_API_URL");

const missing = [
  !agentId && "AGENT_ID",
  !imageTag && "SHIPWRIGHT_IMAGE_TAG",
  !shipwrightApiUrl && "SHIPWRIGHT_API_URL",
].filter(Boolean);

if (missing.length > 0) {
  console.error(`Error: missing required environment variable(s): ${missing.join(", ")}\n`);
  console.error(USAGE);
  process.exit(1);
}

if (!agentId || !imageTag || !shipwrightApiUrl) process.exit(1);

const yaml = generateCutoverValues(agentId, imageTag, shipwrightApiUrl);
process.stdout.write(yaml);
