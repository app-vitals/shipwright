/**
 * mcp-server/src/main.ts
 *
 * HTTP entry point for the Shipwright MCP server.
 *
 * Serves the Hono app (health check, MCP Streamable HTTP transport, and the
 * human-readable /mcp/tools listing) via Bun.serve. Remote MCP clients
 * (e.g. Claude Desktop custom connectors) connect to POST/GET/DELETE /mcp.
 *
 * This service has no database and no background jobs — unlike task-store's
 * main.ts, there's no migration preflight or reaper to run here.
 *
 *   bun run mcp-server/src/main.ts
 */

import { app } from "./index.ts";

const DEFAULT_PORT = 3010;

const port = Number(process.env.PORT ?? DEFAULT_PORT);

const server = Bun.serve({ port, fetch: app.fetch });
console.log(`[mcp-server] listening on http://localhost:${server.port}`);
