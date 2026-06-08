/**
 * scripts/dev.unit.test.ts
 * Unit tests for scripts/dev.ts supervisor logic.
 *
 * Tests dependency-injected supervisor with fake child handles — no real
 * process spawning. Covers: child spawn config, SIGINT → shutdown, multi-child
 * shutdown sequencing.
 */

import { describe, expect, test, mock, beforeEach } from "bun:test";
import { type ChildConfig, createSupervisor } from "./dev.ts";

// ---------------------------------------------------------------------------
// Fake child handle: tracks signal calls and resolves exited on demand
// ---------------------------------------------------------------------------

function makeFakeChild(label: string) {
  let resolveExited!: () => void;
  const exitedPromise = new Promise<void>((res) => {
    resolveExited = res;
  });

  const killed: string[] = [];

  const handle = {
    label,
    kill: (signal?: string) => {
      killed.push(signal ?? "SIGTERM");
      resolveExited(); // auto-resolve exit when killed
    },
    exited: exitedPromise,
    // expose for assertions
    _killed: killed,
  };
  return handle;
}

type FakeChild = ReturnType<typeof makeFakeChild>;

// ---------------------------------------------------------------------------
// createSupervisor tests
// ---------------------------------------------------------------------------

describe("createSupervisor", () => {
  test("returns an object with start and shutdown methods", () => {
    const supervisor = createSupervisor([]);
    expect(typeof supervisor.start).toBe("function");
    expect(typeof supervisor.shutdown).toBe("function");
  });

  test("shutdown signals all injected children", async () => {
    const child1 = makeFakeChild("metrics-api");
    const child2 = makeFakeChild("agent");

    const supervisor = createSupervisor(
      [
        { cmd: ["bun", "run", "metrics/src/server.ts"], label: "metrics-api" },
        { cmd: ["bun", "run", "agent/src/server.ts"], label: "agent" },
      ],
      // Inject fake spawn: returns pre-built fake handles
      (_config: ChildConfig) => {
        const fakes = [child1, child2];
        const fake = fakes.shift();
        if (!fake) throw new Error("no more fakes");
        return fake;
      },
    );

    // Manually trigger shutdown (not start, to avoid real spawning)
    await supervisor.shutdownWithChildren([child1, child2]);

    expect(child1._killed.length).toBeGreaterThan(0);
    expect(child2._killed.length).toBeGreaterThan(0);
  });

  test("shutdown resolves after all children exit", async () => {
    const child1 = makeFakeChild("metrics-api");

    const supervisor = createSupervisor([
      { cmd: ["bun", "run", "metrics/src/server.ts"], label: "metrics-api" },
    ]);

    const shutdownPromise = supervisor.shutdownWithChildren([child1]);
    // The shutdown promise must resolve (child auto-resolves on kill)
    await expect(shutdownPromise).resolves.toBeUndefined();
  });

  test("shutdown with no children resolves immediately", async () => {
    const supervisor = createSupervisor([]);
    await expect(supervisor.shutdownWithChildren([])).resolves.toBeUndefined();
  });

  test("shutdown signals children with SIGINT", async () => {
    const child = makeFakeChild("metrics-api");

    const supervisor = createSupervisor([
      { cmd: ["bun", "run", "metrics/src/server.ts"], label: "metrics-api" },
    ]);

    await supervisor.shutdownWithChildren([child]);

    expect(child._killed).toContain("SIGINT");
  });
});

// ---------------------------------------------------------------------------
// ChildConfig type shape
// ---------------------------------------------------------------------------

describe("ChildConfig type", () => {
  test("accepts cmd array and label string", () => {
    const cfg: ChildConfig = {
      cmd: ["bun", "run", "metrics/src/server.ts"],
      label: "metrics-api",
    };
    expect(cfg.cmd).toEqual(["bun", "run", "metrics/src/server.ts"]);
    expect(cfg.label).toBe("metrics-api");
  });

  test("accepts optional env record", () => {
    const cfg: ChildConfig = {
      cmd: ["bun", "run", "metrics/src/server.ts"],
      label: "metrics-api",
      env: { METRICS_OFFLINE: "true" },
    };
    expect(cfg.env?.METRICS_OFFLINE).toBe("true");
  });
});
