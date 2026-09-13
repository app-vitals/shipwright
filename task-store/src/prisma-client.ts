/**
 * task-store/src/prisma-client.ts
 *
 * Single construction site for the task-store PrismaClient.
 *
 * Prisma 7 removed the Rust query engine's built-in connection handling: the
 * client no longer reads the datasource URL itself (the v6 `datasources`
 * constructor option is gone, and `datasource { url }` is gone from
 * schema.prisma), and instead requires a driver adapter. Here that's `PrismaPg`
 * over a `pg.Pool`.
 *
 * main.ts and every `*.integration.test.ts` go through this factory so the
 * adapter wiring — and its pool-lifecycle and timeout defaults — lives in
 * exactly one place.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../prisma/client/client.ts";

export { PrismaClient };

/**
 * Floor for `pg`'s `connectionTimeoutMillis`. Prisma 6's Rust engine applied a
 * 5s Postgres connect timeout by default; `pg` defaults to 0 (wait forever), so
 * without this an unreachable database hangs the caller instead of failing
 * fast — which in turn would hang GET /health/ready rather than reporting
 * not-ready. Restated explicitly to preserve the v6 behaviour.
 *
 * A configured `pool_timeout` can raise this (see `toPoolConfig`), never lower
 * it.
 */
export const CONNECT_TIMEOUT_MS = 5000;

/**
 * Prisma-specific connection-string parameters that `pg` does not understand.
 * They were interpreted by the v6 query engine; under the driver adapter they
 * have to be translated into `pg.PoolConfig` (or dropped) or `pg` forwards
 * them to Postgres as unknown startup parameters and the connection fails.
 */
const PRISMA_ONLY_PARAMS = ["connection_limit", "pool_timeout", "schema"];

/**
 * Splits a Prisma-style Postgres URL into a `pg`-safe connection string plus
 * the `pg.PoolConfig` overrides implied by the Prisma-only query parameters.
 *
 * Exported for unit testing — callers should use `createPrismaClient`.
 */
export function toPoolConfig(databaseUrl: string): pg.PoolConfig {
  const url = new URL(databaseUrl);
  const overrides: pg.PoolConfig = {};

  const connectionLimit = url.searchParams.get("connection_limit");
  if (connectionLimit !== null && Number.isFinite(Number(connectionLimit))) {
    overrides.max = Number(connectionLimit);
  }

  const schema = url.searchParams.get("schema");
  if (schema) overrides.options = `-c search_path=${schema}`;

  // `pool_timeout` (seconds) was v6's budget for waiting on a free pool slot,
  // independent of the connect timeout. `pg` has no separate acquire timeout:
  // pg-pool's `connect()` arms the same `connectionTimeoutMillis` timer on both
  // the "pool is full / queue behind an idle client" path and the "dial a new
  // client" path. A configured `pool_timeout` therefore widens that single
  // budget rather than being silently dropped — CI sets `pool_timeout=20`, and
  // on the server a webhook-carrying transaction can hold its pool connection
  // for up to `WEBHOOK_TX_TIMEOUT_MS` (10s, task-service.ts), longer than a
  // waiter capped at the 5s floor would tolerate.
  //
  // Deliberate divergence: v6 read `pool_timeout=0` as "wait forever". pg's
  // equivalent (`connectionTimeoutMillis: 0`) would apply to the connect path
  // too, so an unreachable database would hang GET /health/ready instead of
  // reporting not-ready. `0` — like a negative or non-numeric value — falls
  // back to the floor instead.
  const poolTimeout = url.searchParams.get("pool_timeout");
  const poolTimeoutMs =
    poolTimeout !== null && Number.isFinite(Number(poolTimeout))
      ? Number(poolTimeout) * 1000
      : 0;

  for (const param of PRISMA_ONLY_PARAMS) url.searchParams.delete(param);

  return {
    connectionString: url.toString(),
    connectionTimeoutMillis: Math.max(poolTimeoutMs, CONNECT_TIMEOUT_MS),
    ...overrides,
  };
}

/**
 * Builds an adapter-backed PrismaClient for the given Postgres URL.
 *
 * `disposeExternalPool` is on deliberately: `PrismaPg` defaults it to `false`,
 * meaning a caller-supplied pool outlives `prisma.$disconnect()`. The
 * integration suite builds and disconnects a client per test and the service
 * ends its client on graceful shutdown, both of which assume `$disconnect()`
 * actually releases the sockets — as it did in v6.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const pool = new pg.Pool(toPoolConfig(databaseUrl));
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });
  return new PrismaClient({ adapter });
}
