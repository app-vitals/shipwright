/**
 * agent/src/run-agent.ts
 *
 * Bootstraps and starts the Shipwright agent Hono server.
 *
 * Called by entrypoint.ts after all environment setup is complete.
 * Exports createComposedApp(deps) for testing and startServer() for programmatic use.
 * Runs startServer() directly when executed as the main entry (bun run run-agent.ts).
 *
 * Route mount order (important — avoids shadowing):
 *   GET  /health                 — health check (no auth)
 *   *    /agents/*               — runtime API  (Bearer SHIPWRIGHT_INTERNAL_API_KEY)
 *   *    /admin/api/*            — admin CRUD API (session JWT) — MUST be before /admin/*
 *   *    /admin/*                — admin UI       (session JWT)
 */

import { join } from "node:path";
import { Hono } from "hono";
import {
  createAdminApp,
  createAdminUIApp,
  createAgentRuntimeApp,
  AgentCronJobService,
  AgentEnvService,
  AgentPluginService,
  AgentTokenService,
  AgentToolService,
  makeTokenCrypto,
  PrismaClient,
  HttpSlackProvisioningClient,
} from "@shipwright/admin";
import type { AdminUIDeps } from "@shipwright/admin";
import { createChatApp } from "./chat.ts";
import type { Runner } from "./chat.ts";
import { createConfig } from "./config.ts";
import { createHealthApp } from "./health.ts";
import { ensureAgentHome } from "./setup.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal Prisma interface needed by the composed app.
 * Matches what admin-ui.ts and api.ts expect (PrismaLike shapes).
 */
