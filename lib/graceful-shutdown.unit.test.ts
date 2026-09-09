import { describe, expect, test } from "bun:test";
import { registerGracefulShutdown } from "./graceful-shutdown.ts";

/** Records signal listeners without touching the real `process` object. */
function fakeSignalSource() {
  const listeners: Record<string, () => void> = {};
  return {
    on(event: "SIGTERM" | "SIGINT", listener: () => void) {
      listeners[event] = listener;
    },
    listeners,
  };
}

/** Fake server.stop() — records the `closeActiveConnections` arg per call and resolves immediately. */
function fakeServer(calls: string[]) {
  return {
    stop(closeActiveConnections?: boolean) {
      calls.push(closeActiveConnections ? "stop(true)" : "stop()");
      return Promise.resolve();
    },
  };
}

/** Fake setTimeout — never fires on its own; the test triggers it manually via `fire()`. */
function fakeTimeout() {
  let scheduled: { fn: () => void; ms: number } | undefined;
  return {
    setTimeoutFn: (fn: () => void, ms: number) => {
      scheduled = { fn, ms };
      return "handle";
    },
    clearTimeoutFn: () => {
      scheduled = undefined;
    },
    fire: () => scheduled?.fn(),
    ms: () => scheduled?.ms,
  };
}

/** Fake process.exit() that also resolves a promise so tests can await shutdown completion. */
function fakeExit() {
  const calls: number[] = [];
  let resolve!: () => void;
  const settled = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    exit: (code: number) => {
      calls.push(code);
      resolve();
    },
    calls,
    settled,
  };
}

const NOOP_LOGGER = { log: () => {}, error: () => {} };

/**
 * Builds a fresh set of fakes and registers a shutdown handler against them.
 * Every test shares this same wiring — only `cleanup` and `hardDeadlineMs`
 * vary — so the fixture construction lives here once instead of being
 * repeated per test.
 */
function harness(
  overrides: {
    cleanup?: Array<() => Promise<void>>;
    hardDeadlineMs?: number;
  } = {},
) {
  const calls: string[] = [];
  const server = fakeServer(calls);
  const signal = fakeSignalSource();
  const timeout = fakeTimeout();
  const exit = fakeExit();

  const handle = registerGracefulShutdown({
    server,
    cleanup: overrides.cleanup ?? [async () => {}],
    ...(overrides.hardDeadlineMs !== undefined
      ? { hardDeadlineMs: overrides.hardDeadlineMs }
      : {}),
    process: signal,
    setTimeoutFn: timeout.setTimeoutFn,
    clearTimeoutFn: timeout.clearTimeoutFn,
    exit: exit.exit,
    logger: NOOP_LOGGER,
  });

  return { calls, signal, timeout, exit, handle };
}

describe("registerGracefulShutdown", () => {
  test("calls server.stop() before running cleanup fns", async () => {
    const { calls, signal, exit } = harness({
      cleanup: [
        async () => {
          calls.push("cleanup:0");
        },
      ],
    });

    signal.listeners.SIGTERM();
    await exit.settled;

    expect(calls).toEqual(["stop()", "cleanup:0"]);
  });

  test("runs cleanup fns in the given order", async () => {
    const { calls, signal, exit } = harness({
      cleanup: [
        async () => {
          calls.push("cleanup:a");
        },
        async () => {
          calls.push("cleanup:b");
        },
        async () => {
          calls.push("cleanup:c");
        },
      ],
    });

    signal.listeners.SIGTERM();
    await exit.settled;

    expect(calls).toEqual(["stop()", "cleanup:a", "cleanup:b", "cleanup:c"]);
  });

  test("exits with code 0 on clean successful shutdown", async () => {
    const { signal, exit } = harness();

    signal.listeners.SIGTERM();
    await exit.settled;

    expect(exit.calls).toEqual([0]);
  });

  test("hard deadline forces server.stop(true) and exit(1) when cleanup never resolves", async () => {
    const { calls, signal, timeout, exit } = harness({
      cleanup: [
        () =>
          new Promise<void>(() => {
            // never resolves — simulates a stuck cleanup fn
          }),
      ],
      hardDeadlineMs: 20_000,
    });

    signal.listeners.SIGTERM();

    // Let the graceful stop() + cleanup kick-off settle onto the stuck promise
    // before manually firing the deadline (no real waiting involved).
    await Promise.resolve();
    await Promise.resolve();

    expect(timeout.ms()).toBe(20_000);
    timeout.fire();
    await exit.settled;

    expect(calls).toContain("stop(true)");
    expect(exit.calls).toEqual([1]);
  });

  test("a second SIGTERM after the first is a no-op", async () => {
    const { calls, signal, exit } = harness({
      cleanup: [
        async () => {
          calls.push("cleanup:0");
        },
      ],
    });

    signal.listeners.SIGTERM();
    await exit.settled;

    signal.listeners.SIGTERM();
    // Flush microtasks so a (bugged) second invocation would have had a chance to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(["stop()", "cleanup:0"]);
    expect(exit.calls).toEqual([0]);
  });

  test("SIGINT triggers the same shutdown sequence as SIGTERM", async () => {
    const { calls, signal, exit } = harness({
      cleanup: [
        async () => {
          calls.push("cleanup:0");
        },
      ],
    });

    signal.listeners.SIGINT();
    await exit.settled;

    expect(calls).toEqual(["stop()", "cleanup:0"]);
    expect(exit.calls).toEqual([0]);
  });

  test("exposes a readable shuttingDown flag, set synchronously on signal", async () => {
    const { signal, exit, handle } = harness();

    expect(handle.isShuttingDown()).toBe(false);

    signal.listeners.SIGTERM();

    // True immediately, before the async stop/cleanup chain has settled.
    expect(handle.isShuttingDown()).toBe(true);

    await exit.settled;
    expect(handle.isShuttingDown()).toBe(true);
  });

  test("a cleanup fn that throws does not prevent later cleanup fns or process.exit", async () => {
    const { calls, signal, exit } = harness({
      cleanup: [
        async () => {
          calls.push("cleanup:a");
          throw new Error("boom");
        },
        async () => {
          calls.push("cleanup:b");
        },
      ],
    });

    signal.listeners.SIGTERM();
    await exit.settled;

    expect(calls).toEqual(["stop()", "cleanup:a", "cleanup:b"]);
    expect(exit.calls).toEqual([0]);
  });
});
