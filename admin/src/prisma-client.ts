/**
 * admin/src/prisma-client.ts
 *
 * Single place the admin service builds a PrismaClient.
 *
 * Prisma 7 removed the bundled query engine: a client no longer connects off
 * `datasource.url` by itself, it needs a driver adapter. Admin talks to
 * Postgres, so every client is a `PrismaPg` adapter wrapping a `pg.Pool`.
 * Keeping that in one factory means the runtime (main.ts), the dev/CI scripts,
 * and the integration suites all get the same pool tuning instead of each
 * re-deriving it.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../prisma/client/client.ts";

/**
 * Connect timeout for a pooled Postgres connection.
 *
 * Prisma 6 applied an implicit 5s connect timeout for Postgres; Prisma 7's
 * driver adapters do not, and `pg.Pool` defaults to waiting forever. Without an
 * explicit value an unreachable database would hang the boot preflight (and
 * every request) instead of failing fast, so this restores bounded behavior.
 * Slightly above the old 5s to stay tolerant of a cold Cloud SQL connection.
 */
export const DB_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Build an adapter-backed PrismaClient for the given Postgres connection string.
 *
 * `disposeExternalPool: true` is required, not cosmetic: the adapter leaves an
 * externally supplied pool open on dispose by default, so without it every
 * `prisma.$disconnect()` would leak its pool's sockets — which the integration
 * suites (a fresh client per `beforeEach`) would turn into connection
 * exhaustion within a single run.
 */
export function createAdminPrismaClient(databaseUrl: string): PrismaClient {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
  });
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });
  return new PrismaClient({ adapter });
}
