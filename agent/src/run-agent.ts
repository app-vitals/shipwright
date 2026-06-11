/**
 * agent/src/run-agent.ts
 *
 * Thin agent server — health + /agents/* proxy only.
 *
 * Called by entrypoint.ts after all environment setup is complete.
 * Exports createComposedApp(deps) for testing and startServer() for programmatic use.
 * Runs startServer() directly when executed as the main entry (bun run run-agent.ts).
 *
 * The admin routes (/agents/:id/* CRUD and /admin/* UI) are now served by the standalone
 * admin service (admin/src/main.ts). The /agents/* endpoint proxies transparently
 * to the admin service via SHIPWRIGHT_API_URL.
 *
 * Route mount order:
 *   GET  /health     — health check (no auth)
 *   *    /agents/*   — transparent proxy to admin service (preserves all headers)
 */

import { join } from "node:path";
import { Hono } from "hono";
import type { ChatRunner } from "./chat.ts";
import { createChatApp } from "./chat.ts";
import { createRunClaude } from "./claude.ts";
import { createConfig } from "./config.ts";
import { createHealthApp } from "./health.ts";
import { ensureAgentHome } from "./setup.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * All dependencies the composed app needs.
 * Provided by startServer() for production; injected as doubles in tests.
 */
export interface ComposedAppDeps {
  /** Base URL of the standalone admin service (e.g. https://admin.example.com) */
  adminApiUrl: string;
  /**
   * Fetch implementation for proxying requests to the admin service.
   * Defaults to the global fetch. Inject a mock in tests.
   */
  fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
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
 * Composes the thin agent app: health check + /agents/* proxy + optional /chat.
 *
 * The /agents/* handler is a transparent proxy to the standalone admin service.
 * All headers (including Authorization) are forwarded as-is so the admin service
 * can enforce Bearer auth without the agent duplicating that logic.
 *
 * Accepts injected deps so tests can pass a mock fetchFn without touching real network.
 */
export function createComposedApp(deps: ComposedAppDeps): Hono {
  const { adminApiUrl, fetchFn = fetch, devChat, chatRunner } = deps;

  const root = new Hono();

  // 1. Health check — no auth, mounted at root
  root.route("/", createHealthApp());

  // 2. Dev-only chat transport — DEFAULT-DENY. Only registered when devChat
  //    is true AND a runner is provided; otherwise POST /chat 404s.
  if (devChat && chatRunner) {
    root.route("/", createChatApp({ runner: chatRunner }));
  }

  // 3. /agents/* — transparent proxy to the standalone admin service.
  //    When Hono routes to agentsProxy, c.req.path is the path AFTER the
  //    /agents prefix is stripped (e.g. "/:id/config"). We reconstruct the
  //    full upstream path as /agents + c.req.path.
  const agentsProxy = new Hono();
  agentsProxy.all("/*", async (c) => {
    const targetUrl = `${adminApiUrl}/agents${c.req.path}`;
    const proxyReq = new Request(targetUrl, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    });
    const response = await fetchFn(proxyReq);
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  });
  root.route("/agents", agentsProxy);

  return root;
}

// ─── Server entry ─────────────────────────────────────────────────────────────

const DEFAULT_PORT = 3000;

export async function startServer(opts?: { port?: number }): Promise<void> {
  const port = opts?.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const agentHome =
    process.env.AGENT_HOME ??
    join(process.env.HOME ?? "/root", ".shipwright-agent");

  // Bootstrap the agent home directory (idempotent — safe to call on every start)
  ensureAgentHome(agentHome);

  const { config } = createConfig(agentHome);

  console.log(
    `[run-agent] starting agent ${config.shipwright.agentId ?? "(unset)"} on port ${port}`,
  );

  const adminApiUrl = process.env.SHIPWRIGHT_API_URL ?? "";

  // Dev-only chat transport: read the gate ONCE at composition time. When on,
  // construct a real Claude runner; otherwise the route is never registered.
  const devChat = process.env.SHIPWRIGHT_DEV_CHAT === "true";
  const chatRunner = devChat ? createRunClaude() : undefined;
  if (devChat) {
    console.warn(
      "[run-agent] SHIPWRIGHT_DEV_CHAT=true — dev /chat endpoint enabled (must NOT be used in production)",
    );
  }

  const app = createComposedApp({ adminApiUrl, devChat, chatRunner });

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
