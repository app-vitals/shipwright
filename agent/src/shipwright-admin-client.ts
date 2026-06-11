/**
 * agent/src/shipwright-admin-client.ts
 * ShipwrightAdminMigrationClient — writes agent data to the shipwright admin API.
 */

import type { VitalsAgentCron } from "./accounts-migration-client.ts";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ShipwrightAdminMigrationClient {
  upsertEnvs(agentId: string, env: Record<string, string>): Promise<void>;
  listCrons(agentId: string): Promise<VitalsAgentCron[]>;
  createCron(agentId: string, cron: VitalsAgentCron): Promise<void>;
  addTool(agentId: string, pattern: string): Promise<void>;
}

// ─── HTTP implementation ──────────────────────────────────────────────────────

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class HttpShipwrightAdminClient
  implements ShipwrightAdminMigrationClient
{
  private readonly fetch: FetchFn;

  constructor(
    private readonly baseUrl: string,
    private readonly adminApiKey: string,
    fetch: FetchFn = globalThis.fetch,
  ) {
    this.fetch = fetch;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.adminApiKey}`,
      "Content-Type": "application/json",
    };
  }

  async upsertEnvs(
    agentId: string,
    env: Record<string, string>,
  ): Promise<void> {
    const url = `${this.baseUrl}/agents/${agentId}/envs`;
    const res = await this.fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(env),
    });
    if (!res.ok) {
      throw new Error(
        `upsertEnvs(${agentId}) failed: ${res.status} ${await res.text()}`,
      );
    }
  }

  async listCrons(agentId: string): Promise<VitalsAgentCron[]> {
    // GET /agents/:id/crons now uses the same admin key as other admin routes.
    // The runtime endpoint returns a flat AgentCronJob[] (not { crons: [...] }).
    const url = `${this.baseUrl}/agents/${agentId}/crons`;
    const res = await this.fetch(url, {
      headers: this.headers,
    });
    if (!res.ok) {
      throw new Error(
        `listCrons(${agentId}) failed: ${res.status} ${await res.text()}`,
      );
    }
    return (await res.json()) as VitalsAgentCron[];
  }

  async createCron(agentId: string, cron: VitalsAgentCron): Promise<void> {
    const url = `${this.baseUrl}/agents/${agentId}/crons`;
    const res = await this.fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(cron),
    });
    if (!res.ok) {
      throw new Error(
        `createCron(${agentId}) failed: ${res.status} ${await res.text()}`,
      );
    }
  }

  async addTool(agentId: string, pattern: string): Promise<void> {
    const url = `${this.baseUrl}/agents/${agentId}/tools`;
    const res = await this.fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ pattern }),
    });
    if (!res.ok) {
      throw new Error(
        `addTool(${agentId}, ${pattern}) failed: ${res.status} ${await res.text()}`,
      );
    }
  }
}
