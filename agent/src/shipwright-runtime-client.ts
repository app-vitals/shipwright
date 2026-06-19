/**
 * agent/src/shipwright-runtime-client.ts
 *
 * Unified runtime client for the three agent-facing Shipwright API methods.
 *
 * - ShipwrightClientError — typed error with statusCode
 * - ShipwrightRuntimeClient — interface for DI
 * - HttpShipwrightRuntimeClient — typed HTTP implementation via openapi-fetch
 */

import type { AgentConfigResponse, AgentCronJob } from "@shipwright/admin";
import type { paths } from "@shipwright/lib/admin-types";
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
  private readonly client: ReturnType<typeof createClient<paths>>;
  private readonly adminClient: ReturnType<typeof createClient<paths>>;

  constructor(opts: {
    apiUrl: string;
    /** Base URL for admin-tier endpoints (e.g. /agents/:id/...). Defaults to apiUrl when the unified admin service serves both namespaces. */
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
    this.client = createClient<paths>({
      baseUrl: opts.apiUrl,
      ...commonOpts,
    });
    this.adminClient = createClient<paths>({
      baseUrl: opts.adminApiUrl ?? opts.apiUrl,
      ...commonOpts,
    });
  }

  async getAgentConfigBundle(agentId: string): Promise<AgentConfigResponse> {
    const { data, error, response } = await this.client.GET(
      "/agents/{id}/config",
      { params: { path: { id: agentId } } },
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
      "/agents/{id}/crons",
      { params: { path: { id: agentId } } },
    );
    if (error) {
      throw new ShipwrightClientError(
        response.status,
        `GET /agents/${agentId}/crons failed: ${response.status}`,
      );
    }
    // The API returns ISO date strings; cast through unknown to the internal
    // AgentCronJob type (which uses Date objects — deserialization is callers'
    // concern, matching prior behaviour).
    return data as unknown as AgentCronJob[];
  }

  async reconcileSystemCrons(agentId: string): Promise<void> {
    // The reconcile endpoint only defines a 200 response in the spec, so
    // openapi-fetch types `error` as never. Use response.ok instead.
    const { response } = await this.adminClient.POST(
      "/agents/{id}/crons/reconcile",
      { params: { path: { id: agentId } } },
    );
    if (!response.ok) {
      throw new ShipwrightClientError(
        response.status,
        `POST /agents/${agentId}/crons/reconcile failed: ${response.status}`,
      );
    }
  }
}
