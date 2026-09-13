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

export interface PrismaClientOptions {
  /** Overrides {@link DEFAULT_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
}

/**
 * Builds an adapter-backed PrismaClient for `databaseUrl`.
 *
 * The pool is created here and handed to `PrismaPg` with
 * `disposeExternalPool`, so `prisma.$disconnect()` tears down the pool too and
 * callers keep a single lifecycle handle.
 */
export function createPrismaClient(
  databaseUrl: string,
  options: PrismaClientOptions = {},
): PrismaClient {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis:
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  });

  const adapter = new PrismaPg(pool, { disposeExternalPool: true });

  return new PrismaClient({ adapter });
}
