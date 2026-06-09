/**
 * agent/src/test-helpers/mock-deps.ts
 *
 * Shared ComposedAppDeps double for smoke tests.
 * Simulates the standalone admin service via an injected mock fetchFn.
 * No real DB, no real network — every response is deterministic.
 */

import type { ComposedAppDeps } from "../run-agent.ts";

export const TEST_AGENT_ID = "agent-test-123";
export const TEST_INTERNAL_API_KEY = "test-internal-api-key";

export function makeMockDeps(): ComposedAppDeps {
  const mockFetch = async (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input));
    const url = req.url;

    // Simulate admin service auth: require Bearer token
    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.includes("/config")) {
      return new Response(
        JSON.stringify({
          env: { FOO: "bar" },
          allowedTools: ["Read"],
          plugins: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.includes("/crons")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  };

  return {
    adminApiUrl: "http://mock-admin-service",
    fetchFn: mockFetch,
  };
}
