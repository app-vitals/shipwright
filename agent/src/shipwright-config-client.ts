/**
 * agent/src/shipwright-config-client.ts
 *
 * Client for fetching agent configuration from the Shipwright API.
 *
 * - ShipwrightConfigClient — interface for DI
 * - HttpShipwrightConfigClient — real HTTP implementation
 * - RecordedShipwrightConfigClient — cassette-backed double for tests
 */

import type { AgentConfigResponse } from "@shipwright/admin";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ShipwrightConfigClient {
  getConfig(agentId: string): Promise<AgentConfigResponse>;
}

// ─── HttpShipwrightConfigClient ───────────────────────────────────────────────

export class HttpShipwrightConfigClient implements ShipwrightConfigClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: {
    apiUrl: string;
    apiKey: string;
    fetchFn?: typeof fetch;
  }) {
    this.apiUrl = opts.apiUrl;
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async getConfig(agentId: string): Promise<AgentConfigResponse> {
    const url = `${this.apiUrl}/agents/${encodeURIComponent(agentId)}/config`;
    const response = await this.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `[shipwright-config-client] GET /agents/${agentId}/config failed: ${response.status} ${response.statusText}`,
      );
    }

    return response.json() as Promise<AgentConfigResponse>;
  }
}

// ─── RecordedShipwrightConfigClient ───────────────────────────────────────────

/**
 * Cassette-backed client for tests.
 * Returns a fixed AgentConfigResponse on every call — no network required.
 */
export class RecordedShipwrightConfigClient implements ShipwrightConfigClient {
  private readonly cassette: AgentConfigResponse;

  constructor(cassette: AgentConfigResponse) {
    this.cassette = cassette;
  }

  async getConfig(_agentId: string): Promise<AgentConfigResponse> {
    return this.cassette;
  }
}
