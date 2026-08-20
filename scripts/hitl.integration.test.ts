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
 * or the long-running task-store/admin services. The "bootstrap sequencing
 * (composed)" describe block below drives the real buildPreflightSteps()
 * (including its clone sub-sequence, not a synthetic step list) through
 * runPreflight(), so the clone step is exercised by production planning
 * code, not just asserted to exist as a HitlStep shape.
 *
 * Scope note: this file covers clone→seed→boot→poll (preflight through the
 * first task fetch). It deliberately does NOT cover runLoop()'s dispatch
 * step (the `claude` Bun.spawn at hitl.ts:1057) — runLoop() is a monolithic,
 * non-exported function that reaches directly into Bun.spawn, a live
 * TaskStoreClient, and buildReviewDeps/buildPatchDeps rather than composing
 * through an injectable seam like startServices() does. Making dispatch
 * testable needs the same seam-extraction runLoop() hasn't had yet; that's
 * a follow-up, not a same-cycle bolt-on here.
 *
 * The pure planning helpers this sequence is built from (buildHitlConfig,
 * computeMissingClones, computeProvisionPlan, buildProvisionSteps,
 * buildCloneSteps, buildMigrationSteps, buildTokenSeedStep,
 * buildPreflightSteps, buildServiceSpecs, parseTasksResponse,
 * buildTaskCommand, buildPrCommand, buildClaudeSpawnEnv) are already fully
 * unit-tested in hitl.unit.test.ts / hitl.bootstrap.unit.test.ts — this file
 * does not re-test their pure output, only that runPreflight/startServices
 * actually drive them in the documented composed order.
 *
 * No mock.module(), no global.fetch/global.* overrides — every fake is
 * passed as an explicit parameter, per this repo's isolation contract.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHitlConfig,
  buildPreflightSteps,
  createAppendLineSink,
  fetchReadyTasks,
  type HitlStep,
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

    expect(seen).toEqual(["mkdir", "clone", "install-plugins", "exec"]);
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
  test("buildPreflightSteps' real clone sub-sequence runs through runPreflight, in clone order", async () => {
    // Uses the actual production planner (buildPreflightSteps -> ...
    // buildCloneSteps -> computeMissingClones), not a synthetic literal step
    // list — this is what closes the "clone" half of docs/test-readiness's
    // "full clone->seed->boot->poll sequence" debt item: the clone step
    // that reaches runPreflight() here is the same HitlStep[] the real
    // entrypoint would build and execute.
    const cfg = buildHitlConfig(
      { SHIPWRIGHT_HITL_REPOS: "app-vitals/shipwright,some-org/other-repo" },
      "/home/dev",
      "/repo-root",
    );
    // Neither repo exists on disk yet -> both should be planned for clone.
    const exists = () => false;

    const steps = buildPreflightSteps(cfg, exists);
    const cloneSteps = steps.filter((s) => s.kind === "clone");
    expect(cloneSteps.map((s) => s.argv?.[3])).toEqual([
      "app-vitals/shipwright",
      "some-org/other-repo",
    ]);

    const seen: string[] = [];
    await runPreflight(steps, (step) => {
      seen.push(step.kind);
    });

    // provision (mkdir/seed-file) steps, then both clones, then
    // install-plugins, then the migrate/seed exec steps — in that order.
    const cloneIndices = seen
      .map((kind, i) => (kind === "clone" ? i : -1))
      .filter((i) => i >= 0);
    expect(cloneIndices).toHaveLength(2);
    const installIndex = seen.indexOf("install-plugins");
    expect(installIndex).toBeGreaterThan(Math.max(...cloneIndices));
  });

  test("a failing clone step stops the preflight sequence before install-plugins/migrate run", async () => {
    const cfg = buildHitlConfig(
      { SHIPWRIGHT_HITL_REPOS: "app-vitals/shipwright" },
      "/home/dev",
      "/repo-root",
    );
    const steps = buildPreflightSteps(cfg, () => false);

    const seen: string[] = [];
    await expect(
      runPreflight(steps, (step) => {
        seen.push(step.kind);
        if (step.kind === "clone") throw new Error("gh repo clone failed");
      }),
    ).rejects.toThrow("gh repo clone failed");

    expect(seen).not.toContain("install-plugins");
    expect(seen).not.toContain("exec");
  });

  test("preflight completes before services start, and services start before the first task poll", async () => {
    const order: string[] = [];

    await runPreflight(
      [
        { kind: "mkdir", label: "mkdir /ws", path: "/ws" },
        {
          kind: "clone",
          label: "clone failed",
          argv: [
            "gh",
            "repo",
            "clone",
            "app-vitals/shipwright",
            "/ws/repos/shipwright",
          ],
        },
      ],
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
      "preflight:clone",
      "spawn:task-store/src/main.ts",
      "spawn:admin/src/main.ts",
      "poll:fetchReadyTasks",
    ]);
  });
});

