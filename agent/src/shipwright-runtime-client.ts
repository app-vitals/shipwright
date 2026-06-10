/**
 * agent/src/shipwright-runtime-client.ts
 *
 * Unified runtime client for the three agent-facing Shipwright API methods.
 *
 * - ShipwrightClientError — typed error with statusCode
 * - ShipwrightRuntimeClient — interface for DI
 * - HttpShipwrightRuntimeClient — real HTTP implementation with injected fetchFn
 */

import type { AgentConfigResponse, AgentCronJob } from "@shipwright/admin";

type FetchFn = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

// ─── Error ────────────────────────────────────────────────────────────────────

export class ShipwrightClientError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ShipwrightClientError";
  }
}

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ShipwrightRuntimeClient {
  getAgentConfigBundle(agentId: string): Promise<AgentConfigResponse>;
  listAgentCronJobs(agentId: string): Promise<AgentCronJob[]>;
  reconcileSystemCrons(agentId: string): Promise<void>;
}

// ─── HttpShipwrightRuntimeClient ──────────────────────────────────────────────

export class HttpShipwrightRuntimeClient implements ShipwrightRuntimeClient {
  private readonly apiUrl: string;
  private readonly adminApiUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: {
    apiUrl: string;
    /** Base URL for admin-tier endpoints (e.g. /admin/api/...). Defaults to apiUrl when the unified admin service serves both namespaces. */
    adminApiUrl?: string;
    apiKey: string;
    fetchFn?: FetchFn;
  }) {
    this.apiUrl = opts.apiUrl;
    this.adminApiUrl = opts.adminApiUrl ?? opts.apiUrl;
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private get authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async getAgentConfigBundle(agentId: string): Promise<AgentConfigResponse> {
    const url = `${this.apiUrl}/agents/${encodeURIComponent(agentId)}/config`;
    const response = await this.fetchFn(url, {
      headers: this.authHeaders,
    });

    if (!response.ok) {
      throw new ShipwrightClientError(
        response.status,
        `GET /agents/${agentId}/config failed: ${response.status} ${response.statusText}`,
      );
    }

    return response.json() as Promise<AgentConfigResponse>;
  }

  async listAgentCronJobs(agentId: string): Promise<AgentCronJob[]> {
    const url = `${this.apiUrl}/agents/${encodeURIComponent(agentId)}/crons`;
    const response = await this.fetchFn(url, {
      headers: this.authHeaders,
    });

    if (!response.ok) {
      throw new ShipwrightClientError(
        response.status,
        `GET /agents/${agentId}/crons failed: ${response.status} ${response.statusText}`,
      );
    }

    return response.json() as Promise<AgentCronJob[]>;
  }

  async reconcileSystemCrons(agentId: string): Promise<void> {
    const url = `${this.adminApiUrl}/admin/api/agents/${encodeURIComponent(agentId)}/crons/reconcile`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: this.authHeaders,
    });

    if (!response.ok) {
      throw new ShipwrightClientError(
        response.status,
        `POST ${this.adminApiUrl}/admin/api/agents/${agentId}/crons/reconcile failed: ${response.status} ${response.statusText}`,
      );
    }
  }
}
