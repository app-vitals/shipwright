/**
 * agent/src/shipwright-runtime-client.ts
 *
 * Unified runtime client for the three agent-facing Shipwright API methods.
 *
 * - ShipwrightClientError — typed error with statusCode
 * - ShipwrightRuntimeClient — interface for DI
 * - HttpShipwrightRuntimeClient — typed HTTP implementation via openapi-fetch
 */

import type {
  AdminApiPaths,
  AgentConfigResponse,
  AgentCronJob,
  RuntimeApiPaths,
} from "@shipwright/admin";
import createClient from "openapi-fetch";

type FetchFn = (
  url: RequestInfo | URL,
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
  private readonly client: ReturnType<typeof createClient<RuntimeApiPaths>>;
  private readonly adminClient: ReturnType<typeof createClient<AdminApiPaths>>;

  constructor(opts: {
    apiUrl: string;
    /** Base URL for admin-tier endpoints (e.g. /admin/api/...). Defaults to apiUrl when the unified admin service serves both namespaces. */
    adminApiUrl?: string;
    apiKey: string;
    fetchFn?: FetchFn;
  }) {
    const commonOpts = {
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      ...(opts.fetchFn ? { fetch: opts.fetchFn } : {}),
    };
    this.client = createClient<RuntimeApiPaths>({
      baseUrl: opts.apiUrl,
      ...commonOpts,
    });
    this.adminClient = createClient<AdminApiPaths>({
      baseUrl: opts.adminApiUrl ?? opts.apiUrl,
      ...commonOpts,
    });
  }

  async getAgentConfigBundle(agentId: string): Promise<AgentConfigResponse> {
    const { data, error, response } = await this.client.GET(
      "/agents/{agentId}/config",
      { params: { path: { agentId } } },
    );
    if (error) {
      throw new ShipwrightClientError(
        response.status,
        `GET /agents/${agentId}/config failed: ${response.status}`,
      );
    }
    return data;
  }

  async listAgentCronJobs(agentId: string): Promise<AgentCronJob[]> {
    const { data, error, response } = await this.client.GET(
      "/agents/{agentId}/crons",
      { params: { path: { agentId } } },
    );
    if (error) {
      throw new ShipwrightClientError(
        response.status,
        `GET /agents/${agentId}/crons failed: ${response.status}`,
      );
    }
    return data;
  }

  async reconcileSystemCrons(agentId: string): Promise<void> {
    const { error, response } = await this.adminClient.POST(
      "/admin/api/agents/{agentId}/crons/reconcile",
      { params: { path: { agentId } } },
    );
    if (error) {
      throw new ShipwrightClientError(
        response.status,
        `POST /admin/api/agents/${agentId}/crons/reconcile failed: ${response.status}`,
      );
    }
  }
}
