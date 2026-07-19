import { Hono } from "hono";
import { createBearerAuthMiddleware } from "./auth.ts";
import { generatedTools } from "./generated-tools.ts";
import { mountMcpHttpTransport } from "./http-transport.ts";
import { allowedTools } from "./tool-allowlist.ts";
import { createMcpServer } from "./mcp-server.ts";

export interface CreateAppOptions {
  /** Inbound bearer token required on every request past /health. */
  token: string;
}

/**
 * Build the mcp-server Hono app.
 *
 * A factory (rather than a module-level singleton) so tests can inject a
 * fixed test token without polluting `process.env` — see main.ts, which is
 * the one place that reads SHIPWRIGHT_MCP_SERVER_TOKEN and fails closed if
 * it's unset.
 */
export function createApp(options: CreateAppOptions): Hono {
  const { token } = options;
  const app = new Hono();

  // /health stays unauthenticated (before the auth middleware, registration
  // order matters here) so k8s liveness/readiness probes keep working.
  app.get("/health", (c) => {
    return c.json({ status: "ok" });
  });

  // Everything below this line requires a valid bearer token — this is the
  // ONLY inbound auth gate for the service (TSM-2.6). Without it, exposing
  // mcp-server on the network would let anyone who finds the URL proxy
  // fully-authenticated read/write calls into the task store via tool-caller.ts,
  // which attaches the privileged SHIPWRIGHT_TASK_STORE_TOKEN on the way out.
  app.use("*", createBearerAuthMiddleware(token));

  // The MCP protocol over Streamable HTTP — POST/GET/DELETE on /mcp, per the
  // MCP spec. Remote clients (e.g. Claude Desktop custom connectors) use this.
  mountMcpHttpTransport(app);

  // Lightweight discovery route: lists the MCP tools this server exposes.
  // The MCP protocol itself is served over a transport (stdio / Streamable HTTP /
  // in-memory) via `createMcpServer()`; this endpoint is a convenience for humans.
  //
  // DECISION (TSM-2.6): this route IS gated by the same auth middleware above,
  // even though it only returns static tool name/description metadata (no
  // privileged outbound calls). Leaving discovery open would let an
  // unauthenticated caller enumerate this server's capabilities before ever
  // presenting a token — unnecessary reconnaissance surface for a service that
  // otherwise requires auth for everything past /health.
  app.get("/mcp/tools", (c) => {
    const tools = allowedTools(generatedTools);
    return c.json({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
      })),
    });
  });

  return app;
}

export { createMcpServer, generatedTools };
