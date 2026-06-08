import type { AgentConfigResponse } from "./api.ts";

export interface ShipwrightConfigClient {
  getAgentConfig(agentId: string): Promise<AgentConfigResponse>;
}

export class HttpShipwrightConfigClient implements ShipwrightConfigClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;

  constructor(apiUrl: string, apiKey: string) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  async getAgentConfig(agentId: string): Promise<AgentConfigResponse> {
    const url = `${this.apiUrl}/agents/${agentId}/config`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch agent config: ${response.status} ${response.statusText} (${url})`,
      );
    }

    return response.json() as Promise<AgentConfigResponse>;
  }
}
