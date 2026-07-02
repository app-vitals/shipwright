/**
 * chat/src/main.ts
 *
 * HTTP entry point for the Shipwright chat service.
 *
 * Boot sequence:
 *   1. Run `prisma migrate deploy` as an idempotent preflight.
 *   2. Construct PrismaClient + ChatTokenService.
 *   3. Compose the Hono app and serve it via Bun.serve.
 *
 * DB: DATABASE_URL_SHIPWRIGHT_CHAT (dedicated database — never shared).
 */

import { join } from "node:path";
import { createChatServiceApp } from "./app.ts";
import { createScopeResolver } from "./auth.ts";
import { PrismaClient } from "./index.ts";
import { MessageService } from "./message-service.ts";
import { ThreadService } from "./thread-service.ts";
import { ChatTokenService } from "./token-service.ts";

const DEFAULT_PORT = 3000;

// ─── Migration preflight ──────────────────────────────────────────────────────

/**
 * Runs `prisma migrate deploy` as a boot preflight. Idempotent — safe on every
 * startup. Throws on migration failure so a broken schema fails fast rather than
 * serving against an unmigrated database.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_SHIPWRIGHT_CHAT;
  if (!databaseUrl) {
    console.warn(
      "[chat] DATABASE_URL_SHIPWRIGHT_CHAT not set — skipping prisma migrate deploy",
    );
    return;
  }

  console.log("[chat] running prisma migrate deploy...");

  const proc = Bun.spawn(
    ["bunx", "prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, DATABASE_URL_SHIPWRIGHT_CHAT: databaseUrl },
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
    console.error("[chat] prisma migrate deploy failed:");
    console.error(stderr);
    throw new Error(`prisma migrate deploy exited with code ${proc.exitCode}`);
  }

  if (stdout.trim()) console.log("[chat]", stdout.trim());
  console.log("[chat] migrations complete");
}

// ─── Server entry ─────────────────────────────────────────────────────────────

async function startServer(): Promise<void> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);

  console.log(`[chat] starting service on port ${port}`);

  await runMigrations();

  const prisma = new PrismaClient();
  const tokenService = new ChatTokenService(prisma);
  const threadService = new ThreadService(prisma);
  const messageService = new MessageService(prisma);

  const seedToken = process.env.CHAT_SEED_ADMIN_TOKEN;
  if (seedToken) {
    await tokenService.seed(seedToken);
    console.log("[chat] admin seed token upserted");
  }

  // Build scope resolver when agents service URL is configured.
  const agentsServiceUrl = process.env.SHIPWRIGHT_CHAT_AGENTS_URL;
  const agentsServiceApiKey = process.env.SHIPWRIGHT_CHAT_AGENTS_API_KEY;
  const scopeResolver =
    agentsServiceUrl && agentsServiceApiKey
      ? createScopeResolver(agentsServiceUrl, agentsServiceApiKey)
      : undefined;

  if (scopeResolver) {
    console.log(`[chat] scope resolver configured (${agentsServiceUrl})`);
  } else {
    console.log(
      "[chat] scope resolver disabled (SHIPWRIGHT_CHAT_AGENTS_URL not set)",
    );
  }

  const app = createChatServiceApp({
    tokenService,
    threadService,
    messageService,
    scopeResolver,
  });

  const server = Bun.serve({ port, fetch: app.fetch });
  console.log(`[chat] listening on http://localhost:${server.port}`);
}

startServer().catch((err) => {
  console.error("[chat] fatal startup error:", err);
  process.exit(1);
});
