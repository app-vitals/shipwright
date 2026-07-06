/**
 * mcp-server/src/index.ts
 *
 * Entry point for the Shipwright MCP server.
 * Exports a minimal Hono application.
 */

import { Hono } from "hono";

export const app = new Hono();

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});
