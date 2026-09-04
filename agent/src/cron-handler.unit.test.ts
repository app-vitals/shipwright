/**
 * Unit tests for cron-handler.ts's preCheck runner.
 *
 * Strategy: inject a FAKE spawner (matching `typeof Bun.spawn`'s shape) via
 * `CronHandlerDeps.spawner` instead of letting the real Bun.spawn(["bun",
 * scriptPath]) execute a child process. This removes the CI-timing
 * dependency that came from spawning ~15 real bun processes per test run
 * (see PR #3006 / CPS-1.1) — no real subprocess behavior is exercised here.
 * Mirrors claude.unit.test.ts's fakeProc/mockSpawn pattern.
 *
 * Path-resolution tests (script-not-found via plugin format, manifest
 * resolution, relative/absolute path resolution) still touch the real
 * filesystem (existsSync) since that logic runs before the spawn call, but
 * the actual spawn once a scriptPath is found still goes through the fake
 * spawner.
 *
 * No test in this suite spawns a real subprocess, including the
 * `spawner ?? Bun.spawn` default-fallback itself — that default is a single
 * destructuring assignment (cron-handler.ts:176), the same shape as
 * claude.ts's `spawner: typeof Bun.spawn = Bun.spawn`, whose own test suite
 * (claude.unit.test.ts) likewise never exercises the real-Bun.spawn path
 * with an actual child process. An earlier revision of this suite kept one
 * real-subprocess integration test to "verify the wiring end-to-end"; it was
 * removed after real subprocess spawns were identified as the likely source
 * of intermittent CI failures (random `Cannot call describe()/afterEach()
 * after the test run has completed` errors in unrelated files under GH
 * Actions load) — see CPS-1.1.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebClient } from "@slack/web-api";
import type { ModelUsage, TokenUsage } from "./claude.ts";
import { handleCronRequest } from "./cron-handler.ts";

// ─── Fake spawn helpers (mirrors claude.unit.test.ts) ──────────────────────

interface FakeProc {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
}

function bodyStream(content: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(content));
      controller.close();
    },
  });
}

function fakeProc(stdout: string, stderr = "", exitCode = 0): FakeProc {
  return {
    stdout: bodyStream(stdout),
    stderr: bodyStream(stderr),
    exited: Promise.resolve(exitCode),
    kill: () => {},
  };
}

// ─── Shared mocks ─────────────────────────────────────────────────────────────

const mockPostMessage = mock(() =>
  Promise.resolve({ ok: true, ts: "1234567890.000001" }),
);
const mockConversationsOpen = mock(() =>
  Promise.resolve({ channel: { id: "D_DM_CHANNEL" } }),
);
const mockSlack = {
  chat: { postMessage: mockPostMessage },
  conversations: { open: mockConversationsOpen },
} as unknown as WebClient;

const mockRunner = mock(
  (): Promise<{
    result: string;
    sessionId?: string;
    usage?: TokenUsage;
    totalCostUsd?: number;
    modelUsage?: ModelUsage;
    streamIncomplete?: boolean;
  }> => Promise.resolve({ result: "claude reply", sessionId: "sess-1" }),
);

let mockSpawn: ReturnType<
  typeof mock<(...args: unknown[]) => ReturnType<typeof Bun.spawn>>
>;

const deps = {
  slack: mockSlack,
  runner: mockRunner,
  formatter: (text: string) => text, // identity — no markdown conversion in tests
};

afterEach(() => {
  mockPostMessage.mockClear();
  mockConversationsOpen.mockClear();
  mockRunner.mockClear();
});

// ─── preCheck ─────────────────────────────────────────────────────────────────

describe("handleCronRequest — preCheck", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
    mkdirSync(join(tmpDir, "shipwright", "scripts"), { recursive: true });
    mockSpawn = mock(() => fakeProc("") as ReturnType<typeof Bun.spawn>);
  });

  test("skips job when preCheck script exits 1 (no work)", async () => {
    const script = join(tmpDir, "check.ts");
    writeFileSync(script, "process.exit(1);");
    mockSpawn = mock(() => fakeProc("", "", 1) as ReturnType<typeof Bun.spawn>);

    await handleCronRequest(
      { jobId: "j1", prompt: "hello", channel: "C-TEST", preCheck: script },
      { ...deps, spawner: mockSpawn as unknown as typeof Bun.spawn },
    );

    expect(mockRunner).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test("uses preCheck output as prompt when it exits 0 with output", async () => {
    const script = join(tmpDir, "check.ts");
    writeFileSync(script, `console.log("precheck prompt"); process.exit(0);`);
    mockSpawn = mock(
      () =>
        fakeProc("precheck prompt\n", "", 0) as ReturnType<typeof Bun.spawn>,
    );

    await handleCronRequest(
      { jobId: "j1", prompt: "original", channel: "C-TEST", preCheck: script },
      { ...deps, spawner: mockSpawn as unknown as typeof Bun.spawn },
    );

    expect(mockRunner).toHaveBeenCalledTimes(1);
    const runArg = (mockRunner.mock.calls as unknown as string[][])[0][0];
    expect(runArg).toContain("precheck prompt");
  });

  test("preCheck inherits runtime process.env mutations (env: process.env passthrough)", async () => {
    // config-sync mutates process.env at runtime (Object.assign every 60s). The
    // preCheck child must see those mutations, not a Bun-startup snapshot —
    // regression for a rotated SHIPWRIGHT_TASK_STORE_TOKEN causing 401s until
    // the pod restarted. Since the fake spawner replaces the real subprocess,
    // this is now verified by asserting the spawner was CALLED with
    // `env: process.env` (the same live object reference), rather than by
    // observing a real child process read a mutated env var.
    const script = join(tmpDir, "check.ts");
    writeFileSync(script, `console.log("ok"); process.exit(0);`);
    mockSpawn = mock(
      () => fakeProc("ok\n", "", 0) as ReturnType<typeof Bun.spawn>,
    );

    await handleCronRequest(
      {
        jobId: "j1",
        prompt: "original",
        channel: "C-TEST",
        preCheck: script,
      },
      { ...deps, spawner: mockSpawn as unknown as typeof Bun.spawn },
    );

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, opts] = mockSpawn.mock.calls[0] as [
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    // Must be the SAME live process.env object (not a boot-time snapshot) so
    // runtime mutations (e.g. config-sync's Object.assign) are visible.
    expect(opts.env).toBe(process.env);
  });

  test("runs preCheck with cwd = workspace (resolves state relative to workspace)", async () => {
    // Plugin preChecks resolve state relative to process.cwd() — e.g.
    // check-review.ts / check-deploy.ts (via check-helpers.ts) read
    // workspace-relative files like `state/agent-policy.md`. The preCheck
    // must run with cwd rooted at the workspace, not the agent's cwd (/app in
    // prod). Verified here via the fake spawner's recorded call opts, since
    // the fake replaces the real subprocess entirely.
    const ws = join(tmpDir, "ws");
    mkdirSync(join(ws, "state"), { recursive: true });
    writeFileSync(join(ws, "state", "agent-policy.md"), "# Agent Policy\n");
    const script = join(tmpDir, "check.ts");
    writeFileSync(
      script,
      `import { existsSync } from "node:fs";\nconsole.log(existsSync("state/agent-policy.md") ? "HAS_STATE" : "NO_STATE");\nprocess.exit(0);`,
    );
    mockSpawn = mock(
      () => fakeProc("HAS_STATE\n", "", 0) as ReturnType<typeof Bun.spawn>,
    );

    await handleCronRequest(
      { jobId: "j1", prompt: "original", channel: "C-TEST", preCheck: script },
      {
        ...deps,
        workspace: ws,
        spawner: mockSpawn as unknown as typeof Bun.spawn,
      },
    );

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, opts] = mockSpawn.mock.calls[0] as [string[], { cwd: string }];
    expect(opts.cwd).toBe(ws);

    expect(mockRunner).toHaveBeenCalledTimes(1);
    const runArg = (mockRunner.mock.calls as unknown as string[][])[0][0];
    expect(runArg).toContain("HAS_STATE");
  });

  test("skips job when preCheck script not found (plugin: format)", async () => {
    await handleCronRequest(
      {
        jobId: "j1",
        prompt: "hello",
        channel: "C-TEST",
        preCheck: "nonexistent-plugin:check.ts",
      },
      {
        ...deps,
        pluginCacheDir: tmpDir,
        spawner: mockSpawn as unknown as typeof Bun.spawn,
      },
    );

    expect(mockRunner).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test("preCheck exits 2 → session skipped, runner NOT called, alert posted to alertsChannel", async () => {
    const scriptPath = join(
      tmpDir,
      "shipwright",
      "scripts",
      "check-dev-task.ts",
    );
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bun\nprocess.stderr.write("something blew up\\n");\nprocess.exit(2);\n`,
      { mode: 0o755 },
    );
    mockSpawn = mock(
      () =>
        fakeProc("", "something blew up\n", 2) as ReturnType<typeof Bun.spawn>,
    );

    await handleCronRequest(
      {
        jobId: "precheck-crash",
        prompt: "original prompt",
        silent: true,
        preCheck: "shipwright:check-dev-task.ts",
      },
      {
        ...deps,
        pluginCacheDir: tmpDir,
        alertsChannel: "C_ALERTS",
        spawner: mockSpawn as unknown as typeof Bun.spawn,
      },
    );

    expect(mockRunner).not.toHaveBeenCalled();
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const call = (
      mockPostMessage.mock.calls as unknown as unknown[][]
    )[0][0] as {
      channel: string;
      text: string;
    };
    expect(call.channel).toBe("C_ALERTS");
    expect(call.text).toContain("precheck-crash");
    expect(call.text).toContain("exit 2");
  });

  test("preCheck exits 2 with no alertsChannel → session skipped, no alert, no throw", async () => {
    const scriptPath = join(
      tmpDir,
      "shipwright",
      "scripts",
      "check-dev-task.ts",
    );
    writeFileSync(scriptPath, "#!/usr/bin/env bun\nprocess.exit(2);\n", {
      mode: 0o755,
    });
    mockSpawn = mock(() => fakeProc("", "", 2) as ReturnType<typeof Bun.spawn>);

    await expect(
      handleCronRequest(
        {
          jobId: "precheck-crash-no-alert",
          prompt: "original prompt",
          silent: true,
          preCheck: "shipwright:check-dev-task.ts",
        },
        {
          ...deps,
          pluginCacheDir: tmpDir,
          spawner: mockSpawn as unknown as typeof Bun.spawn,
        },
      ),
    ).resolves.toBeUndefined();

    expect(mockRunner).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test("preCheck exits 0 with no output → session skipped, runner NOT called", async () => {
    const scriptPath = join(
      tmpDir,
      "shipwright",
      "scripts",
      "check-dev-task.ts",
    );
    writeFileSync(scriptPath, "#!/usr/bin/env bun\nprocess.exit(0);\n", {
      mode: 0o755,
    });
    mockSpawn = mock(() => fakeProc("", "", 0) as ReturnType<typeof Bun.spawn>);

    await handleCronRequest(
      {
        jobId: "precheck-no-output",
        prompt: "original prompt",
        silent: true,
        preCheck: "shipwright:check-dev-task.ts",
      },
      {
        ...deps,
        pluginCacheDir: tmpDir,
        spawner: mockSpawn as unknown as typeof Bun.spawn,
      },
    );

    expect(mockRunner).not.toHaveBeenCalled();
  });

  test("preCheck script not found → warning logged, runner NOT called, no throw", async () => {
    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    try {
      await expect(
        handleCronRequest(
          {
            jobId: "precheck-missing",
            prompt: "original prompt",
            silent: true,
            preCheck: "shipwright:check-dev-task.ts",
          },
          {
            ...deps,
            pluginCacheDir: tmpDir,
            spawner: mockSpawn as unknown as typeof Bun.spawn,
          },
        ),
      ).resolves.toBeUndefined();

      expect(mockRunner).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(
        warnMessages.some((m) => m.includes("preCheck script not found")),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("preCheck resolves via installed_plugins.json manifest (production path)", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "cron-precheck-install-"));
    const installPath = join(installDir, "shipwright");
    mkdirSync(join(installPath, "scripts"), { recursive: true });

    const scriptPath = join(installPath, "scripts", "check-dev-task.ts");
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bun\nconsole.log("manifest path works");\nprocess.exit(0);\n`,
      { mode: 0o755 },
    );

    const manifestDir = mkdtempSync(join(tmpdir(), "cron-precheck-manifest-"));
    const manifestPath = join(manifestDir, "installed_plugins.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 2,
        plugins: {
          "shipwright@app-vitals/shipwright": [{ installPath }],
        },
      }),
    );

    mockSpawn = mock(
      () =>
        fakeProc("manifest path works\n", "", 0) as ReturnType<
          typeof Bun.spawn
        >,
    );

    // biome-ignore lint/suspicious/noExplicitAny: test mock — sessionId optional
    mockRunner.mockResolvedValueOnce({ result: "done [silent]" } as any);

    await handleCronRequest(
      {
        jobId: "precheck-manifest",
        prompt: "original prompt",
        silent: true,
        preCheck: "shipwright:check-dev-task.ts",
      },
      {
        ...deps,
        pluginManifestPath: manifestPath,
        spawner: mockSpawn as unknown as typeof Bun.spawn,
      },
    );

    expect(mockRunner).toHaveBeenCalledTimes(1);
    const runArg = (mockRunner.mock.calls as unknown as string[][])[0][0];
    expect(runArg).toContain("manifest path works");
  });

  test("preCheck manifest path: missing plugins.json → warning logged, runner NOT called", async () => {
    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    try {
      await expect(
        handleCronRequest(
          {
            jobId: "precheck-nomanifest",
            prompt: "original prompt",
            silent: true,
            preCheck: "shipwright:check-dev-task.ts",
          },
          {
            ...deps,
            pluginManifestPath: join(
              tmpDir,
              "nonexistent_installed_plugins.json",
            ),
            spawner: mockSpawn as unknown as typeof Bun.spawn,
          },
        ),
      ).resolves.toBeUndefined();

      expect(mockRunner).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(
        warnMessages.some(
          (m) =>
            m.includes("failed to read installed_plugins.json") ||
            m.includes("preCheck script not found"),
        ),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("relative path (./scripts/check.ts) resolves against workspace, output becomes prompt", async () => {
    const tmpWorkspace = mkdtempSync(join(tmpdir(), "cron-precheck-relpath-"));
    mkdirSync(join(tmpWorkspace, "scripts"), { recursive: true });
    const scriptPath = join(tmpWorkspace, "scripts", "check.ts");
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bun\nconsole.log("workspace task found");\nprocess.exit(0);\n`,
      { mode: 0o755 },
    );

    mockSpawn = mock(
      () =>
        fakeProc("workspace task found\n", "", 0) as ReturnType<
          typeof Bun.spawn
        >,
    );

    // biome-ignore lint/suspicious/noExplicitAny: test mock — sessionId optional
    mockRunner.mockResolvedValueOnce({ result: "done [silent]" } as any);

    await handleCronRequest(
      {
        jobId: "precheck-relpath",
        prompt: "original prompt",
        silent: true,
        preCheck: "./scripts/check.ts",
      },
      {
        ...deps,
        workspace: tmpWorkspace,
        spawner: mockSpawn as unknown as typeof Bun.spawn,
      },
    );

    expect(mockRunner).toHaveBeenCalledTimes(1);
    const runArg = (mockRunner.mock.calls as unknown as string[][])[0][0];
    expect(runArg).toContain("workspace task found");
  });

  test("absolute path resolves directly regardless of workspace", async () => {
    const absDir = mkdtempSync(join(tmpdir(), "cron-precheck-abs-"));
    const scriptPath = join(absDir, "absolute-check.ts");
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bun\nconsole.log("absolute path works");\nprocess.exit(0);\n`,
      { mode: 0o755 },
    );

    mockSpawn = mock(
      () =>
        fakeProc("absolute path works\n", "", 0) as ReturnType<
          typeof Bun.spawn
        >,
    );

    // biome-ignore lint/suspicious/noExplicitAny: test mock — sessionId optional
    mockRunner.mockResolvedValueOnce({ result: "done [silent]" } as any);

    await handleCronRequest(
      {
        jobId: "precheck-absolute",
        prompt: "original prompt",
        silent: true,
        preCheck: scriptPath,
      },
      { ...deps, spawner: mockSpawn as unknown as typeof Bun.spawn },
    );

    expect(mockRunner).toHaveBeenCalledTimes(1);
    const runArg = (mockRunner.mock.calls as unknown as string[][])[0][0];
    expect(runArg).toContain("absolute path works");
  });

  test("relative path without workspace → warning, runner NOT called", async () => {
    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    try {
      await expect(
        handleCronRequest(
          {
            jobId: "precheck-relpath-noworkspace",
            prompt: "original prompt",
            silent: true,
            preCheck: "./scripts/check.ts",
          },
          { ...deps, spawner: mockSpawn as unknown as typeof Bun.spawn },
        ),
      ).resolves.toBeUndefined();

      expect(mockRunner).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(
        warnMessages.some(
          (m) => m.includes("relative") || m.includes("workspace"),
        ),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("relative path script not found → warning, runner NOT called", async () => {
    const tmpWorkspace = mkdtempSync(join(tmpdir(), "cron-precheck-notfound-"));
    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    try {
      await expect(
        handleCronRequest(
          {
            jobId: "precheck-relpath-notfound",
            prompt: "original prompt",
            silent: true,
            preCheck: "./nonexistent.ts",
          },
          {
            ...deps,
            workspace: tmpWorkspace,
            spawner: mockSpawn as unknown as typeof Bun.spawn,
          },
        ),
      ).resolves.toBeUndefined();

      expect(mockRunner).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(
        warnMessages.some((m) => m.includes("preCheck script not found")),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ─── SLACK_CHANNEL_ID extraEnv (STC-1.3) ───────────────────────────────────────

describe("handleCronRequest — SLACK_CHANNEL_ID extraEnv (STC-1.3)", () => {
  test("channel job → runner receives { SLACK_CHANNEL_ID: <channel> } extraEnv, no SLACK_THREAD_TS", async () => {
    await handleCronRequest(
      { jobId: "j1", prompt: "hello", channel: "C-TEST" },
      deps,
    );

    expect(mockRunner).toHaveBeenCalledTimes(1);
    const call = mockRunner.mock.calls[0] as unknown as [
      string,
      unknown,
      Record<string, string> | undefined,
    ];
    expect(call[2]).toEqual({ SLACK_CHANNEL_ID: "C-TEST" });
  });

  test("user (DM) job, conversations.open succeeds → runner receives the DM channel id as SLACK_CHANNEL_ID, and post-run delivery reuses it (no second conversations.open call)", async () => {
    await handleCronRequest(
      { jobId: "dm-j1", prompt: "hello", user: "U-DAN" },
      deps,
    );

    expect(mockRunner).toHaveBeenCalledTimes(1);
    const call = mockRunner.mock.calls[0] as unknown as [
      string,
      unknown,
      Record<string, string> | undefined,
    ];
    expect(call[2]).toEqual({ SLACK_CHANNEL_ID: "D_DM_CHANNEL" });

    // Opened once (pre-run) and reused for post-run delivery — never opened twice.
    expect(mockConversationsOpen).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(
      (mockPostMessage.mock.calls as unknown as unknown[][])[0][0],
    ).toMatchObject({ channel: "D_DM_CHANNEL" });
  });

  test("user (DM) job, conversations.open rejects → runner still called with no SLACK_CHANNEL_ID, [agent:cron] warning logged, post-run falls back to a second conversations.open call", async () => {
    mockConversationsOpen.mockRejectedValueOnce(
      new Error("slack network error"),
    );

    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    try {
      await handleCronRequest(
        { jobId: "dm-j2", prompt: "hello", user: "U-DAN" },
        deps,
      );
    } finally {
      console.warn = originalWarn;
    }

    expect(mockRunner).toHaveBeenCalledTimes(1);
    const call = mockRunner.mock.calls[0] as unknown as [
      string,
      unknown,
      Record<string, string> | undefined,
    ];
    expect(call[2]).toBeUndefined();

    expect(warnMessages.some((m) => m.includes("[agent:cron]"))).toBe(true);

    // Pre-resolution failed — post-run falls back to opening the DM again.
    expect(mockConversationsOpen).toHaveBeenCalledTimes(2);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(
      (mockPostMessage.mock.calls as unknown as unknown[][])[0][0],
    ).toMatchObject({ channel: "D_DM_CHANNEL" });
  });

  test("silent job with neither channel nor user → runner called with no extraEnv", async () => {
    await handleCronRequest(
      { jobId: "silent-j1", prompt: "hello", silent: true },
      deps,
    );

    expect(mockRunner).toHaveBeenCalledTimes(1);
    const call = mockRunner.mock.calls[0] as unknown as [
      string,
      unknown,
      Record<string, string> | undefined,
    ];
    expect(call[2]).toBeUndefined();
  });
});
