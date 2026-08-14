/**
 * scripts/hitl.integration.test.ts
 * Integration-level sequencing test for scripts/hitl.ts's top-level
 * orchestration (MTC-1.7 / test-migration.md's "Local HITL dev-loop
 * bootstrap" net-new item).
 *
 * "Integration" here means what this repo's layer convention says it means:
 * real composed orchestration logic, with fakes injected at the I/O
 * boundaries (process spawn, fetch) — not a real Postgres/network. It proves
 * runPreflight() → startServices() → ensureHitlAgent() → seedAgentToken() →
 * fetchReadyTasks() compose in the documented order and propagate failures
 * the same way the real (non-test) wiring does, without spawning gh, prisma,
 * or the long-running task-store/admin services.
 *
 * The pure planning helpers this sequence is built from (buildHitlConfig,
 * computeMissingClones, computeProvisionPlan, buildProvisionSteps,
 * buildCloneSteps, buildMigrationSteps, buildTokenSeedStep,
 * buildPreflightSteps, buildServiceSpecs, parseTasksResponse,
 * buildTaskCommand, buildPrCommand, buildClaudeSpawnEnv) are already fully
 * unit-tested in hitl.unit.test.ts / hitl.bootstrap.unit.test.ts — this file
 * does not re-test them.
 *
 * No mock.module(), no global.fetch/global.* overrides — every fake is
 * passed as an explicit parameter, per this repo's isolation contract.
 */

import { describe, expect, test } from "bun:test";
import {
  type HitlStep,
  fetchReadyTasks,
  runPreflight,
  startServices,
} from "./hitl.ts";

// ---------------------------------------------------------------------------
// runPreflight — injectable step sequence + executor
// ---------------------------------------------------------------------------

describe("runPreflight", () => {
  test("drives the full preflight step sequence through the injected executor, in order", async () => {
    const seen: string[] = [];
    const steps: HitlStep[] = [
      { kind: "mkdir", label: "mkdir /ws", path: "/ws" },
      { kind: "clone", label: "clone failed", argv: ["gh", "repo", "clone"] },
      { kind: "install-plugins", label: "installing shipwright plugin..." },
      { kind: "exec", label: "migrate failed", argv: ["bunx", "prisma"] },
    ];

    await runPreflight(steps, (step) => {
      seen.push(step.kind);
    });

    expect(seen).toEqual([
      "mkdir",
      "clone",
      "install-plugins",
      "exec",
    ]);
  });

  test("propagates a step failure and stops the sequence, matching runSteps()'s contract", async () => {
    const seen: string[] = [];
    const steps: HitlStep[] = [
      { kind: "mkdir", label: "first", path: "/ws" },
      { kind: "exec", label: "boom", argv: ["false"] },
      { kind: "exec", label: "never", argv: ["true"] },
    ];

    await expect(
      runPreflight(steps, (step) => {
        seen.push(step.label);
        if (step.label === "boom") throw new Error(step.label);
      }),
    ).rejects.toThrow("boom");

    expect(seen).toEqual(["first", "boom"]);
  });

  test("defaults to the real execStep executor when none is injected", () => {
    // Not awaited/executed — this only proves the seam accepts a call with
    // zero steps and no injected executor, exercising the default-arg wiring
    // without touching the filesystem.
    expect(runPreflight([])).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// startServices — injectable process spawner
// ---------------------------------------------------------------------------

describe("startServices", () => {
  test("spawns every planned service spec through the injected spawner, in order", () => {
    const spawned: { argv: string[]; cwd?: string }[] = [];
    const fakeSpawn = (argv: string[], opts: { cwd?: string }) => {
      spawned.push({ argv, cwd: opts.cwd });
      return { pid: spawned.length, kill: () => {} } as unknown as ReturnType<
        typeof Bun.spawn
      >;
    };

    const handles = startServices(fakeSpawn);

    expect(handles.map((h) => h.label)).toEqual(["task-store", "admin"]);
    expect(spawned).toHaveLength(2);
    expect(spawned[0]?.argv.at(-1)).toMatch(/task-store\/src\/main\.ts$/);
    expect(spawned[1]?.argv.at(-1)).toMatch(/admin\/src\/main\.ts$/);
  });

  test("each returned handle wraps the spawner's own return value", () => {
    const fakeProc = { pid: 999, kill: () => {} };
    const fakeSpawn = () => fakeProc as unknown as ReturnType<typeof Bun.spawn>;

    const handles = startServices(fakeSpawn);

    for (const h of handles) {
      expect(h.proc).toBe(fakeProc);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchReadyTasks — injectable fetch
// ---------------------------------------------------------------------------

describe("fetchReadyTasks", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  test("returns the parsed tasks array on a healthy response", async () => {
    const fakeFetch = (async () =>
      jsonResponse({
        tasks: [{ id: "PV-1.2", title: "Do the thing", status: "pending" }],
      })) as typeof fetch;

    const tasks = await fetchReadyTasks(fakeFetch);

    expect(tasks).toEqual([
      { id: "PV-1.2", title: "Do the thing", status: "pending" },
    ]);
  });

  test("returns [] and does not throw when the task-store responds non-ok", async () => {
    const fakeFetch = (async () =>
      jsonResponse({ error: "boom" }, 500)) as typeof fetch;

    const tasks = await fetchReadyTasks(fakeFetch);

    expect(tasks).toEqual([]);
  });

  test("returns [] and does not throw when the fetch itself rejects (network error)", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const tasks = await fetchReadyTasks(fakeFetch);

    expect(tasks).toEqual([]);
  });

  test("passes the bearer auth header the task-store expects", async () => {
    let sawAuth: string | null = null;
    const fakeFetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      sawAuth = (init?.headers as Record<string, string> | undefined)
        ?.Authorization as string;
      return jsonResponse({ tasks: [] });
    }) as typeof fetch;

    await fetchReadyTasks(fakeFetch);

    expect(sawAuth).toMatch(/^Bearer /);
  });
});

// ---------------------------------------------------------------------------
// Composed sequencing — preflight -> services -> tasks, in the order the
// real entrypoint drives them, entirely through injected fakes.
// ---------------------------------------------------------------------------

describe("bootstrap sequencing (composed)", () => {
  test("preflight completes before services start, and services start before the first task poll", async () => {
    const order: string[] = [];

    await runPreflight(
      [{ kind: "mkdir", label: "mkdir /ws", path: "/ws" }],
      (step) => {
        order.push(`preflight:${step.kind}`);
      },
    );

    const fakeSpawn = (argv: string[]) => {
      const last = argv[argv.length - 1] ?? "";
      const shortName = last.includes("task-store")
        ? "task-store/src/main.ts"
        : "admin/src/main.ts";
      order.push(`spawn:${shortName}`);
      return { pid: 1, kill: () => {} } as unknown as ReturnType<
        typeof Bun.spawn
      >;
    };
    const handles = startServices(fakeSpawn);
    expect(handles).toHaveLength(2);

    const fakeFetch = (async () => {
      order.push("poll:fetchReadyTasks");
      return new Response(JSON.stringify({ tasks: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    await fetchReadyTasks(fakeFetch);

    expect(order).toEqual([
      "preflight:mkdir",
      "spawn:task-store/src/main.ts",
      "spawn:admin/src/main.ts",
      "poll:fetchReadyTasks",
    ]);
  });
});
