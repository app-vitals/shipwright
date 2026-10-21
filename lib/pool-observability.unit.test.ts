import { describe, expect, test } from "bun:test";
import {
  type CheckoutPool,
  type Clock,
  isPoolTimeoutError,
  poolErrorContext,
  routeContextMiddleware,
  runWithRouteContext,
  snapshotPool,
  startPoolMonitor,
  trackConnectionHold,
} from "./pool-observability.ts";

function makePool(over: Partial<CheckoutPool> = {}) {
  const released: unknown[][] = [];
  const pool: CheckoutPool = {
    totalCount: 3,
    idleCount: 1,
    waitingCount: 0,
    options: { max: 10 },
    connect: async () => ({
      release: (...args: unknown[]) => {
        released.push(args);
      },
    }),
    ...over,
  };
  return { pool, released };
}

function makeClock(startMs = 0) {
  let t = startMs;
  const clock: Clock = { now: () => new Date(t) };
  return {
    clock,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("snapshotPool", () => {
  test("maps pool counts and max", () => {
    expect(snapshotPool(makePool().pool)).toEqual({
      total: 3,
      idle: 1,
      waiting: 0,
      max: 10,
    });
  });
});

describe("isPoolTimeoutError", () => {
  test("matches Prisma P2028", () => {
    expect(isPoolTimeoutError({ code: "P2028", message: "x" })).toBe(true);
  });
  test("matches message variants", () => {
    expect(
      isPoolTimeoutError(
        new Error("Unable to start a transaction in the given time."),
      ),
    ).toBe(true);
    expect(
      isPoolTimeoutError(new Error("timeout exceeded when trying to connect")),
    ).toBe(true);
    expect(
      isPoolTimeoutError(
        new Error("Connection terminated due to connection timeout"),
      ),
    ).toBe(true);
  });
  test("rejects unrelated errors", () => {
    expect(isPoolTimeoutError(new Error("syntax error"))).toBe(false);
    expect(isPoolTimeoutError({ code: "P2002" })).toBe(false);
    expect(isPoolTimeoutError(null)).toBe(false);
    expect(isPoolTimeoutError("timeout")).toBe(false);
  });
});

describe("startPoolMonitor", () => {
  function harness(pool: CheckoutPool) {
    let tick: () => void = () => {};
    let cleared: unknown;
    const logs: unknown[][] = [];
    const stop = startPoolMonitor(pool, {
      intervalMs: 5,
      log: (...a) => void logs.push(a),
      setInterval: (fn, ms) => {
        expect(ms).toBe(5);
        tick = fn;
        return "h";
      },
      clearInterval: (h) => {
        cleared = h;
      },
    });
    return { tick: () => tick(), stop, logs, cleared: () => cleared };
  }

  test("does not log when nobody is waiting", () => {
    const h = harness(makePool().pool);
    h.tick();
    expect(h.logs).toHaveLength(0);
  });

  test("logs a snapshot when waiting > 0", () => {
    const h = harness(makePool({ waitingCount: 4 }).pool);
    h.tick();
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]?.[1]).toMatchObject({ waiting: 4, total: 3, max: 10 });
  });

  test("stop fn clears the interval", () => {
    const h = harness(makePool().pool);
    h.stop();
    expect(h.cleared()).toBe("h");
  });
});

describe("trackConnectionHold", () => {
  async function run(
    holdMs: number,
    route?: { method: string; route: string },
  ) {
    const { pool, released } = makePool({ waitingCount: 2 });
    const { clock, advance } = makeClock();
    const logs: unknown[][] = [];
    trackConnectionHold(pool, {
      thresholdMs: 2000,
      clock,
      log: (...a) => void logs.push(a),
    });
    const exec = async () => {
      const client = await pool.connect();
      advance(holdMs);
      client.release();
      return client;
    };
    const client = route
      ? await runWithRouteContext(route, exec)
      : await exec();
    return { client, logs, released };
  }

  test("does not log under the threshold", async () => {
    const { logs, released } = await run(1500);
    expect(logs).toHaveLength(0);
    expect(released).toHaveLength(1);
  });

  test("logs route, heldMs and pool snapshot over the threshold", async () => {
    const { logs } = await run(2500, { method: "GET", route: "/tasks/:id" });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.[1]).toMatchObject({
      route: "GET /tasks/:id",
      heldMs: 2500,
      pool: { total: 3, waiting: 2 },
    });
  });

  test("route is null outside a request", async () => {
    const { logs } = await run(2500);
    expect(logs[0]?.[1]).toMatchObject({ route: null });
  });

  test("release is called once per call, error arg forwarded", async () => {
    const { pool, released } = makePool();
    trackConnectionHold(pool);
    const client = await pool.connect();
    const err = new Error("boom");
    client.release(err);
    expect(released).toEqual([[err]]);
  });

  test("double release behaves as unwrapped (underlying called each time)", async () => {
    const { pool, released } = makePool();
    const { clock, advance } = makeClock();
    const logs: unknown[][] = [];
    trackConnectionHold(pool, { clock, log: (...a) => void logs.push(a) });
    const client = await pool.connect();
    advance(5000);
    client.release();
    client.release(true);
    expect(released).toEqual([[], [true]]);
    expect(logs).toHaveLength(1);
  });

  test("restore fn reinstates original connect", async () => {
    const { pool } = makePool();
    const original = pool.connect;
    const restore = trackConnectionHold(pool);
    expect(pool.connect).not.toBe(original);
    restore();
    expect(pool.connect).toBe(original);
  });
});

describe("routeContextMiddleware", () => {
  test("records method and matched route pattern for poolErrorContext", async () => {
    const { pool } = makePool();
    let seen: Record<string, unknown> | undefined;
    const c = {
      req: {
        method: "GET",
        path: "/tasks/42",
        matchedRoutes: [{ path: "/*" }, { path: "/tasks/:id" }],
      },
    };
    await routeContextMiddleware()(c, async () => {
      seen = poolErrorContext(pool);
    });
    expect(seen).toEqual({
      total: 3,
      idle: 1,
      waiting: 0,
      max: 10,
      route: "GET /tasks/:id",
    });
  });

  test("falls back to the request path without matchedRoutes", async () => {
    let seen: Record<string, unknown> | undefined;
    const c = { req: { method: "POST", path: "/x" } };
    await routeContextMiddleware()(c, async () => {
      seen = poolErrorContext(makePool().pool);
    });
    expect(seen?.route).toBe("POST /x");
  });

  test("poolErrorContext has null route outside a request", () => {
    expect(poolErrorContext(makePool().pool).route).toBeNull();
  });
});
