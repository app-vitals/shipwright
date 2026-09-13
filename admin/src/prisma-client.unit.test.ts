/**
 * admin/src/prisma-client.unit.test.ts
 *
 * Unit coverage for the parts of the client factory that do no I/O.
 *
 * Under Prisma 7 the client is built on a `pg.Pool` that admin now owns, so two
 * things have to be right before anything connects:
 *   - a blank `connectionString` must fail loudly — `pg` silently ignores a
 *     falsy one (falling back to PGHOST/PGUSER/... or localhost), which would
 *     boot the service against an unintended database;
 *   - the pool must carry an `error` listener — `Pool` is an `EventEmitter`, and
 *     an idle-client `error` with no listener is rethrown as an uncaught
 *     exception that kills the process.
 *
 * `pg.Pool` does not connect on construction, so both are assertable here. The
 * connecting paths live in prisma-client.integration.test.ts (real DB).
 */

import { describe, expect, it } from "bun:test";
import {
  createAdminPgPool,
  createAdminPrismaClient,
  DB_CONNECT_TIMEOUT_MS,
} from "./prisma-client.ts";

/** A syntactically valid URL. `pg.Pool` does not connect on construction. */
const DUMMY_URL = "postgresql://user:password@localhost:5432/shipwright_admin";

describe("createAdminPgPool", () => {
  it("attaches an 'error' listener so an idle-client error cannot crash the process", async () => {
    const pool = createAdminPgPool(DUMMY_URL);
    try {
      // `Pool` is an EventEmitter: an 'error' event with no listener is
      // rethrown as an uncaught exception. Prisma 6's engine owned the pool and
      // absorbed these; under Prisma 7 the pool is ours, so the listener is
      // load-bearing rather than cosmetic.
      expect(pool.listenerCount("error")).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  it("does not rethrow when the pool emits an idle-client 'error'", async () => {
    const pool = createAdminPgPool(DUMMY_URL);
    try {
      expect(() => {
        pool.emit("error", new Error("Connection terminated unexpectedly"));
      }).not.toThrow();
    } finally {
      await pool.end();
    }
  });

  it("bounds the connect timeout instead of waiting forever", async () => {
    const pool = createAdminPgPool(DUMMY_URL);
    try {
      expect(pool.options.connectionTimeoutMillis).toBe(DB_CONNECT_TIMEOUT_MS);
    } finally {
      await pool.end();
    }
  });

  it("throws on a blank connection string before constructing a pool", () => {
    expect(() => createAdminPgPool("")).toThrow(
      /DATABASE_URL_SHIPWRIGHT_ADMIN is not set/,
    );
  });
});

describe("createAdminPrismaClient — missing connection string", () => {
  it("throws when the connection string is empty", () => {
    expect(() => createAdminPrismaClient("")).toThrow(
      /DATABASE_URL_SHIPWRIGHT_ADMIN is not set/,
    );
  });

  it("throws when the connection string is only whitespace", () => {
    expect(() => createAdminPrismaClient("   ")).toThrow(
      /DATABASE_URL_SHIPWRIGHT_ADMIN is not set/,
    );
  });

  it("names the env var and the expected format in the error message", () => {
    let message = "";
    try {
      createAdminPrismaClient("");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("DATABASE_URL_SHIPWRIGHT_ADMIN");
    expect(message).toContain("postgresql://");
  });
});
