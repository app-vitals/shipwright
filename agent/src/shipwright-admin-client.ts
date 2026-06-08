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

export class HttpShipwrightAdminClient implements ShipwrightAdminMigrationClient {
  constructor(
    private readonly baseUrl: string,
    private readonly sessionToken: string,
  ) {}

  private get headers(): Record<string, string> {
    return {
      Cookie: `admin_session=${this.sessionToken}`,
      "Content-Type": "application/json",
    };
  }

  async upsertEnvs(
    agentId: string,
    env: Record<string, string>,
  ): Promise<void> {
    const url = `${this.baseUrl}/admin/api/agents/${agentId}/envs`;
    const res = await globalThis.fetch(url, {
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
    const url = `${this.baseUrl}/admin/api/agents/${agentId}/crons`;
    const res = await globalThis.fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(
        `listCrons(${agentId}) failed: ${res.status} ${await res.text()}`,
      );
    }
    const data = await res.json() as { crons: VitalsAgentCron[] };
    return data.crons;
  }

  async createCron(agentId: string, cron: VitalsAgentCron): Promise<void> {
    const url = `${this.baseUrl}/admin/api/agents/${agentId}/crons`;
    const res = await globalThis.fetch(url, {
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
    const url = `${this.baseUrl}/admin/api/agents/${agentId}/tools`;
    const res = await globalThis.fetch(url, {
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
