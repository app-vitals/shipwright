/**
 * agent/src/shipwright-config-client.ts
 *
 * - ShipwrightConfigClient — interface for DI (used by entrypoint and tests)
 * - RecordedShipwrightConfigClient — cassette-backed double for tests
 *
 * The HTTP implementation was consolidated into HttpShipwrightRuntimeClient
 * (shipwright-runtime-client.ts). Wire that via getAgentConfigBundle() as the
 * configClient adapter in entrypoint-main.ts.
 */

import type { AgentConfigResponse } from "@shipwright/admin";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ShipwrightConfigClient {
  getConfig(agentId: string): Promise<AgentConfigResponse>;
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
