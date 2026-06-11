/**
 * agent/src/run-agent.ts
 *
 * Minimal agent server — /chat (dev-only) only.
 *
 * Called by entrypoint.ts after all environment setup is complete.
 * Exports createComposedApp(deps) for testing and startServer() for programmatic use.
 * Runs startServer() directly when executed as the main entry (bun run run-agent.ts).
 *
 * Health is served on a dedicated health server (SHIPWRIGHT_HEALTH_PORT, default 3459)
 * via startHealthServer() from health.ts. entrypoint-main.ts starts the health server
 * in-process before spawning this subprocess so liveness is available during startup.
 *
 * The /agents/* transparent proxy was removed in UNI-1.3 — no proxy routes remain.
 *
 * Route mount order:
 *   POST /chat   — dev-only local transport (SHIPWRIGHT_DEV_CHAT gate, DEFAULT-DENY)
 */

import { join } from "node:path";
import { Hono } from "hono";
import type { ChatRunner } from "./chat.ts";
import { createChatApp } from "./chat.ts";
import { createRunClaude } from "./claude.ts";
import { startConfigSync } from "./config-sync.ts";
import { createConfig } from "./config.ts";
import { ensureAgentHome } from "./setup.ts";
import { HttpShipwrightRuntimeClient } from "./shipwright-runtime-client.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * All dependencies the composed app needs.
 * Provided by startServer() for production; injected as doubles in tests.
 */
export interface ComposedAppDeps {
  /**
   * Dev-only local chat transport. DEFAULT-DENY: when falsy (the default),
   * the POST /chat route is NOT registered at all (requests 404). Read once
   * from SHIPWRIGHT_DEV_CHAT at composition time in startServer().
   */
  devChat?: boolean;
  /** Claude runner seam for /chat — only used when devChat is true. */
  chatRunner?: ChatRunner;
}

// ─── App factory ──────────────────────────────────────────────────────────────

/**
 * Composes the minimal agent app: optional /chat only.
 *
 * /health is NOT mounted here — it runs on the dedicated health server
 * (startHealthServer on SHIPWRIGHT_HEALTH_PORT). See health.ts.
 *
 * /agents/* proxy was removed in UNI-1.3 — no proxy routes remain.
 */
export function createComposedApp(deps: ComposedAppDeps): Hono {
  const { devChat, chatRunner } = deps;

  const root = new Hono();

  // Dev-only chat transport — DEFAULT-DENY. Only registered when devChat
  // is true AND a runner is provided; otherwise POST /chat 404s.
  if (devChat && chatRunner) {
    root.route("/", createChatApp({ runner: chatRunner }));
  }

  return root;
}

// ─── Server entry ─────────────────────────────────────────────────────────────

const DEFAULT_PORT = 3000;

export async function startServer(opts?: { port?: number }): Promise<void> {
  const agentHome =
    process.env.AGENT_HOME ??
    join(process.env.HOME ?? "/root", ".shipwright-agent");

  // Bootstrap the agent home directory (idempotent — safe to call on every start)
  ensureAgentHome(agentHome);

  const { config } = createConfig(agentHome);

  // NOTE: The health server is NOT started here.
  // entrypoint-main.ts starts it in-process on SHIPWRIGHT_HEALTH_PORT before
  // spawning this file as a subprocess. Starting it again here would cause
  // EADDRINUSE — the parent process already holds the port for the pod lifetime.

  console.log(
    `[run-agent] starting agent ${config.shipwright.agentId ?? "(unset)"}`,
  );

  // ─── Config sync ────────────────────────────────────────────────────────────
  // Restore the 60s config-sync poll (see config-sync.ts). Without it the agent
  // only ever sees the entrypoint's one-shot config fetch, so config changes
  // made after startup — e.g. a newly-added GH_TOKEN — never reach the running
  // process. Disabled (logged) when the runtime API coordinates aren't all set.
  const { agentId, apiUrl, apiKey } = config.shipwright;
  if (apiUrl && apiKey && agentId) {
    await startConfigSync({
      source: new HttpShipwrightRuntimeClient({ apiUrl, apiKey }),
      agentId,
      defaultModel: config.claude.model,
    });
  } else {
    console.log(
      "[run-agent] config sync disabled — SHIPWRIGHT_API_URL / SHIPWRIGHT_AGENT_API_KEY / SHIPWRIGHT_AGENT_ID not all set",
    );
  }

  // ─── Dev-only chat transport ─────────────────────────────────────────────────
  // Read the gate ONCE at composition time. When on, construct a real Claude
  // runner; otherwise the route is never registered (DEFAULT-DENY).
  const devChat = process.env.SHIPWRIGHT_DEV_CHAT === "true";
  if (devChat) {
    const port = opts?.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
    const chatRunner = createRunClaude();
    console.warn(
      "[run-agent] SHIPWRIGHT_DEV_CHAT=true — dev /chat endpoint enabled (must NOT be used in production)",
    );
    const app = createComposedApp({ devChat, chatRunner });
    Bun.serve({ fetch: app.fetch, port });
    console.log(`[run-agent] chat server listening on port ${port}`);
  }
}

// Run directly when invoked as main entry
if (import.meta.main) {
  startServer().catch((err) => {
    console.error("[run-agent] fatal startup error:", err);
    process.exit(1);
  });
}
