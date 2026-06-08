/**
 * agent/src/shipwright-config-client.ts
 * ShipwrightConfigClient — reads agent config and crons from the shipwright config API.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ShipwrightConfigResponse {
  env: Record<string, string>;
  allowedTools: string[];
}

export interface ShipwrightCronEntry {
  id: string;
  schedule: string;
  prompt: string;
}

export interface ShipwrightConfigClient {
  getConfig(agentId: string): Promise<ShipwrightConfigResponse>;
  getCrons(agentId: string): Promise<ShipwrightCronEntry[]>;
}

// ─── HTTP implementation ──────────────────────────────────────────────────────

export class HttpShipwrightConfigClient implements ShipwrightConfigClient {
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

  async getConfig(agentId: string): Promise<ShipwrightConfigResponse> {
    const url = `${this.baseUrl}/agents/${agentId}/config`;
    const res = await globalThis.fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(
        `getConfig(${agentId}) failed: ${res.status} ${await res.text()}`,
      );
    }
    return res.json() as Promise<ShipwrightConfigResponse>;
  }

  async getCrons(agentId: string): Promise<ShipwrightCronEntry[]> {
    const url = `${this.baseUrl}/agents/${agentId}/crons`;
    const res = await globalThis.fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(
        `getCrons(${agentId}) failed: ${res.status} ${await res.text()}`,
      );
    }
    const data = await res.json() as ShipwrightCronEntry[] | { crons: ShipwrightCronEntry[] };
    if (Array.isArray(data)) return data;
    return data.crons;
  }
}

// ─── Recorded double for tests ────────────────────────────────────────────────

export class RecordedShipwrightConfigClient implements ShipwrightConfigClient {
  constructor(
    private readonly config: ShipwrightConfigResponse,
    private readonly crons: ShipwrightCronEntry[],
  ) {}

  async getConfig(_agentId: string): Promise<ShipwrightConfigResponse> {
    return {
      env: { ...this.config.env },
      allowedTools: [...this.config.allowedTools],
    };
  }

  async getCrons(_agentId: string): Promise<ShipwrightCronEntry[]> {
    return this.crons.map((c) => ({ ...c }));
  }
}
