/**
 * agent/src/cutover-validate.ts
 * Validates that a shipwright agent is ready for cutover by checking the
 * runtime API for required credentials and crons.
 *
 * Checks:
 *  - SLACK_BOT_TOKEN present in env bundle
 *  - GitHub auth credentials present (App: GH_APP_ID + GH_APP_PRIVATE_KEY +
 *    GH_APP_INSTALLATION_ID; or PAT: GH_TOKEN)
 *  - At least one cron job configured
 */

import type { AgentCronJob } from "./agent-cron-jobs.ts";
import type { AgentConfigResponse } from "./api.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ShipwrightConfigClient {
  getConfig(agentId: string): Promise<AgentConfigResponse>;
  getCrons(agentId: string): Promise<AgentCronJob[]>;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
}

// ─── HTTP implementation ──────────────────────────────────────────────────────

export class HttpShipwrightConfigClient implements ShipwrightConfigClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  async getConfig(agentId: string): Promise<AgentConfigResponse> {
    const res = await globalThis.fetch(
      `${this.baseUrl}/agents/${agentId}/config`,
      { headers: this.headers },
    );
    if (!res.ok) {
      throw new Error(
        `getConfig(${agentId}) failed: ${res.status} ${await res.text()}`,
      );
    }
    return res.json() as Promise<AgentConfigResponse>;
  }

  async getCrons(agentId: string): Promise<AgentCronJob[]> {
    const res = await globalThis.fetch(
      `${this.baseUrl}/agents/${agentId}/crons`,
      { headers: this.headers },
    );
    if (!res.ok) {
      throw new Error(
        `getCrons(${agentId}) failed: ${res.status} ${await res.text()}`,
      );
    }
    return res.json() as Promise<AgentCronJob[]>;
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

function hasGitHubAuth(env: Record<string, string>): boolean {
  const hasAppCreds =
    Boolean(env.GH_APP_ID) &&
    Boolean(env.GH_APP_PRIVATE_KEY) &&
    Boolean(env.GH_APP_INSTALLATION_ID);
  const hasPat = Boolean(env.GH_TOKEN);
  return hasAppCreds || hasPat;
}

export async function validateCutover(
  client: ShipwrightConfigClient,
  agentId: string,
): Promise<CheckResult[]> {
  const [config, crons] = await Promise.all([
    client.getConfig(agentId),
    client.getCrons(agentId),
  ]);

  const { env } = config;

  const hasSlack = Boolean(env.SLACK_BOT_TOKEN);
  const hasGithub = hasGitHubAuth(env);
  const enabledCrons = crons.filter((c) => c.enabled);
  const hasCrons = enabledCrons.length > 0;

  return [
    {
      name: "SLACK_BOT_TOKEN",
      passed: hasSlack,
      message: hasSlack
        ? "SLACK_BOT_TOKEN is present"
        : "SLACK_BOT_TOKEN is missing from env bundle",
    },
    {
      name: "github_auth",
      passed: hasGithub,
      message: hasGithub
        ? "GitHub auth credentials are present"
        : "GitHub auth credentials missing — need GH_TOKEN or GH_APP_ID + GH_APP_PRIVATE_KEY + GH_APP_INSTALLATION_ID",
    },
    {
      name: "crons",
      passed: hasCrons,
      message: hasCrons
        ? `${enabledCrons.length} enabled cron job(s) configured`
        : "No enabled cron jobs configured — at least one is required",
    },
  ];
}
