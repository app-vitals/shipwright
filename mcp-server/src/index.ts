import { Hono } from "hono";
import { generatedTools } from "./generated-tools.ts";
import { allowedTools } from "./tool-allowlist.ts";
import { createMcpServer } from "./mcp-server.ts";

export const app = new Hono();

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// Lightweight discovery route: lists the MCP tools this server exposes.
// The MCP protocol itself is served over a transport (stdio / Streamable HTTP /
// in-memory) via `createMcpServer()`; this endpoint is a convenience for humans.
app.get("/mcp/tools", (c) => {
  const tools = allowedTools(generatedTools);
  return c.json({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
    })),
  });
});

export { createMcpServer, generatedTools };
