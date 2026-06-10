/**
 * agent/src/shipwright-runtime-client.integration.test.ts
 *
 * Integration tests for HttpShipwrightRuntimeClient.
 * Uses injected fake fetch doubles — no global.fetch override, no mock.module().
 */

import { describe, expect, it } from "bun:test";
import type { AgentConfigResponse, AgentCronJob } from "@shipwright/admin";
import {
  HttpShipwrightRuntimeClient,
  ShipwrightClientError,
} from "./shipwright-runtime-client.ts";

// ─── Test fixtures ─────────────────────────────────────────────────────────────

const API_URL = "https://api.test.shipwright.dev";
const API_KEY = "test-bearer-key";
const AGENT_ID = "agent-abc-123";

const SAMPLE_CONFIG: AgentConfigResponse = {
  env: { ANTHROPIC_MODEL: "claude-sonnet-4-6" },
  allowedTools: ["Read", "Bash"],
  plugins: [{ marketplace: "shipwright", plugin: "my-plugin" }],
};

const SAMPLE_CRONS: AgentCronJob[] = [
  {
    id: "cron-1",
    agentId: AGENT_ID,
    name: "daily-brief",
    schedule: "0 6 * * *",
    prompt: "Run the morning brief",
    channel: "C012345",
    user: null,
    silent: false,
    enabled: true,
    preCheck: null,
    system: false,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
  },
];

type FetchFn = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

// ─── Fake fetch helpers ────────────────────────────────────────────────────────

function fakeFetch(statusCode: number, body: unknown): FetchFn {
  return async (_url, _init) => {
    return new Response(JSON.stringify(body), {
      status: statusCode,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function capturingFetch(
  statusCode: number,
  body: unknown,
): {
  fn: FetchFn;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  return {
    fn: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return new Response(JSON.stringify(body), {
        status: statusCode,
        headers: { "Content-Type": "application/json" },
      });
    },
    calls,
  };
}

// ─── getAgentConfigBundle ──────────────────────────────────────────────────────

describe("HttpShipwrightRuntimeClient.getAgentConfigBundle", () => {
  it("returns parsed AgentConfigResponse on 200", async () => {
    const client = new HttpShipwrightRuntimeClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetchFn: fakeFetch(200, SAMPLE_CONFIG),
    });

    const result = await client.getAgentConfigBundle(AGENT_ID);

    expect(result).toEqual(SAMPLE_CONFIG);
  });

  it("throws ShipwrightClientError with statusCode 404 on 404", async () => {
    const client = new HttpShipwrightRuntimeClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetchFn: fakeFetch(404, { error: "Not found" }),
    });

    const err = await client.getAgentConfigBundle(AGENT_ID).catch((e) => e);

    expect(err).toBeInstanceOf(ShipwrightClientError);
    expect(err.statusCode).toBe(404);
  });

  it("throws ShipwrightClientError with statusCode 401 on 401", async () => {
    const client = new HttpShipwrightRuntimeClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetchFn: fakeFetch(401, { error: "Unauthorized" }),
    });

    const err = await client.getAgentConfigBundle(AGENT_ID).catch((e) => e);

    expect(err).toBeInstanceOf(ShipwrightClientError);
    expect(err.statusCode).toBe(401);
  });

  it("sends Authorization: Bearer header", async () => {
    const { fn, calls } = capturingFetch(200, SAMPLE_CONFIG);
    const client = new HttpShipwrightRuntimeClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetchFn: fn,
    });

    await client.getAgentConfigBundle(AGENT_ID);

    expect(calls.length).toBe(1);
    const authHeader = (calls[0].init?.headers as Record<string, string>)
      ?.Authorization;
    expect(authHeader).toBe(`Bearer ${API_KEY}`);
  });

  it("calls the correct URL", async () => {
    const { fn, calls } = capturingFetch(200, SAMPLE_CONFIG);
    const client = new HttpShipwrightRuntimeClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetchFn: fn,
    });

    await client.getAgentConfigBundle(AGENT_ID);

    expect(calls[0].url).toBe(`${API_URL}/agents/${AGENT_ID}/config`);
  });
});

// ─── listAgentCronJobs ─────────────────────────────────────────────────────────

