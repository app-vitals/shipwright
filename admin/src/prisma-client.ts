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
 * Build the `pg.Pool` the admin service's Prisma client runs on.
 *
 * Split out of `createAdminPrismaClient` so the pool's own configuration — the
 * connect timeout and the mandatory `error` listener — is assertable without a
 * live database.
 */
export function createAdminPgPool(databaseUrl: string): pg.Pool {
  // Fail loudly on a missing connection string rather than booting against an
  // unintended database. `pg` only parses `connectionString` when it is truthy
  // (`if (config.connectionString) { ... }` in its ConnectionParameters), so a
  // blank value is silently dropped and `pg.Pool` falls back to
  // PGHOST/PGUSER/PGPASSWORD/PGDATABASE — or localhost:5432 as the OS user.
  // The process would then either talk to the wrong database or die later with
  // a bare `ECONNREFUSED 127.0.0.1:5432` that names no env var. Prisma 6's
  // `new PrismaClient()` threw `Environment variable not found:
  // DATABASE_URL_SHIPWRIGHT_ADMIN` immediately; this restores that.
  if (databaseUrl.trim() === "") {
    throw new Error(
      "DATABASE_URL_SHIPWRIGHT_ADMIN is not set — the admin service requires a Postgres connection string (postgresql://user:password@host:5432/database)",
    );
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
  });

  // Required, not diagnostic logging: `pg.Pool` re-emits backend/network errors
  // hit by *idle* clients as its own `error` event, and `Pool` is an
  // `EventEmitter` — an `error` event with no listener is rethrown as an
  // uncaught exception that kills the process. Prisma 6's Rust query engine
  // owned the pool and absorbed these; under Prisma 7 the pool is plain
  // application code, so admin now has to own it. The service sits behind Cloud
  // SQL / a proxy sidecar that drops idle connections, and `pg`'s default
  // `idleTimeoutMillis` keeps idle clients around long enough to be hit. The
  // pool discards the broken client on its own, so logging is the correct
  // response — the next checkout just opens a fresh connection.
  pool.on("error", (err) => {
    console.error("[admin] idle pg pool client error:", err);
  });

  return pool;
}

/**
 * Build an adapter-backed PrismaClient for the given Postgres connection string.
 *
 * `disposeExternalPool: true` is required, not cosmetic: the adapter leaves an
 * externally supplied pool open on dispose by default, so without it every
 * `prisma.$disconnect()` would leak its pool's sockets — which the integration
 * suites (a fresh client per `beforeEach`) would turn into connection
 * exhaustion within a single run.
 *
 * Note for BYO-Postgres operators: the connection string is parsed by `pg`, not
 * by Prisma's old query engine, so Prisma-only query params (`schema`,
 * `connection_limit`, `pool_timeout`, `pgbouncer`) are ignored at runtime and
 * `sslmode=require` now verifies the server certificate. See
 * `docs/migration.md` ("Breaking: admin's `DATABASE_URL_SHIPWRIGHT_ADMIN` is
 * now parsed by `pg`, not Prisma").
 */
export function createAdminPrismaClient(databaseUrl: string): PrismaClient {
  const pool = createAdminPgPool(databaseUrl);
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });
  return new PrismaClient({ adapter });
}
