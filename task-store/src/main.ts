/**
 * task-store/src/main.ts
 *
 * HTTP entry point for the Shipwright task-store service.
 *
 * Boot sequence:
 *   1. Run `prisma migrate deploy` as an idempotent preflight.
 *   2. Construct PrismaClient + TaskService + TaskTokenService.
 *   3. Compose the Hono app and serve it via Bun.serve.
 *
 * DB: DATABASE_URL_SHIPWRIGHT_TASK_STORE (dedicated database — never shared).
 */

import { join } from "node:path";
import { createTaskStoreApp } from "./app.ts";
import { createScopeResolver } from "./auth.ts";
import { PrismaClient } from "./index.ts";
import { PullRequestService } from "./pull-request-service.ts";
import { StaleClaimReaper } from "./stale-claim-reaper.ts";
import { TaskService } from "./task-service.ts";
import { TaskTokenService } from "./token-service.ts";

const DEFAULT_PORT = 3000;

// ─── Migration preflight ──────────────────────────────────────────────────────

/**
 * Runs `prisma migrate deploy` as a boot preflight. Idempotent — safe on every
 * startup. Throws on migration failure so a broken schema fails fast rather than
 * serving against an unmigrated database.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE;
  if (!databaseUrl) {
    console.warn(
      "[task-store] DATABASE_URL_SHIPWRIGHT_TASK_STORE not set — skipping prisma migrate deploy",
    );
    return;
  }

  console.log("[task-store] running prisma migrate deploy...");

  const proc = Bun.spawn(
    ["bunx", "prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, DATABASE_URL_SHIPWRIGHT_TASK_STORE: databaseUrl },
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
    console.error("[task-store] prisma migrate deploy failed:");
    console.error(stderr);
    throw new Error(`prisma migrate deploy exited with code ${proc.exitCode}`);
  }

  if (stdout.trim()) console.log("[task-store]", stdout.trim());
  console.log("[task-store] migrations complete");
}

// ─── Server entry ─────────────────────────────────────────────────────────────

async function startServer(): Promise<void> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);

  console.log(`[task-store] starting service on port ${port}`);

  await runMigrations();

  const prisma = new PrismaClient();
  const taskService = new TaskService(prisma);
  const tokenService = new TaskTokenService(prisma);
  const pullRequestService = new PullRequestService(prisma);

  const seedToken = process.env.TASK_STORE_SEED_ADMIN_TOKEN;
  if (seedToken) {
    await tokenService.seed(seedToken);
    console.log("[task-store] admin seed token upserted");
  }

  // Build scope resolver when agents service URL is configured.
  const agentsServiceUrl = process.env.SHIPWRIGHT_TASK_STORE_AGENTS_URL;
  const agentsServiceApiKey = process.env.SHIPWRIGHT_TASK_STORE_AGENTS_API_KEY;
  const scopeResolver =
    agentsServiceUrl && agentsServiceApiKey
      ? createScopeResolver(agentsServiceUrl, agentsServiceApiKey)
      : undefined;

  if (scopeResolver) {
    console.log(`[task-store] scope resolver configured (${agentsServiceUrl})`);
  } else {
    console.log(
      "[task-store] scope resolver disabled (SHIPWRIGHT_TASK_STORE_AGENTS_URL not set)",
    );
  }

  const app = createTaskStoreApp({
    taskService,
    tokenService,
    pullRequestService,
    scopeResolver,
  });

  const reaper = new StaleClaimReaper(prisma);
  setInterval(() => {
    reaper.reap().catch((err) => {
      console.error("[stale-claim-reaper] reap error:", err);
    });
  }, 60_000);
  console.log("[task-store] stale-claim reaper started (interval: 60s)");

  const server = Bun.serve({ port, fetch: app.fetch });
  console.log(`[task-store] listening on http://localhost:${server.port}`);
}

startServer().catch((err) => {
  console.error("[task-store] fatal startup error:", err);
  process.exit(1);
});