describe("HttpShipwrightRuntimeClient.listAgentCronJobs", () => {
  it("returns parsed AgentCronJob[] on 200", async () => {
    const client = new HttpShipwrightRuntimeClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetchFn: fakeFetch(200, SAMPLE_CRONS),
    });

    const result = await client.listAgentCronJobs(AGENT_ID);

    expect(result.length).toBe(1);
    expect(result[0].id).toBe("cron-1");
  });

  it("throws ShipwrightClientError with statusCode 404 on 404", async () => {
    const client = new HttpShipwrightRuntimeClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetchFn: fakeFetch(404, { error: "Not found" }),
    });

    const err = await client.listAgentCronJobs(AGENT_ID).catch((e) => e);

    expect(err).toBeInstanceOf(ShipwrightClientError);
    expect(err.statusCode).toBe(404);
  });

  it("throws ShipwrightClientError with statusCode 401 on 401", async () => {
    const client = new HttpShipwrightRuntimeClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetchFn: fakeFetch(401, { error: "Unauthorized" }),
    });

    const err = await client.listAgentCronJobs(AGENT_ID).catch((e) => e);

    expect(err).toBeInstanceOf(ShipwrightClientError);
    expect(err.statusCode).toBe(401);
  });

  it("sends Authorization: Bearer header", async () => {
    const { fn, calls } = capturingFetch(200, SAMPLE_CRONS);
    const client = new HttpShipwrightRuntimeClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetchFn: fn,
    });

    await client.listAgentCronJobs(AGENT_ID);

    expect(calls.length).toBe(1);
    const authHeader = (calls[0].init?.headers as Record<string, string>)
      ?.Authorization;
    expect(authHeader).toBe(`Bearer ${API_KEY}`);
  });

  it("calls the correct URL", async () => {
    const { fn, calls } = capturingFetch(200, SAMPLE_CRONS);
    const client = new HttpShipwrightRuntimeClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetchFn: fn,
    });

    await client.listAgentCronJobs(AGENT_ID);

    expect(calls[0].url).toBe(`${API_URL}/agents/${AGENT_ID}/crons`);
  });
});

// ─── reconcileSystemCrons ──────────────────────────────────────────────────────

describe("HttpShipwrightRuntimeClient.reconcileSystemCrons", () => {
  it("resolves without error on 200", async () => {
    const client = new HttpShipwrightRuntimeClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetchFn: fakeFetch(200, { created: 1, updated: 0, deleted: 0 }),
    });

    await expect(client.reconcileSystemCrons(AGENT_ID)).resolves.toBeUndefined();
  });

  it("throws ShipwrightClientError with statusCode 404 on 404", async () => {
    const client = new HttpShipwrightRuntimeClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetchFn: fakeFetch(404, { error: "Not found" }),
    });

    const err = await client.reconcileSystemCrons(AGENT_ID).catch((e) => e);

    expect(err).toBeInstanceOf(ShipwrightClientError);
    expect(err.statusCode).toBe(404);
  });

  it("throws ShipwrightClientError with statusCode 401 on 401", async () => {
    const client = new HttpShipwrightRuntimeClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetchFn: fakeFetch(401, { error: "Unauthorized" }),
    });

    const err = await client.reconcileSystemCrons(AGENT_ID).catch((e) => e);

    expect(err).toBeInstanceOf(ShipwrightClientError);
    expect(err.statusCode).toBe(401);
  });

  it("sends Authorization: Bearer header", async () => {
    const { fn, calls } = capturingFetch(200, { created: 0, updated: 0, deleted: 0 });
    const client = new HttpShipwrightRuntimeClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetchFn: fn,
    });

    await client.reconcileSystemCrons(AGENT_ID);

    expect(calls.length).toBe(1);
    const authHeader = (calls[0].init?.headers as Record<string, string>)
      ?.Authorization;
    expect(authHeader).toBe(`Bearer ${API_KEY}`);
  });

  it("calls the correct URL with POST method", async () => {
    const { fn, calls } = capturingFetch(200, { created: 0, updated: 0, deleted: 0 });
    const client = new HttpShipwrightRuntimeClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetchFn: fn,
    });

    await client.reconcileSystemCrons(AGENT_ID);

    expect(calls[0].url).toBe(
      `${API_URL}/admin/api/agents/${AGENT_ID}/crons/reconcile`,
    );
    expect(calls[0].init?.method).toBe("POST");
  });
});
