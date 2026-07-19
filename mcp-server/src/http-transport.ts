/**
 * http-transport.ts
 * Mounts the MCP protocol over Streamable HTTP on a Hono app.
 *
 * Bridges Hono's Web-Standard Request/Response directly to the SDK's
 * `WebStandardStreamableHTTPServerTransport` — no Node-stream shim required
 * (see @modelcontextprotocol/sdk/server/webStandardStreamableHttp.js).
 *
 * Runs in STATEFUL mode: each new session (an `initialize` request with no
 * `mcp-session-id` header) gets its own transport + `createMcpServer()`
 * instance, keyed by the session id the transport generates. Follow-up
 * requests carrying a known `mcp-session-id` header reuse that same
 * transport instance, which validates the session internally on
 * GET/DELETE/subsequent POSTs.
 *
 * The request body is read once (`await c.req.json()`) and threaded through
 * via `options.parsedBody` so the transport doesn't re-read the stream.
 */

import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type CreateMcpServerOptions, createMcpServer } from "./mcp-server.ts";

const MCP_PATH = "/mcp";
const SESSION_ID_HEADER = "mcp-session-id";

export interface MountMcpHttpTransportOptions extends CreateMcpServerOptions {}

/**
 * Mount the MCP Streamable HTTP endpoint (`/mcp`) on `app`, handling
 * POST (JSON-RPC messages, including `initialize`), GET (SSE stream for
 * server-initiated messages), and DELETE (session termination).
 */
export function mountMcpHttpTransport(
  app: Hono,
  options: MountMcpHttpTransportOptions = {},
): void {
  const transports = new Map<
    string,
    WebStandardStreamableHTTPServerTransport
  >();

  app.post(MCP_PATH, async (c) => {
    const sessionId = c.req.header(SESSION_ID_HEADER);
    const existing = sessionId ? transports.get(sessionId) : undefined;

    if (existing) {
      return existing.handleRequest(c.req.raw);
    }

    // No known session: only a fresh `initialize` request may start one.
    const parsedBody = await c.req.json();
    if (sessionId || !isInitializeRequest(parsedBody)) {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        },
        { status: 400 },
      );
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports.set(newSessionId, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };

    const server = createMcpServer(options);
    await server.connect(transport);

    return transport.handleRequest(c.req.raw, { parsedBody });
  });

  app.get(MCP_PATH, async (c) => {
    const sessionId = c.req.header(SESSION_ID_HEADER);
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      return new Response("Invalid or missing session ID", { status: 400 });
    }
    return transport.handleRequest(c.req.raw);
  });

  app.delete(MCP_PATH, async (c) => {
    const sessionId = c.req.header(SESSION_ID_HEADER);
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      return new Response("Invalid or missing session ID", { status: 400 });
    }
    return transport.handleRequest(c.req.raw);
  });
}