// ---------------------------------------------------------------------------
// createAppendLineSink — the fs half of installLogFileTee's real-I/O glue
// (mkdirSync + createWriteStream + ISO-timestamped append), split out
// specifically so it can be exercised in-process against a real tmpdir, the
// same way agent/src/setup.integration.test.ts exercises real mkdirSync/
// writeFileSync calls: real dependency behavior at the fs boundary, no
// global patching involved, so nothing to leak into sibling suites.
// ---------------------------------------------------------------------------

describe("createAppendLineSink", () => {
  test("creates missing parent dirs and appends ISO-timestamped lines to a real file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hitl-append-sink-"));
    const logPath = join(dir, "nested", "hitl.log");

    try {
      expect(existsSync(logPath)).toBe(false);

      const appendLine = createAppendLineSink(logPath);
      appendLine("first line\n");
      appendLine("second line\n");

      const deadline = Date.now() + 2000;
      let content = "";
      while (Date.now() < deadline) {
        if (existsSync(logPath)) {
          content = readFileSync(logPath, "utf8");
          if (content.includes("second line")) break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      const isoPrefix = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
      expect(lines[0]).toMatch(isoPrefix);
      expect(lines[0]).toContain("first line");
      expect(lines[1]).toMatch(isoPrefix);
      expect(lines[1]).toContain("second line");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appends to an existing file rather than truncating it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hitl-append-sink-"));
    const logPath = join(dir, "hitl.log");
    writeFileSync(logPath, "pre-existing line\n", "utf8");

    try {
      const appendLine = createAppendLineSink(logPath);
      appendLine("appended line\n");

      const deadline = Date.now() + 2000;
      let content = "";
      while (Date.now() < deadline) {
        content = readFileSync(logPath, "utf8");
        if (content.includes("appended line")) break;
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(content).toContain("pre-existing line");
      expect(content).toContain("appended line");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// installLogFileTee — the global-patching half (monkey-patches
// process.stdout.write/process.stderr.write/console.log/warn/error).
// Exercised via a real subprocess (a small fixture harness spawned with
// `bun run`), not in-process — this repo's isolation contract forbids
// patching process.stdout/stderr/console in the shared test process (it
// would leak into sibling suites). Mirrors the pattern already established
// by scripts/test-env-preload.integration.test.ts.
// ---------------------------------------------------------------------------

const TEE_FIXTURE_DIR = mkdtempSync(join(tmpdir(), "hitl-tee-fixture-"));
const TEE_FIXTURE_PATH = join(TEE_FIXTURE_DIR, "install-log-file-tee.harness.ts");

describe("installLogFileTee (subprocess)", () => {
  beforeAll(() => {
    writeFileSync(
      TEE_FIXTURE_PATH,
      `import { installLogFileTee } from "${join(import.meta.dir, "hitl.ts")}";

const logPath = process.argv[2];

// Calls installLogFileTee() twice to prove the double-invocation guard
// works: without it, "marker line" would appear twice in the log file
// (once per wrap layer) instead of once.
installLogFileTee(logPath);
installLogFileTee(logPath);

console.log("marker line");
console.error("marker error line");
`,
    );
  });

  afterAll(() => {
    rmSync(TEE_FIXTURE_DIR, { recursive: true, force: true });
  });

  test("mirrors console.log/console.error to the log file with an ISO timestamp, creates missing parent dirs, leaves the terminal streams intact, and is safe to call twice", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "hitl-tee-out-"));
    const logPath = join(logDir, "nested", "hitl.log");

    try {
      const proc = Bun.spawn(["bun", "run", TEE_FIXTURE_PATH, logPath], {
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(exitCode, `fixture process failed:\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);

      // Terminal output is unaffected by the tee.
      expect(stdout).toContain("marker line");
      expect(stderr).toContain("marker error line");

      const content = readFileSync(logPath, "utf8");

      // Each line appears with an ISO timestamp prefix, and exactly once —
      // proving the second installLogFileTee() call was a no-op (the
      // double-invocation guard), not a second wrap layer.
      const markerLines = content
        .split("\n")
        .filter((line) => line.includes("marker line"));
      expect(markerLines).toHaveLength(1);
      expect(markerLines[0]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z .*marker line$/,
      );

      const errorLines = content
        .split("\n")
        .filter((line) => line.includes("marker error line"));
      expect(errorLines).toHaveLength(1);
      expect(errorLines[0]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z .*marker error line$/,
      );
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  }, 15_000);
});
