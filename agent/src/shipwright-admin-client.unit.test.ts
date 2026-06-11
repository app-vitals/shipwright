/**
 * agent/src/shipwright-admin-client.unit.test.ts
 * Unit tests for HttpShipwrightAdminClient — verifies correct auth header.
 */

import { describe, expect, it } from "bun:test";
import { HttpShipwrightAdminClient } from "./shipwright-admin-client.ts";

describe("HttpShipwrightAdminClient", () => {
  it("sends Authorization: Bearer header (not Cookie)", async () => {
    const capturedRequests: Request[] = [];

    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequests.push(new Request(input, init));
      return new Response(JSON.stringify({ crons: [] }), { status: 200 });
    };

    const client = new HttpShipwrightAdminClient(
      "http://localhost:9999",
      "test-key",
      fakeFetch,
    );

    await client.listCrons("agent-001");

    expect(capturedRequests).toHaveLength(1);
    const req = capturedRequests[0];
    expect(req?.headers.get("Authorization")).toBe("Bearer test-key");
    expect(req?.headers.get("Cookie")).toBeNull();
  });

  it("uses the provided apiKey in the Bearer token", async () => {
    const capturedHeaders: Record<string, string>[] = [];

    const fakeFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers as Record<string, string>;
        for (const [k, v] of Object.entries(h)) {
          headers[k] = v;
        }
      }
      capturedHeaders.push(headers);
      return new Response("{}", { status: 200 });
    };

    const client = new HttpShipwrightAdminClient(
      "http://localhost:9999",
      "my-secret-api-key",
      fakeFetch,
    );

    await client.upsertEnvs("agent-abc", { KEY: "value" });

    expect(capturedHeaders).toHaveLength(1);
    expect(capturedHeaders[0]?.Authorization).toBe("Bearer my-secret-api-key");
    expect(capturedHeaders[0]?.Cookie).toBeUndefined();
  });
});
