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
  observeAdminPool,
  resolveAdminPoolObservabilityConfig,
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

  it("pins a legacy sslmode=require to verify-full for pg", async () => {
    const pool = createAdminPgPool(`${DUMMY_URL}?sslmode=require`);
    try {
      expect(pool.options.connectionString).toBe(
        `${DUMMY_URL}?sslmode=verify-full`,
      );
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

describe("resolveAdminPoolObservabilityConfig", () => {
  it("returns undefined overrides when env vars are unset", () => {
    expect(resolveAdminPoolObservabilityConfig({})).toEqual({
      holdThresholdMs: undefined,
      monitorIntervalMs: undefined,
    });
  });

  it("parses positive integer overrides", () => {
    expect(
      resolveAdminPoolObservabilityConfig({
        SHIPWRIGHT_ADMIN_POOL_HOLD_THRESHOLD_MS: "500",
        SHIPWRIGHT_ADMIN_POOL_MONITOR_INTERVAL_MS: "1000",
      }),
    ).toEqual({ holdThresholdMs: 500, monitorIntervalMs: 1000 });
  });

  it("falls back to defaults for blank, non-numeric, zero, or negative values", () => {
    for (const bad of ["", "  ", "abc", "0", "-5", "1.5", "NaN"]) {
      expect(
        resolveAdminPoolObservabilityConfig({
          SHIPWRIGHT_ADMIN_POOL_HOLD_THRESHOLD_MS: bad,
          SHIPWRIGHT_ADMIN_POOL_MONITOR_INTERVAL_MS: bad,
        }),
      ).toEqual({ holdThresholdMs: undefined, monitorIntervalMs: undefined });
    }
  });
});

describe("observeAdminPool", () => {
  it("logs holds over the env threshold and stops the monitor on stop()", async () => {
    let now = 0;
    const logs: Array<[string, unknown]> = [];
    const cleared: unknown[] = [];
    const intervals: number[] = [];
    const released: unknown[] = [];
    const pool = {
      totalCount: 1,
      idleCount: 0,
      waitingCount: 0,
      options: { max: 10 },
      connect: async () => ({ release: (e?: unknown) => released.push(e) }),
    };
    const stop = observeAdminPool(
      pool,
      {
        SHIPWRIGHT_ADMIN_POOL_HOLD_THRESHOLD_MS: "100",
        SHIPWRIGHT_ADMIN_POOL_MONITOR_INTERVAL_MS: "250",
      },
      {
        log: (m, d) => logs.push([m, d]),
        clock: { now: () => new Date(now) },
        setInterval: (_fn, ms) => {
          intervals.push(ms);
          return "h";
        },
        clearInterval: (h) => cleared.push(h),
      },
    );
    expect(intervals).toEqual([250]);
    const client = await pool.connect();
    now = 150;
    client.release();
    expect(logs.length).toBe(1);
    expect(logs[0]?.[0]).toBe("pg connection held past threshold");
    expect(logs[0]?.[1]).toMatchObject({ heldMs: 150 });
    stop();
    expect(cleared).toEqual(["h"]);
  });
});
