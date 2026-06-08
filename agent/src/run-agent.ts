/**
 * agent/src/run-agent.ts
 *
 * Bootstraps and starts the Shipwright agent Hono server.
 *
 * Called by entrypoint.ts after all environment setup is complete.
 * Exports startServer() for programmatic use and runs it directly
 * when executed as the main entry (bun run run-agent.ts).
 */

import { join } from "node:path";
import { Hono } from "hono";
import { createConfig } from "./config.ts";
import { ensureAgentHome } from "./setup.ts";

const DEFAULT_PORT = 3000;

export async function startServer(opts?: { port?: number }): Promise<void> {
  const port = opts?.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const agentHome =
    process.env.AGENT_HOME ?? join(process.env.HOME ?? "/root", ".shipwright-agent");

  // Bootstrap the agent home directory (idempotent — safe to call on every start)
  ensureAgentHome(agentHome);

  const { config } = createConfig(agentHome);

  console.log(
    `[run-agent] starting agent ${config.shipwright.agentId ?? "(unset)"} on port ${port}`,
  );

  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Bun.serve is available in all Bun environments
  Bun.serve({ fetch: app.fetch, port });

  console.log(`[run-agent] agent server listening on port ${port}`);
}

// Run directly when invoked as main entry
if (import.meta.main) {
  startServer().catch((err) => {
    console.error("[run-agent] fatal startup error:", err);
    process.exit(1);
  });
}
