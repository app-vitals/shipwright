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
import * as Sentry from "@sentry/bun";
import { registerGracefulShutdown } from "@shipwright/lib/graceful-shutdown";
import { initSentry } from "@shipwright/lib/sentry";
import { createTaskStoreApp } from "./app.ts";
import { createScopeResolver } from "./auth.ts";
import { checkClaimTtlBuffer } from "./claim-ttl-buffer-check.ts";
import { PrismaClient } from "./index.ts";
import { PullRequestService } from "./pull-request-service.ts";
import { SessionRetentionReaper } from "./session-retention-reaper.ts";
import { SessionService } from "./session-service.ts";
import { StaleClaimReaper } from "./stale-claim-reaper.ts";
import { TaskService } from "./task-service.ts";
import { TaskTokenService } from "./token-service.ts";
import { createWebhookDispatcher } from "./webhook-dispatcher.ts";

const DEFAULT_PORT = 3000;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5000;

// ─── Readiness check ──────────────────────────────────────────────────────────

/**
 * DB-aware readiness check backing GET /health/ready. Runs a lightweight
 * `SELECT 1` and reports whether Postgres is actually reachable — unlike
 * GET /health (liveness), which stays DB-independent so a transient DB blip
 * never triggers a liveness-driven pod restart. Takes only the `$queryRaw`
 * slice of PrismaClient so it's unit-testable with a mocked/injected client,
 * no real I/O.
 */
export async function checkDbReady(prisma: {
  $queryRaw: (
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown>;
}): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

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
  // Initializes Sentry (no-op when SENTRY_DSN is unset) so that startup
  // failures below (e.g. a failed migration) are captured too. When
  // SENTRY_DSN is set, `createTaskStoreApp` mounts `@sentry/hono`'s `sentry()`
  // middleware, which performs its own equivalent `Sentry.init` call using
  // the same options (see `buildSentryInitOptions`) — Sentry's own guidance
  // is that the Hono middleware should be the sole init site, but initializing
  // here first means boot-time errors before the app exists are still
  // reported, and re-initializing with identical options in app.ts is a safe
  // no-op (same client config, no drift).
  initSentry({ service: "task-store" });

  const port = Number(process.env.PORT ?? DEFAULT_PORT);

  console.log(`[task-store] starting service on port ${port}`);

  await runMigrations();

  const prisma = new PrismaClient();

  // Build the outbound event dispatcher when a webhook URL is configured.
  // createWebhookDispatcher itself returns a no-op when the URL is unset, so
  // this can be constructed unconditionally and passed straight into
  // TaskService — no branching on config presence at any call site.
  const webhookUrl = process.env.SHIPWRIGHT_TASK_STORE_WEBHOOK_URL;
  const webhookToken = process.env.SHIPWRIGHT_TASK_STORE_WEBHOOK_TOKEN;
  const webhookTimeoutMs = Number(
    process.env.SHIPWRIGHT_TASK_STORE_WEBHOOK_TIMEOUT_MS ??
      DEFAULT_WEBHOOK_TIMEOUT_MS,
  );
  const webhookDispatcher = createWebhookDispatcher(
    webhookUrl,
    webhookToken,
    webhookTimeoutMs,
  );

  if (webhookUrl) {
    console.log(`[task-store] webhook dispatcher configured (${webhookUrl})`);
  } else {
    console.log(
      "[task-store] webhook dispatcher disabled (SHIPWRIGHT_TASK_STORE_WEBHOOK_URL not set)",
    );
  }

  const taskService = new TaskService(prisma, undefined, webhookDispatcher);
  const tokenService = new TaskTokenService(prisma);
  const pullRequestService = new PullRequestService(prisma);
  const sessionService = new SessionService(prisma, undefined, (pairs) =>
    pullRequestService.lookupBlockedPrNumbers(pairs),
  );

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

  // Reassigned below, after Bun.serve() + registerGracefulShutdown() run —
  // the checkDbReady closure below only calls this at request time (well
  // after startServer() finishes its synchronous setup), so it always sees
  // the real graceful-shutdown flag once one exists.
  let isShuttingDown = (): boolean => false;

  const app = createTaskStoreApp({
    taskService,
    tokenService,
    pullRequestService,
    sessionService,
    scopeResolver,
    sentryClient: process.env.SENTRY_DSN ? Sentry : undefined,
    // Once a shutdown signal has been received, fail readiness immediately
    // (no DB round-trip) so Kubernetes pulls this pod from Service endpoints
    // as early as possible — see lib/graceful-shutdown.ts.
    checkDbReady: () =>
      isShuttingDown() ? Promise.resolve(false) : checkDbReady(prisma),
  });

  const reaper = new StaleClaimReaper(prisma);

  // Opt-in sanity check: task-store and the agent are separate deployables
  // with independent env surfaces, so task-store can't read the agent's
  // SHIPWRIGHT_CLAUDE_TIMEOUT_MS directly. If an operator also sets it here
  // (a second copy of the same value, not new cross-service coupling), warn
  // when the resolved claim TTL doesn't leave enough headroom over it. In an
  // N:1 fleet (many agents sharing one task-store), use the MAX
  // SHIPWRIGHT_CLAUDE_TIMEOUT_MS across all agents, not any single agent's
  // value.
  const rawClaudeTimeoutMs = process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS;
  const parsedClaudeTimeoutMs = rawClaudeTimeoutMs
    ? Number(rawClaudeTimeoutMs)
    : undefined;
  const claudeTimeoutMs = Number.isFinite(parsedClaudeTimeoutMs)
    ? parsedClaudeTimeoutMs
    : undefined;
  const ttlBufferWarning = checkClaimTtlBuffer(reaper.ttlMs, claudeTimeoutMs);
  if (ttlBufferWarning) {
    console.warn(ttlBufferWarning);
  }

  setInterval(() => {
    reaper.reap().catch((err) => {
      console.error("[stale-claim-reaper] reap error:", err);
    });
  }, 60_000);
  console.log("[task-store] stale-claim reaper started (interval: 60s)");

  // Reuses the single `sessionService` constructed above (which also backs the
  // app's blocked-PR lookup) rather than building a second instance — one
  // SessionService per process, shared by the HTTP surface and this sweep.
  const sessionRetentionReaper = new SessionRetentionReaper(
    prisma,
    sessionService,
  );

  if (sessionRetentionReaper.archiveAfterDays === 0) {
    console.log(
      "[task-store] session-retention reaper disabled (SHIPWRIGHT_TASK_STORE_SESSION_ARCHIVE_AFTER_DAYS=0)",
    );
  } else {
    setInterval(() => {
      sessionRetentionReaper.sweep().catch((err) => {
        console.error("[session-retention-reaper] sweep error:", err);
      });
    }, 3_600_000);
    console.log("[task-store] session-retention reaper started (interval: 1h)");
  }

  const server = Bun.serve({ port, fetch: app.fetch });

  const shutdown = registerGracefulShutdown({
    server,
    cleanup: [() => prisma.$disconnect()],
    serviceName: "task-store",
  });
  isShuttingDown = shutdown.isShuttingDown;

  console.log(`[task-store] listening on http://localhost:${server.port}`);
}

// Run directly when invoked as main entry
if (import.meta.main) {
  startServer().catch((err) => {
    console.error("[task-store] fatal startup error:", err);
    process.exit(1);
  });
}
