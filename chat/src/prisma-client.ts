/**
 * chat/src/prisma-client.ts
 *
 * Single construction site for the chat service's PrismaClient.
 *
 * Prisma 7 dropped the Rust query engine: `new PrismaClient()` and
 * `new PrismaClient({ datasources })` no longer exist, and every client must be
 * handed a driver adapter that owns the actual connection. Here that adapter is
 * `PrismaPg` over a `pg.Pool`, so this factory is the one place that turns a
 * connection string into a working client — the service entry point and the
 * integration suites all go through it.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../prisma/client/client.ts";

/**
 * Connect timeout applied to the underlying `pg.Pool`.
 *
 * Driver adapters inherit the driver's own pool defaults, and `pg` waits
 * forever (0) for a connection by default — Prisma 6's engine used 5s. Keeping
 * 5s preserves the pre-upgrade behaviour: a wedged/unreachable Postgres surfaces
 * as a fast error instead of a request that hangs until the client gives up.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/** Default sink for idle-client pool errors. */
function logIdlePoolError(err: unknown): void {
  console.error("[chat] idle pg pool client error:", err);
}

/**
 * Builds the chat service's `pg.Pool`.
 *
 * `pg.Pool` is an EventEmitter that re-emits errors raised by *idle* pooled
 * clients (a Postgres restart/failover or an idle-connection timeout), and an
 * unhandled `error` event on an EventEmitter throws — which would take down
 * this long-lived service instead of just failing the in-flight query. Prisma
 * 6's Rust engine absorbed connection loss internally, so the listener below
 * restores that behaviour: node-postgres already evicts the broken client from
 * the pool, so logging is enough and the next query re-connects.
 *
 * `logError` is injectable so the listener can be exercised without a real
 * Postgres failure.
 */
export function createChatPool(
  databaseUrl: string,
  logError: (err: unknown) => void = logIdlePoolError,
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: DEFAULT_CONNECT_TIMEOUT_MS,
  });

  pool.on("error", logError);

  return pool;
}

/**
 * Builds an adapter-backed PrismaClient for `databaseUrl`.
 *
 * The pool is created here and handed to `PrismaPg` with
 * `disposeExternalPool`, so `prisma.$disconnect()` tears down the pool too and
 * callers keep a single lifecycle handle.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg(createChatPool(databaseUrl), {
    disposeExternalPool: true,
  });

  return new PrismaClient({ adapter });
}
