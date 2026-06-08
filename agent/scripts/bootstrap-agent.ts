// no test: heavy I/O — Slack Manifest API, OAuth, admin API

/**
 * agent/scripts/bootstrap-agent.ts
 *
 * One-time setup script for a Shipwright agent.
 * Creates a Slack app via the Manifest API, completes OAuth, collects credentials,
 * and stores them via the admin API.
 *
 * The agent record must already exist in the DB (created via admin UI or DB seed).
 * This script only wires the credentials.
 *
 * Usage:
 *   bun run agent/scripts/bootstrap-agent.ts --agent-id <id> [--env-file <path>]
 *
 * Required env (or in --env-file):
 *   SHIPWRIGHT_ADMIN_URL      — base URL of the Shipwright admin API
 *   SHIPWRIGHT_SESSION_TOKEN  — admin_session JWT cookie value
 */

import * as fs from "node:fs";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { getArg } from "./cli-args.ts";

// ─── Args ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function requireArg(name: string): string {
  const val = getArg(name, argv);
  if (!val) {
    console.error(`Error: ${name} is required`);
    console.error(
      "Usage: bun run agent/scripts/bootstrap-agent.ts --agent-id <id> [--env-file <path>]",
    );
    process.exit(1);
  }
  return val;
}

const agentId = requireArg("--agent-id");
const envFile = getArg("--env-file", argv);

// ─── Env loading ──────────────────────────────────────────────────────────────

if (envFile) {
  if (!fs.existsSync(envFile)) {
    console.error(`Error: env file not found: ${envFile}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(envFile, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    process.env[key] = value;
  }
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Error: required environment variable ${name} is not set`);
    process.exit(1);
  }
  return val;
}

const adminUrl = requireEnv("SHIPWRIGHT_ADMIN_URL").replace(/\/$/, "");
const sessionToken = requireEnv("SHIPWRIGHT_SESSION_TOKEN");

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function adminPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${adminUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `admin_session=${sessionToken}`,
    },
    body: JSON.stringify(body),
  });
}

async function adminPatch(path: string, body: unknown): Promise<Response> {
  return fetch(`${adminUrl}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: `admin_session=${sessionToken}`,
    },
    body: JSON.stringify(body),
  });
}

// ─── Slack app creation ───────────────────────────────────────────────────────

console.log(`[bootstrap] Bootstrapping agent ${agentId}`);

const rl = readline.createInterface({ input: stdin, output: stdout });

async function prompt(question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

// Create Slack app via manifest API
console.log("\n[bootstrap] Step 1: Create Slack app");
console.log(
  "  Visit https://api.slack.com/apps?new_app=1 and choose 'From an app manifest'.",
);
console.log("  Use the manifest from the Shipwright admin UI for this agent.");

const slackBotToken = await prompt("  Paste the Bot OAuth token (xoxb-...): ");
const slackAppToken = await prompt("  Paste the App-level token (xapp-...): ");
const slackTeamId = await prompt("  Paste the Slack workspace ID (T...): ");

if (!slackBotToken.startsWith("xoxb-")) {
  console.error("Error: Bot token must start with xoxb-");
  rl.close();
  process.exit(1);
}
if (!slackAppToken.startsWith("xapp-")) {
  console.error("Error: App-level token must start with xapp-");
  rl.close();
  process.exit(1);
}

// ─── Collect remaining credentials ───────────────────────────────────────────

console.log("\n[bootstrap] Step 2: Collect remaining credentials");
const anthropicApiKey = await prompt("  Anthropic API key (sk-ant-...): ");

rl.close();

// ─── Store credentials via admin API ─────────────────────────────────────────

console.log("\n[bootstrap] Storing credentials...");

const envPayload: Record<string, string> = {
  SLACK_BOT_TOKEN: slackBotToken,
  SLACK_APP_TOKEN: slackAppToken,
  SLACK_TEAM_ID: slackTeamId,
  ANTHROPIC_API_KEY: anthropicApiKey,
};

const response = await adminPatch(`/admin/api/agents/${agentId}/envs`, envPayload);

if (!response.ok) {
  const body = await response.text();
  console.error(
    `[bootstrap] Error storing credentials: ${response.status} ${response.statusText}`,
  );
  console.error(body);
  process.exit(1);
}

console.log(
  `[bootstrap] Agent ${agentId} bootstrapped successfully.`,
);
console.log(
  `  Start the agent with: SHIPWRIGHT_AGENT_ID=${agentId} bun run agent/scripts/entrypoint.ts`,
);
