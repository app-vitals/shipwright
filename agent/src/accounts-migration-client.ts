/**
 * agent/src/accounts-migration-client.ts
 * AccountsMigrationClient — reads agent data from the vitals-os accounts API.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VitalsAgentRecord {
  id: string;
  name: string;
}

export interface VitalsAgentConfig {
  env: Record<string, string>;
  tools: string[];
}

export interface VitalsAgentCron {
  schedule: string;
  prompt: string;
  channel: string | null;
  user: string | null;
  silent: boolean;
  enabled: boolean;
  preCheck: string | null;
  name: string | null;
}

export interface AccountsMigrationClient {
  listAgents(): Promise<VitalsAgentRecord[]>;
  getAgentConfig(agentId: string): Promise<VitalsAgentConfig>;
  getAgentCrons(agentId: string): Promise<VitalsAgentCron[]>;
}

// ─── HTTP implementation ──────────────────────────────────────────────────────

export class HttpAccountsMigrationClient implements AccountsMigrationClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async listAgents(): Promise<VitalsAgentRecord[]> {
    const url = `${this.baseUrl}/accounts/agents?role=AGENT`;
    const res = await globalThis.fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(
        `listAgents failed: ${res.status} ${await res.text()}`,
      );
    }
    const data = await res.json() as { agents?: VitalsAgentRecord[] } | VitalsAgentRecord[];
    // Handle both array response and wrapped { agents: [] } response
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object" && "agents" in data && Array.isArray(data.agents)) {
      return data.agents;
    }
    return data as VitalsAgentRecord[];
  }

  async getAgentConfig(agentId: string): Promise<VitalsAgentConfig> {
    const url = `${this.baseUrl}/accounts/agents/${agentId}/config`;
    const res = await globalThis.fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(
        `getAgentConfig(${agentId}) failed: ${res.status} ${await res.text()}`,
      );
    }
    return res.json() as Promise<VitalsAgentConfig>;
  }

  async getAgentCrons(agentId: string): Promise<VitalsAgentCron[]> {
    const url = `${this.baseUrl}/accounts/agents/${agentId}/crons`;
    const res = await globalThis.fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(
        `getAgentCrons(${agentId}) failed: ${res.status} ${await res.text()}`,
      );
    }
    const data = await res.json() as { crons?: VitalsAgentCron[] } | VitalsAgentCron[];
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object" && "crons" in data && Array.isArray(data.crons)) {
      return data.crons;
    }
    return data as VitalsAgentCron[];
  }
}
