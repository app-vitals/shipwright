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
 *
 * Idle sessions are reclaimed by a periodic sweep: each session's
 * last-activity timestamp is refreshed on every POST/GET/DELETE it handles,
 * and a `setInterval` reaper evicts (and closes) any transport that's gone
 * quiet for longer than `idleTimeoutMs`. Without this, a remote client that
 * disconnects, crashes, or never sends `DELETE /mcp` would otherwise leak its
 * transport + `createMcpServer()` instance in the `transports` Map forever.
 */

import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type CreateMcpServerOptions, createMcpServer } from "./mcp-server.ts";

const MCP_PATH = "/mcp";
const SESSION_ID_HEADER = "mcp-session-id";

/** Evict a session's transport after this long without a request. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
/** How often the reaper sweeps for idle sessions. */
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface MountMcpHttpTransportOptions extends CreateMcpServerOptions {
  /** Idle-eviction timeout in ms (default: 30 minutes). */
  idleTimeoutMs?: number;
  /** How often to sweep for idle sessions, in ms (default: 5 minutes). */
  sweepIntervalMs?: number;
}

/**
 * Mount the MCP Streamable HTTP endpoint (`/mcp`) on `app`, handling
 * POST (JSON-RPC messages, including `initialize`), GET (SSE stream for
 * server-initiated messages), and DELETE (session termination).
 *
 * Also starts a `setInterval` reaper that evicts transports idle for longer
 * than `idleTimeoutMs`. Call the returned `stop()` to clear that interval
 * (e.g. in tests, or on graceful shutdown).
 */
export function mountMcpHttpTransport(
  app: Hono,
  options: MountMcpHttpTransportOptions = {},
): { stop: () => void } {
  const {
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    ...serverOptions
  } = options;

  const transports = new Map<
    string,
    WebStandardStreamableHTTPServerTransport
  >();
  const lastActivity = new Map<string, number>();

  const touch = (sessionId: string | undefined): void => {
    if (sessionId) lastActivity.set(sessionId, Date.now());
  };

  const evict = (sessionId: string): void => {
    const transport = transports.get(sessionId);
    transports.delete(sessionId);
    lastActivity.delete(sessionId);
    // transport.close() fires `onclose`, which also deletes from `transports`
    // — harmless double-delete since we've already removed it above.
    void transport?.close();
  };

  const sweep = (): void => {
    const cutoff = Date.now() - idleTimeoutMs;
    for (const [sessionId, lastSeen] of lastActivity) {
      if (lastSeen < cutoff) evict(sessionId);
    }
  };

  const reaper = setInterval(sweep, sweepIntervalMs);
  // Don't hold the process open just for the reaper (relevant for tests and
  // for clean shutdown of short-lived processes).
  reaper.unref?.();

  app.post(MCP_PATH, async (c) => {
    const sessionId = c.req.header(SESSION_ID_HEADER);
    const existing = sessionId ? transports.get(sessionId) : undefined;

    if (existing) {
      touch(sessionId);
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
        touch(newSessionId);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
        lastActivity.delete(transport.sessionId);
      }
    };

    const server = createMcpServer(serverOptions);
    await server.connect(transport);

    return transport.handleRequest(c.req.raw, { parsedBody });
  });

  const handleSessionRequest = async (c: Context): Promise<Response> => {
    const sessionId = c.req.header(SESSION_ID_HEADER);
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      return new Response("Invalid or missing session ID", { status: 400 });
    }
    touch(sessionId);
    return transport.handleRequest(c.req.raw);
  };

  app.get(MCP_PATH, handleSessionRequest);
  app.delete(MCP_PATH, handleSessionRequest);

  return {
    stop: () => clearInterval(reaper),
  };
}
