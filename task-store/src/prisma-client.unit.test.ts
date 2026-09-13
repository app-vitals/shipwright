/**
 * task-store/src/prisma-client.unit.test.ts
 *
 * Unit tests for `toPoolConfig` — the pure URL→`pg.PoolConfig` translation that
 * replaces Prisma 6's Rust-engine handling of Prisma-only connection-string
 * parameters. No I/O: it parses a URL, coerces numbers and builds a search_path.
 *
 * What matters here is that every Prisma-only parameter is either translated
 * into a `pg.PoolConfig` field or dropped from the connection string — anything
 * left in the URL is forwarded to Postgres as an unknown startup parameter and
 * the connection fails.
 */

import { describe, expect, test } from "bun:test";
import { CONNECT_TIMEOUT_MS, toPoolConfig } from "./prisma-client.ts";

const BASE_URL = "postgresql://user:pass@localhost:5432/shipwright_task_store";

describe("toPoolConfig", () => {
  test("passes a no-query-params URL through with only the connect-timeout floor", () => {
    const config = toPoolConfig(BASE_URL);

    expect(config.connectionString).toBe(`${BASE_URL}`);
    expect(config.connectionTimeoutMillis).toBe(CONNECT_TIMEOUT_MS);
    expect(config.max).toBeUndefined();
    expect(config.options).toBeUndefined();
  });

  test("translates schema= into a search_path option and strips it from the URL", () => {
    const config = toPoolConfig(`${BASE_URL}?schema=task_store`);

    expect(config.options).toBe("-c search_path=task_store");
    expect(config.connectionString).not.toContain("schema");
  });

  test("translates connection_limit= into max and strips it from the URL", () => {
    const config = toPoolConfig(`${BASE_URL}?connection_limit=5`);

    expect(config.max).toBe(5);
    expect(config.connectionString).not.toContain("connection_limit");
  });

  test("raises connectionTimeoutMillis to a configured pool_timeout (seconds→ms)", () => {
    // pg has no separate pool-acquire timeout: connectionTimeoutMillis bounds
    // both the wait for a free slot and a new client's connect, so a
    // configured pool_timeout has to widen it or it is silently lost.
    const config = toPoolConfig(`${BASE_URL}?pool_timeout=20`);

    expect(config.connectionTimeoutMillis).toBe(20_000);
    expect(config.connectionString).not.toContain("pool_timeout");
  });

  test("never lowers connectionTimeoutMillis below the connect-timeout floor", () => {
    for (const value of ["1", "0", "-5", "not-a-number", ""]) {
      const config = toPoolConfig(`${BASE_URL}?pool_timeout=${value}`);
      expect(config.connectionTimeoutMillis).toBe(CONNECT_TIMEOUT_MS);
    }
  });

  test("handles the CI-style URL: all Prisma-only params translated and stripped", () => {
    const config = toPoolConfig(
      `${BASE_URL}?connection_limit=5&pool_timeout=20&schema=public&sslmode=disable`,
    );

    expect(config.max).toBe(5);
    expect(config.connectionTimeoutMillis).toBe(20_000);
    expect(config.options).toBe("-c search_path=public");
    // Non-Prisma params survive; every Prisma-only one is gone.
    expect(config.connectionString).toContain("sslmode=disable");
    expect(config.connectionString).not.toContain("connection_limit");
    expect(config.connectionString).not.toContain("pool_timeout");
    expect(config.connectionString).not.toContain("schema");
  });

  test("ignores a non-numeric connection_limit rather than passing NaN to pg", () => {
    const config = toPoolConfig(`${BASE_URL}?connection_limit=lots`);

    expect(config.max).toBeUndefined();
    expect(config.connectionString).not.toContain("connection_limit");
  });
});
