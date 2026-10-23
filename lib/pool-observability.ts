/**
 * lib/pool-observability.ts
 * Observability helpers for diagnosing pg pool starvation (Sentry SENTRY-5T).
 *
 * Observability only: nothing here changes pool or client behavior. Types are
 * structural so this module needs no direct dependency on `pg` or `hono`.
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal Clock (matches the Clock interface used across services). */
export interface Clock {
  now(): Date;
}

export interface PoolLike {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  options?: { max?: number };
}

export interface PoolSnapshot {
  total: number;
  idle: number;
  waiting: number;
  max: number | null;
}

export type PoolLog = (message: string, data?: Record<string, unknown>) => void;

type ReleaseFn = (err?: Error | boolean) => void;

export interface CheckoutPool extends PoolLike {
  // biome-ignore lint/suspicious/noExplicitAny: matches pg's overloaded connect()
  connect: (...args: any[]) => any;
}

const systemClock: Clock = { now: () => new Date() };

// ─── Snapshot / error detection ───────────────────────────────────────────────

export function snapshotPool(pool: PoolLike): PoolSnapshot {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: pool.options?.max ?? null,
  };
}

/** True for Prisma P2028, "Unable to start a transaction", or pg connection timeouts. */
export function isPoolTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === "P2028") return true;
  if (typeof message !== "string") return false;
  return (
    message.includes("Unable to start a transaction") ||
    /timeout exceeded when trying to connect/i.test(message) ||
    /connection timeout/i.test(message)
  );
}

// ─── Monitor ──────────────────────────────────────────────────────────────────

export interface PoolMonitorOptions {
  intervalMs?: number;
  log?: PoolLog;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Periodically logs the pool snapshot, only while clients are waiting. Returns a stop fn. */
export function startPoolMonitor(
  pool: PoolLike,
  opts: PoolMonitorOptions = {},
): () => void {
  const {
    intervalMs = 30_000,
    log = (m, d) => console.warn(m, d),
    setInterval: setIntervalFn = (fn, ms) => setInterval(fn, ms),
    clearInterval: clearIntervalFn = (h) =>
      clearInterval(h as ReturnType<typeof setInterval>),
  } = opts;
  const handle = setIntervalFn(() => {
    const snap = snapshotPool(pool);
    if (snap.waiting > 0) log("pg pool has waiting clients", { ...snap });
  }, intervalMs);
  return () => clearIntervalFn(handle);
}

// ─── Route context ────────────────────────────────────────────────────────────

export interface RouteContext {
  method: string;
  route: string;
}

const routeStorage = new AsyncLocalStorage<RouteContext>();

export function runWithRouteContext<T>(ctx: RouteContext, fn: () => T): T {
  return routeStorage.run(ctx, fn);
}

export function currentRouteContext(): RouteContext | undefined {
  return routeStorage.getStore();
}

interface HonoLikeContext {
  req: {
    method: string;
    path: string;
    matchedRoutes?: { path: string }[];
  };
}

/**
 * Hono middleware factory recording the request method and matched route
 * pattern. The pattern is resolved lazily (at read time) so it reflects the
 * handler route rather than the wildcard this middleware is mounted on.
 */
export function routeContextMiddleware() {
  return async (c: HonoLikeContext, next: () => Promise<void>) => {
    const ctx: RouteContext = {
      method: c.req.method,
      get route() {
        const matched = c.req.matchedRoutes;
        return matched?.length
          ? (matched[matched.length - 1] as { path: string }).path
          : c.req.path;
      },
    };
    await runWithRouteContext(ctx, next);
  };
}

// ─── Connection hold tracking ─────────────────────────────────────────────────

export interface TrackHoldOptions {
  thresholdMs?: number;
  log?: PoolLog;
  clock?: Clock;
}

/**
 * Wraps `pool.connect()` so each checked-out client's `release` logs when the
 * connection was held longer than `thresholdMs`. Release semantics are
 * preserved exactly: args are forwarded untouched and the underlying release
 * is invoked on every call (so pg's own double-release error still surfaces).
 * Returns a function restoring the original `connect`.
 */
export function trackConnectionHold(
  pool: CheckoutPool,
  opts: TrackHoldOptions = {},
): () => void {
  const {
    thresholdMs = 2000,
    log = (m, d) => console.warn(m, d),
    clock = systemClock,
  } = opts;
  const originalConnect = pool.connect;

  const wrap = (client: { release: ReleaseFn }) => {
    const checkedOutAt = clock.now().getTime();
    const route = currentRouteContext();
    const originalRelease = client.release;
    let reported = false;
    client.release = function (this: unknown, ...args: [(Error | boolean)?]) {
      if (!reported) {
        reported = true;
        const heldMs = clock.now().getTime() - checkedOutAt;
        if (heldMs > thresholdMs) {
          log("pg connection held past threshold", {
            route: route ? `${route.method} ${route.route}` : null,
            heldMs,
            pool: snapshotPool(pool),
          });
        }
      }
      return originalRelease.apply(client, args);
    } as ReleaseFn;
    return client;
  };

  pool.connect = function (this: unknown, ...args: unknown[]) {
    const result = originalConnect.apply(pool, args);
    // Callback-style connect(cb) is passed through untracked.
    if (typeof args[0] === "function") return result;
    return (result as Promise<{ release: ReleaseFn }>).then(wrap);
  };

  return () => {
    pool.connect = originalConnect;
  };
}

// ─── Sentry context ───────────────────────────────────────────────────────────

/** Object to attach to Sentry events (e.g. `scope.setContext("pg_pool", ...)`). */
export function poolErrorContext(pool: PoolLike): Record<string, unknown> {
  const route = currentRouteContext();
  return {
    ...snapshotPool(pool),
    route: route ? `${route.method} ${route.route}` : null,
  };
}
