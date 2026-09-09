/**
 * lib/graceful-shutdown.ts
 *
 * Wires SIGTERM/SIGINT into a coordinated shutdown for a `Bun.serve()`-backed
 * service: stop accepting new connections (letting in-flight requests
 * finish), run ordered cleanup (e.g. `prisma.$disconnect()`), then exit.
 *
 * A hard deadline forces a non-graceful `server.stop(true)` + `exit(1)` so a
 * stuck cleanup fn can never outlive the pod's terminationGracePeriod (30s in
 * the Helm chart — see DBE-1.x/DBE-3.1, out of scope here).
 *
 * Every I/O-adjacent collaborator — the server, the signal source, the exit
 * call, and the deadline timer — is injectable so this is unit-testable with
 * fakes: no real signals sent, no real waiting, no `mock.module()` / global
 * overrides (see CLAUDE.md's test isolation rule).
 */

/** Below the pod's terminationGracePeriod (30s) so a stuck cleanup can't outlive it. */
const DEFAULT_HARD_DEADLINE_MS = 20_000;

/** Mirrors Bun.serve()'s return value: stop() waits for in-flight requests, stop(true) force-closes. */
export interface ShutdownServer {
  stop(closeActiveConnections?: boolean): unknown;
}

/** Run in order on shutdown; a throw is logged and does not block later cleanup fns or the final exit. */
export type CleanupFn = () => Promise<void>;

/** Narrowed to the one method this module needs — satisfied by the real `process`. */
export interface SignalSource {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export interface GracefulShutdownLogger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface GracefulShutdownOptions {
  /** The Bun.serve() return value (or anything shaped like it). */
  server: ShutdownServer;
  /** Cleanup fns run sequentially, in order, after the server stops accepting new work. */
  cleanup: CleanupFn[];
  /** Forces stop(true) + exit(1) if the graceful path hasn't finished by then. Default 20s. */
  hardDeadlineMs?: number;
  /** Defaults to the real `process.exit`. */
  exit?: (code: number) => void;
  /** Defaults to the real global `setTimeout`. Injectable so tests can trigger the deadline manually. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /** Defaults to the real global `clearTimeout`. */
  clearTimeoutFn?: (handle: unknown) => void;
  /** Defaults to the real `process`. Injectable so tests can fire signals without touching the real process. */
  process?: SignalSource;
  logger?: GracefulShutdownLogger;
  /** Used only to prefix log lines, e.g. "admin", "task-store", "chat". */
  serviceName?: string;
}

export interface GracefulShutdown {
  /** True once a shutdown signal has been received — gate readiness probes on this. */
  isShuttingDown: () => boolean;
}

export function registerGracefulShutdown(
  options: GracefulShutdownOptions,
): GracefulShutdown {
  const {
    server,
    cleanup,
    hardDeadlineMs = DEFAULT_HARD_DEADLINE_MS,
    exit = process.exit.bind(process),
    // Wrapped (rather than assigned the raw global) so the interface can
    // stay in terms of `unknown` for the timer handle without TypeScript
    // narrowing these bindings to the global setTimeout/clearTimeout
    // overloads' own parameter types.
    setTimeoutFn = (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clearTimeoutFn = (handle: unknown): void =>
      clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
    process: signalSource = process,
    logger = console,
    serviceName = "service",
  } = options;

  let shuttingDown = false;
  let settled = false;

  // Declared via `let` (not inline in the setTimeoutFn call) so a fake
  // setTimeoutFn that invokes its callback synchronously never hits a
  // temporal-dead-zone reference to this variable.
  let deadlineHandle: unknown;

  const finish = (code: number) => {
    if (settled) return;
    settled = true;
    clearTimeoutFn(deadlineHandle);
    exit(code);
  };

  const handleSignal = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.log(`[${serviceName}] received ${signal}, shutting down gracefully`);

    deadlineHandle = setTimeoutFn(() => {
      logger.error(
        `[${serviceName}] graceful shutdown exceeded ${hardDeadlineMs}ms — forcing stop`,
      );
      try {
        server.stop(true);
      } catch (err) {
        logger.error(`[${serviceName}] error force-stopping server:`, err);
      }
      finish(1);
    }, hardDeadlineMs);

    void (async () => {
      try {
        await server.stop();
      } catch (err) {
        logger.error(`[${serviceName}] error stopping server:`, err);
      }

      for (const fn of cleanup) {
        try {
          await fn();
        } catch (err) {
          logger.error(`[${serviceName}] cleanup fn failed:`, err);
        }
      }

      logger.log(`[${serviceName}] graceful shutdown complete`);
      finish(0);
    })();
  };

  signalSource.on("SIGTERM", () => handleSignal("SIGTERM"));
  signalSource.on("SIGINT", () => handleSignal("SIGINT"));

  return {
    isShuttingDown: () => shuttingDown,
  };
}
