/**
 * serve.ts
 * Stdio entry point for the Shipwright task-store MCP server.
 *
 * Launches the generated MCP server over stdio — the standard transport MCP
 * clients (e.g. Claude Code) expect. Bearer auth is resolved from
 * SHIPWRIGHT_TASK_STORE_URL / SHIPWRIGHT_TASK_STORE_TOKEN.
 *
 *   bun run mcp-server/src/serve.ts
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp-server.ts";

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("MCP server failed to start:", err);
    process.exit(1);
  });
}
