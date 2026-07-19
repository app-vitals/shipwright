/**
 * http-transport.smoke.test.ts
 * End-to-end smoke coverage for the MCP Streamable HTTP transport mounted on
 * the Hono app: drives a real initialize + tools/list + tools/call handshake
 * via in-process `app.request()` — no real socket, per this repo's smoke-test
 * convention (see CLAUDE.md).
 *
 * Uses a fresh Hono app + a stub ToolCallerConfig (mirrors the pattern in
 * mcp-server.smoke.test.ts) so tests don't depend on
 * SHIPWRIGHT_TASK_STORE_URL / SHIPWRIGHT_TASK_STORE_TOKEN being set in CI, and
 * so tools/call never reaches a real network.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { Clock } from "./clock.ts";
import { mountMcpHttpTransport } from "./http-transport.ts";

const ALLOWED_TOOL_NAMES = [
  "tasks_list",
  "tasks_create",
  "tasks_bulk",
  "tasks_distinct",
  "tasks_get",
  "tasks_update",
  "prs_list",
  "prs_get",
  "prs_update",
] as const;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Parse a Streamable HTTP response body, which may be plain JSON or an SSE
 * stream carrying a single `data: <json>` event depending on the transport's
 * negotiated response mode. */
async function parseMcpResponse(res: Response): Promise<JsonRpcResponse> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) throw new Error(`no data line in SSE body: ${text}`);
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

function buildApp(
  fetchImpl?: typeof fetch,
  overrides: {
    idleTimeoutMs?: number;
    sweepIntervalMs?: number;
    clock?: Clock;
  } = {},
): { app: Hono; stop: () => void } {
  const app = new Hono();
  const { stop } = mountMcpHttpTransport(app, {
    config: {
      baseUrl: "http://localhost:3002",
      token: "test-token",
      fetchImpl,
    },
    ...overrides,
  });
  return { app, stop };
}

async function initialize(
  app: Hono,
): Promise<{ sessionId: string; body: JsonRpcResponse }> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke-test-client", version: "0.0.0" },
      },
    }),
  });
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  const body = await parseMcpResponse(res);
  return { sessionId: sessionId as string, body };
}

describe("MCP Streamable HTTP transport", () => {
  it("completes an initialize handshake and returns a session id", async () => {
    const { app } = buildApp();
    const { sessionId, body } = await initialize(app);

    expect(sessionId).toBeTruthy();
    expect(body.result).toBeDefined();
    expect(body.result?.protocolVersion).toBeDefined();
    expect(body.result?.serverInfo).toMatchObject({
      name: "shipwright-task-store",
    });
  });

  it("tools/list over HTTP returns the same 9 allowlisted tools as stdio", async () => {
    const { app } = buildApp();
    const { sessionId } = await initialize(app);

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    const tools = (body.result?.tools ?? []) as Array<{ name: string }>;
    const names = tools.map((t) => t.name);

    expect(names).toHaveLength(9);
    for (const name of ALLOWED_TOOL_NAMES) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain("tasks_claim");
    expect(names).not.toContain("prs_claim");
  });

  it("tools/call over HTTP proxies to the task store and returns the tool result", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("http://localhost:3002/tasks?status=pending");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer test-token",
      });
      return new Response(
        JSON.stringify({ tasks: [{ id: "clx1", title: "Task A" }], total: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const { app } = buildApp(fetchImpl);
    const { sessionId } = await initialize(app);

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "tasks_list", arguments: { status: "pending" } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    const content = body.result?.content as Array<{
      type: string;
      text: string;
    }>;
    expect(content).toBeDefined();
    const parsed = JSON.parse(content[0].text);
    expect(parsed.total).toBe(1);
    expect(parsed.tasks[0].title).toBe("Task A");
  });

  it("rejects a non-initialize POST with no session id", async () => {
    const { app } = buildApp();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/list",
        params: {},
      }),
    });
    expect(res.status).toBe(400);
  });

  it("reaps a session that goes idle past idleTimeoutMs", async () => {
    // Drive the reaper with a FixedClock we advance manually — no real
    // setTimeout waits, per this repo's Clock-injection test-isolation
    // convention (see task-store/src/stale-claim-reaper.ts).
    const start = new Date("2026-01-01T00:00:00.000Z");
    const clock = { now: () => new Date(start) };
    const { app, stop } = buildApp(undefined, {
      idleTimeoutMs: 10,
      sweepIntervalMs: 10,
      clock,
    });
    try {
      const { sessionId } = await initialize(app);

      // Advance the injected clock past the idle timeout, without sending
      // any further requests for this session, then let the already-running
      // sweep interval fire against the new time.
      clock.now = () => new Date(start.getTime() + 1000);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/list",
          params: {},
        }),
      });

      // The session's transport was reaped, so it's no longer a known
      // session: the request is rejected the same way an unknown/invalid
      // session id would be.
      expect(res.status).toBe(400);
    } finally {
      stop();
    }
  });

  it("touches session activity on every transport.send() (server push), not just at request-open", async () => {
    // Regression test for the touch-on-push fix: the SDK's Server routes
    // every outbound message — request responses *and* server-initiated
    // notifications on the standalone GET SSE stream — through
    // `transport.send()` (see the SDK's own comment: "This will be handled
    // by the send() method when responses are ready"). http-transport.ts
    // wraps `transport.send` to call `touch()` on every invocation, so a
    // session that's only ever receiving pushes (no further client
    // POST/GET/DELETE) still counts as active.
    //
    // We exercise this by advancing the clock close to (but under) the idle
    // cutoff between request-open and response-send, then confirming a
    // subsequent sweep — anchored on the send()-refreshed timestamp, not the
    // request-open timestamp — does not reap the session.
    const start = new Date("2026-01-01T00:00:00.000Z");
    const clock = { now: () => new Date(start) };
    const { app, stop } = buildApp(undefined, {
      idleTimeoutMs: 500,
      sweepIntervalMs: 10,
      clock,
    });
    try {
      const { sessionId } = await initialize(app);

      // Advance past what would be the idle cutoff measured from
      // request-open, then let the request complete: its `send()` call
      // (touch-on-push) should refresh activity to this later time.
      clock.now = () => new Date(start.getTime() + 600);
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/list",
          params: {},
        }),
      });
      expect(res.status).toBe(200);

      // Advance again, past idleTimeoutMs from request-open (t=0) but still
      // within idleTimeoutMs of the send()-refreshed activity (t=600), and
      // let the sweep run. If `send()` weren't touching activity, this
      // session would already be stale relative to t=0 and get reaped.
      clock.now = () => new Date(start.getTime() + 1000);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const res2 = await app.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/list",
          params: {},
        }),
      });
      expect(res2.status).toBe(200);
    } finally {
      stop();
    }
  });
});
