/**
 * agent/src/cutover-validate.ts
 * Validation logic for agent cutover readiness checks.
 */

import type { ShipwrightConfigClient } from "./shipwright-config-client.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
}

export interface ValidationResult {
  passed: boolean;
  checks: CheckResult[];
}

// ─── GitHub credential keys accepted as proof of auth ─────────────────────────

const GITHUB_CRED_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_ID",
] as const;

// ─── Core validation function ─────────────────────────────────────────────────

export async function validateCutover(
  client: ShipwrightConfigClient,
  agentId: string,
): Promise<ValidationResult> {
  const [config, crons] = await Promise.all([
    client.getConfig(agentId),
    client.getCrons(agentId),
  ]);

  const hasGithubAuth = GITHUB_CRED_KEYS.some((key) => Boolean(config.env[key]));

  const checks: CheckResult[] = [
    {
      name: "slack-token",
      passed: Boolean(config.env.SLACK_BOT_TOKEN),
      message: config.env.SLACK_BOT_TOKEN
        ? "SLACK_BOT_TOKEN is present"
        : "SLACK_BOT_TOKEN is missing from config env",
    },
    {
      name: "github-auth",
      passed: hasGithubAuth,
      message: hasGithubAuth
        ? "GitHub auth credential found"
        : `No GitHub auth credential found (checked: ${GITHUB_CRED_KEYS.join(", ")})`,
    },
    {
      name: "crons",
      passed: crons.length > 0,
      message: crons.length > 0
        ? `${crons.length} cron(s) present`
        : "No crons configured for this agent",
    },
  ];

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}