export interface PrismaLike {
  agent: {
    findUnique(args: { where: { id: string } }): Promise<{
      id: string;
      name: string;
      slackId: string | null;
      createdAt: Date;
      updatedAt: Date;
    } | null>;
    findMany(args?: object): Promise<
      Array<{
        id: string;
        name: string;
        slackId: string | null;
        createdAt: Date;
        updatedAt?: Date;
      }>
    >;
    create(args: {
      data: { name: string; slackId?: string | null };
    }): Promise<{
      id: string;
      name: string;
      slackId: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>;
  };
  agentPlugin: {
    findMany(args: {
      where: { agentId: string; enabled: boolean };
    }): Promise<
      Array<{
        id: string;
        name: string;
        version: string | null;
        enabled: boolean;
      }>
    >;
  };
}

/**
 * All dependencies the composed app needs.
 * Provided by startServer() for production; injected as doubles in tests.
 */
export interface ComposedAppDeps {
  prisma: PrismaLike;
  agentEnvService: Pick<
    AgentEnvService,
    "getConfigBundle" | "getByAgentId" | "upsert" | "patch" | "deleteKey"
  >;
  agentCronJobService: Pick<
    AgentCronJobService,
    | "list"
    | "create"
    | "update"
    | "delete"
    | "reconcileSystemCrons"
    | "get"
    | "setEnabled"
  >;
  agentToolService: Pick<
    AgentToolService,
    "list" | "add" | "remove" | "toggle"
  >;
  agentTokenService: Pick<
    AgentTokenService,
    "create" | "listForAgent" | "revoke"
  >;
  agentPluginService: Pick<
    AgentPluginService,
    "list" | "add" | "remove" | "removeByName"
  >;
  internalApiKey: string;
  sessionSecret: string;
  adminPassword: string;
  slackClient: AdminUIDeps["slackClient"];
  appBaseUrl: string;
  /**
   * Enable the dev-only POST /chat endpoint.
   * Read once from SHIPWRIGHT_DEV_CHAT === "true" in startServer().
   * Default: false (route not registered).
   */
  devChat?: boolean;
  /**
   * Runner injected when devChat is true.
   * Required if devChat is true; ignored otherwise.
   */
  runner?: Runner;
}

// ─── App factory ──────────────────────────────────────────────────────────────

/**
 * Composes all sub-apps into a single Hono root app.
 *
 * Mount order matters — /admin/api/* (admin CRUD API) must be mounted
 * BEFORE /admin/* (admin UI) so the JSON API routes are not shadowed by the
 * broader HTML catch-all routes in admin-ui.ts.
 *
 * The runtime API (api.ts) uses app.use("*", ...) for Bearer auth, which
 * would intercept all routes if mounted at root via route("/", ...). To avoid
 * this, the runtime API is gated behind an /agents/* middleware guard at the
 * root level, and the sub-app handles internal path matching.
 *
 * Accepts injected deps so tests can pass doubles without touching real DB or network.
 */
export function createComposedApp(deps: ComposedAppDeps): Hono {
  const {
    prisma,
    agentEnvService,
    agentCronJobService,
    agentToolService,
    agentTokenService,
    agentPluginService,
    internalApiKey,
    sessionSecret,
    adminPassword,
    slackClient,
    appBaseUrl,
    devChat,
    runner,
  } = deps;

  const root = new Hono();

  // 0. Dev chat endpoint — only when devChat is explicitly enabled.
  //    Mounted first so POST /chat is not shadowed by any catch-all routes.
  if (devChat === true && runner !== undefined) {
    const chatApp = createChatApp({ runner });
    root.route("/", chatApp);
  }

  // 1. Health check — no auth, mounted at root
  const healthApp = createHealthApp();
  root.route("/", healthApp);

  // 2. Runtime API — Bearer SHIPWRIGHT_INTERNAL_API_KEY
  //
  //    createAgentRuntimeApp uses app.use("*", ...) for Bearer auth — a guard
  //    that runs on every request reaching that sub-app. Mounting it at root
  //    via route("/", runtimeApp) would cause the "use *" middleware to intercept
  //    ALL requests (including /health, /admin/*) and return 401.
  //
  //    To scope it, we mount a thin agentsShim at /agents. The shim matches
  //    any /agents/* request at the root level and forwards the raw request to
  //    runtimeApp (which expects full paths like /agents/:id/config). Hono
  //    preserves the full URL in the raw Request, so path matching inside
  //    runtimeApp works correctly without any prefix rewriting.
  const runtimeApp = createAgentRuntimeApp({
    agentEnvService,
    agentCronJobService,
    prisma: prisma as never,
    internalApiKey,
  });

  const agentsShim = new Hono();
  agentsShim.all("/*", async (c) => runtimeApp.fetch(c.req.raw, c.env));

  root.route("/agents", agentsShim);

  // 3. Admin CRUD API — /admin/api/* — session JWT
  //    MUST be mounted before admin-ui (/admin/*) to avoid shadowing.
  const adminApiApp = createAdminApp({
    agentEnvService,
    agentCronJobService,
    agentToolService,
    agentTokenService,
    agentPluginService,
    sessionSecret,
  });
  root.route("/", adminApiApp);

  // 4. Admin UI — /admin/* — session JWT
  const adminUIApp = createAdminUIApp({
    prisma: prisma as never,
    agentEnvService,
    agentCronJobService,
    agentToolService,
    agentTokenService,
    agentPluginService,
    sessionSecret,
    adminPassword,
    slackClient,
    appBaseUrl,
  });
  root.route("/", adminUIApp);

  return root;
}

// ─── Migration preflight ──────────────────────────────────────────────────────

/**
 * Runs `prisma migrate deploy` as a boot preflight.
 * Idempotent — safe to call on every startup. Throws on migration failure.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_AGENT;
  if (!databaseUrl) {
    console.warn(
      "[run-agent] DATABASE_URL_AGENT not set — skipping prisma migrate deploy",
    );
    return;
  }

  console.log("[run-agent] running prisma migrate deploy...");

  const proc = Bun.spawn(
    ["bunx", "prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, DATABASE_URL_AGENT: databaseUrl },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  await proc.exited;

  if (proc.exitCode !== 0) {
    console.error("[run-agent] prisma migrate deploy failed:");
    console.error(stderr);
    throw new Error(`prisma migrate deploy exited with code ${proc.exitCode}`);
  }

  if (stdout.trim()) {
    console.log("[run-agent]", stdout.trim());
  }

  console.log("[run-agent] migrations complete");
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

  // Run DB migrations as idempotent preflight
  await runMigrations();

  // Construct PrismaClient once at boot
  const prisma = new PrismaClient();

  // Construct TokenCrypto — reads SHIPWRIGHT_ENCRYPTION_KEY at call time
  const crypto = makeTokenCrypto();

  // Construct all services with injected deps
  const agentEnvService = new AgentEnvService(prisma, crypto);
  const agentCronJobService = new AgentCronJobService(prisma);
  const agentToolService = new AgentToolService(prisma);
  const agentTokenService = new AgentTokenService(prisma);
  const agentPluginService = new AgentPluginService(prisma);

  // Read config values at call time (no module-level env reads)
  const internalApiKey = process.env.SHIPWRIGHT_INTERNAL_API_KEY ?? "";
  const sessionSecret = process.env.SHIPWRIGHT_SESSION_SECRET ?? "";
  const adminPassword = process.env.SHIPWRIGHT_ADMIN_PASSWORD ?? "";
  const appBaseUrl = process.env.APP_BASE_URL ?? `http://localhost:${port}`;

  // Dev chat endpoint — gated by SHIPWRIGHT_DEV_CHAT. Read once here; never
  // read inline in route handlers (composition option, not runtime env read).
  const devChat = process.env.SHIPWRIGHT_DEV_CHAT === "true";

  const slackClient = new HttpSlackProvisioningClient();

  // Build the runner for the dev chat endpoint (only wired when devChat is true).
  // Pass an in-memory sessions store so Claude sessions are resumed across calls.
  let chatRunner: Runner | undefined;
  if (devChat) {
    const { createRunClaude } = await import("./claude.ts");
    const chatSessionMap = new Map<string, string>();
    chatRunner = createRunClaude(undefined, {
      get: (key) => chatSessionMap.get(key),
      set: (key, id) => { chatSessionMap.set(key, id); },
    });
  }

  const app = createComposedApp({
    prisma,
    agentEnvService,
    agentCronJobService,
    agentToolService,
    agentTokenService,
    agentPluginService,
    internalApiKey,
    sessionSecret,
    adminPassword,
    slackClient,
    appBaseUrl,
    devChat,
    runner: chatRunner,
  });

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
