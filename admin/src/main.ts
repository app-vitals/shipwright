/**
 * admin/src/main.ts
 *
 * Standalone admin service entrypoint.
 * Runs migrations, creates services, and mounts all admin + runtime routes.
 *
 * Route mount order (important — avoids shadowing):
 *   GET  /health                 — health check (no auth)
 *   *    /agents/*               — runtime API  (Bearer SHIPWRIGHT_INTERNAL_API_KEY)
 *   *    /admin/api/*            — admin CRUD API (session JWT) — MUST be before /admin/*
 *   *    /admin/*                — admin UI       (session JWT)
 */

import { join } from "node:path";
import { Hono } from "hono";
import { PrismaClient } from "../prisma/client/index.js";
import { createAdminApp } from "./admin-api.ts";
import { createAdminUIApp } from "./admin-ui.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { AgentEnvService } from "./agent-envs.ts";
import { AgentPluginService } from "./agent-plugins.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import { AgentToolService } from "./agent-tools.ts";
import { createAgentRuntimeApp } from "./api.ts";
import { isDevAuthAllowed } from "./dev-auth-guard.ts";
import { HttpGoogleAuthClient } from "./google-auth-client.ts";
import { HttpSlackProvisioningClient } from "./slack-provisioning-client.ts";
import { makeTokenCrypto } from "./token-crypto.ts";

// ─── Migration preflight ──────────────────────────────────────────────────────

/**
 * Runs `prisma migrate deploy` as a boot preflight.
 * Idempotent — safe to call on every startup. Throws on migration failure.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_SHIPWRIGHT_ADMIN;
  if (!databaseUrl) {
    console.warn(
      "[admin] DATABASE_URL_SHIPWRIGHT_ADMIN not set — skipping prisma migrate deploy",
    );
    return;
  }

  console.log("[admin] running prisma migrate deploy...");

  const proc = Bun.spawn(
    ["bunx", "prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, DATABASE_URL_SHIPWRIGHT_ADMIN: databaseUrl },
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
    console.error("[admin] prisma migrate deploy failed:");
    console.error(stderr);
    throw new Error(`prisma migrate deploy exited with code ${proc.exitCode}`);
  }

  if (stdout.trim()) {
    console.log("[admin]", stdout.trim());
  }

  console.log("[admin] migrations complete");
}

// ─── Server entry ─────────────────────────────────────────────────────────────

const DEFAULT_PORT = 3000;

async function startServer(): Promise<void> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);

  console.log(`[admin] starting admin service on port ${port}`);

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
  const googleClientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  const adminAllowedEmails = (process.env.SHIPWRIGHT_ADMIN_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const appBaseUrl =
    process.env.SHIPWRIGHT_ADMIN_APP_BASE_URL ?? `http://localhost:${port}`;

  const googleClient = new HttpGoogleAuthClient();
  const slackClient = new HttpSlackProvisioningClient();

  const root = new Hono();

  // 1. Health check — no auth
  root.get("/health", (c) => c.json({ status: "ok" }));

  // 2. Runtime API — Bearer SHIPWRIGHT_INTERNAL_API_KEY
  //    Mounted via a shim to scope the Bearer auth middleware to /agents/* only.
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
    googleClientId,
    googleClientSecret,
    adminAllowedEmails,
    googleClient,
    slackClient,
    appBaseUrl,
    devAuthEnabled: isDevAuthAllowed(process.env),
  });
  root.route("/", adminUIApp);

  Bun.serve({ fetch: root.fetch, port });

  console.log(`[admin] admin service listening on port ${port}`);
}

// Run directly when invoked as main entry
if (import.meta.main) {
  startServer().catch((err) => {
    console.error("[admin] fatal startup error:", err);
    process.exit(1);
  });
}
