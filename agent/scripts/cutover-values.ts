/**
 * agent/scripts/cutover-values.ts
 * CLI entry point for generating a Helm values patch for client-agent cutover.
 *
 * Required env vars:
 *   AGENT_ID   — the shipwright agent ID to include in the patch
 *
 * Required argument:
 *   <image-tag> — the shipwright container image tag (e.g. v1.2.3)
 *
 * Usage:
 *   AGENT_ID=<id> bun agent/scripts/cutover-values.ts <image-tag>
 *
 * Output:
 *   Helm values YAML patch printed to stdout. Apply with:
 *     helm upgrade <release> <chart> -f <(bun cutover-values.ts v1.2.3)
 */

import { generateCutoverValues } from "../src/cutover-values.ts";

const USAGE = `Usage: AGENT_ID=<id> bun cutover-values.ts <image-tag>

Required env vars:
  AGENT_ID              — the shipwright agent ID to embed in the patch

Required argument:
  <image-tag>           — the shipwright container image tag (e.g. v1.2.3)

Example output:
  image:
    tag: "v1.2.3"
  env:
    add:
      SHIPWRIGHT_API_URL: ""
      SHIPWRIGHT_INTERNAL_API_KEY: ""
      SHIPWRIGHT_AGENT_ID: "agent-abc123"
    remove:
      - VITALS_OS_API_URL
      - VITALS_INTERNAL_API_KEY
      - VITALS_OS_AGENT_USER_ID`;

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

const agentId = requireEnv("AGENT_ID");

const imageTag = process.argv[2];
if (!imageTag) {
  console.error("Error: missing required argument <image-tag>\n");
  console.error(USAGE);
  process.exit(1);
}

process.stdout.write(generateCutoverValues(agentId, imageTag));
