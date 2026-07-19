/**
 * mcp-server/src/main.ts
 *
 * HTTP entry point for the Shipwright MCP server.
 *
 * Serves the Hono app (health check, MCP Streamable HTTP transport, and the
 * human-readable /mcp/tools listing) via Bun.serve. Remote MCP clients
 * (e.g. Claude Desktop custom connectors) connect to POST/GET/DELETE /mcp.
 *
 * This service has no database — unlike task-store's main.ts, there's no
 * migration preflight to run here. It does run one lightweight background
 * job: `mountMcpHttpTransport`'s idle-session reaper (see http-transport.ts).
 *
 * Inbound auth (TSM-2.6): this is the ONE place that reads
 * SHIPWRIGHT_MCP_SERVER_TOKEN from the environment. The service fails closed
 * — it refuses to start at all — if the token is unset, since exposing
 * mcp-server without inbound auth would let anyone who finds the URL proxy
 * fully-authenticated read/write calls into the task store (see auth.ts).
 *
 *   bun run mcp-server/src/main.ts
 */

import { createApp } from "./index.ts";

const DEFAULT_PORT = 3010;

const token = process.env.SHIPWRIGHT_MCP_SERVER_TOKEN;
if (!token) {
  throw new Error(
    "SHIPWRIGHT_MCP_SERVER_TOKEN must be set — mcp-server refuses to start without inbound auth configured.",
  );
}

const port = Number(process.env.PORT ?? DEFAULT_PORT);

const app = createApp({ token });
const server = Bun.serve({ port, fetch: app.fetch });
console.log(`[mcp-server] listening on http://localhost:${server.port}`);
