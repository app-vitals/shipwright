/**
 * Tests for agent/src/hooks.ts
 *
 * Strategy: real temp dirs for hook resolution (matching the preCheck tests'
 * house style), an injected spawner double so no real hook process runs, and an
 * injected CronRunReporter double for the cron-handler propagation test. No
 * mock.module() calls.
 */

import "./test-env.ts";
import { describe, expect, mock, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatPoller } from "./chat-poller.ts";
import type { ClaudeRunResult } from "./claude.ts";
import { handleCronRequest } from "./cron-handler.ts";
import type { CronRunReporter } from "./cron-run-reporter.ts";
import {
  HookError,
  parseCommand,
  resolveHookScripts,
  withCommandHooks,
} from "./hooks.ts";
import type { ChatServiceClient } from "./http-chat-service-client.ts";

// ─── Spawner double ───────────────────────────────────────────────────────────

interface FakeProc {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
}

function stream(content: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(content));
      c.close();
    },
  });
}

function fakeProc(stderr = "", exitCode = 0): FakeProc {
  return {
    stdout: stream(""),
    stderr: stream(stderr),
    exited: Promise.resolve(exitCode),
    kill: () => {},
  };
}

function hangingProc(): FakeProc & { killed: () => boolean } {
  let resolveExited!: (code: number) => void;
  let wasKilled = false;
  const exited = new Promise<number>((r) => {
    resolveExited = r;
  });
  return {
    stdout: stream(""),
    stderr: stream(""),
    exited,
    kill: () => {
      wasKilled = true;
      resolveExited(143);
    },
    killed: () => wasKilled,
  };
}

interface SpawnCall {
  cmd: string[];
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: Uint8Array;
  };
}

function recordingSpawner(procs: FakeProc[]): {
  spawner: typeof Bun.spawn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  let i = 0;
  const spawner = ((cmd: string[], opts: SpawnCall["opts"]) => {
    calls.push({ cmd, opts });
    return procs[i++] ?? fakeProc();
  }) as unknown as typeof Bun.spawn;
  return { spawner, calls };
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function writeExec(path: string, body = "#!/usr/bin/env bash\nexit 0\n"): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** Creates `<cacheDir>/<plugin>/hooks/<plugin>:<command>.pre/<file>` (executable). */
function seedPluginHook(
  cacheDir: string,
  plugin: string,
  target: string,
  file: string,
): string {
  const dir = join(cacheDir, plugin, "hooks", `${target}.pre`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeExec(path);
  return path;
}

/** Creates `<workspace>/state/hooks/<target>.pre/<file>` (executable). */
function seedWorkspaceHook(
  workspace: string,
  target: string,
  file: string,
): string {
  const dir = join(workspace, "state", "hooks", `${target}.pre`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeExec(path);
  return path;
}

const tmp = () => mkdtempSync(join(tmpdir(), "hooks-test-"));

const okResult: ClaudeRunResult = { result: "ran", sessionId: "s1" };

// ─── parseCommand ─────────────────────────────────────────────────────────────

describe("parseCommand", () => {
  test("parses a loop-dispatch message (command at index 0)", () => {
    expect(parseCommand("/shipwright:dev-task acme/x#1")).toEqual({
      plugin: "shipwright",
      command: "dev-task",
    });
  });

  test("parses through the cron-handler wrapper line", () => {
    const msg =
      "[Cron job: my-job] Current time: 1/1/2026\n\n/custom:review-foundry acme/x#2";
    expect(parseCommand(msg)).toEqual({
      plugin: "custom",
      command: "review-foundry",
    });
  });

  test("returns undefined for a non-slash-command message", () => {
    expect(parseCommand("hello, please summarize the day")).toBeUndefined();
  });

  test("returns undefined for a cron prompt that is natural language", () => {
    const msg = "[Cron job: daily] Current time: 1/1/2026\n\nSummarize the day";
    expect(parseCommand(msg)).toBeUndefined();
  });

  test("requires a fully-qualified plugin:command (bare slash command ⇒ none)", () => {
    expect(parseCommand("/dev-task acme/x#1")).toBeUndefined();
  });

  test("allows dots in plugin and command names", () => {
    expect(parseCommand("/shipwright:dev.task acme/x#1")).toEqual({
      plugin: "shipwright",
      command: "dev.task",
    });
  });

  // The Slack handlers prefix every human message before it reaches the
  // runner — formats below are copied from slack.ts's construction.

  test("parses a Slack DM invocation ('[<name>]: ' prefix)", () => {
    expect(
      parseCommand("[Eugene Trapeznikov]: /shipwright:dev-task acme/x#1"),
    ).toEqual({ plugin: "shipwright", command: "dev-task" });
  });

  test("parses a Slack channel thread message ('[Thread message …]' line + name prefix)", () => {
    const msg =
      "[Thread message — respond normally, or use [silent] if no response is needed]\n" +
      "[Eugene Trapeznikov]: /shipwright:patch acme/x#2";
    expect(parseCommand(msg)).toEqual({
      plugin: "shipwright",
      command: "patch",
    });
  });

  test("parses a Slack app_mention (name prefix + bot mention token)", () => {
    expect(
      parseCommand(
        "[Eugene Trapeznikov]: <@U0BOTID> /shipwright:dev-task acme/x#1",
      ),
    ).toEqual({ plugin: "shipwright", command: "dev-task" });
  });

  test("parses an app_mention preceded by a '[Thread context]' history block", () => {
    const msg =
      "[Thread context]\n" +
      "[Alice]: earlier chatter\n" +
      "[end thread context]\n" +
      "\n" +
      "[Eugene]: <@U0BOTID> /custom:review-foundry acme/x#3";
    expect(parseCommand(msg)).toEqual({
      plugin: "custom",
      command: "review-foundry",
    });
  });

  test("a slash command quoted INSIDE the thread-context block does NOT fire", () => {
    const msg =
      "[Thread context]\n" +
      "[Alice]: /shipwright:deploy acme/x#9\n" +
      "[end thread context]\n" +
      "\n" +
      "[Eugene]: <@U0BOTID> what happened here?";
    expect(parseCommand(msg)).toBeUndefined();
  });

  test("returns undefined for a Slack DM that is natural language", () => {
    expect(parseCommand("[Eugene]: how is the deploy going?")).toBeUndefined();
  });
});

// ─── resolveHookScripts ─────────────────────────────────────────────────────

describe("resolveHookScripts — resolution order", () => {
  test("own-plugin, cross-plugin, and workspace hooks in the correct order", () => {
    const cacheDir = tmp();
    const workspace = tmp();
    // Cross-plugin: `custom` attaches to shipwright:dev-task (sorts before shipwright).
    const cross = seedPluginHook(
      cacheDir,
      "custom",
      "shipwright:dev-task",
      "20-b.sh",
    );
    // Own-plugin: shipwright attaches to its own dev-task.
    const own = seedPluginHook(
      cacheDir,
      "shipwright",
      "shipwright:dev-task",
      "10-a.sh",
    );
    // Workspace escape hatch runs last.
    const ws = seedWorkspaceHook(workspace, "shipwright:dev-task", "30-c.sh");

    const scripts = resolveHookScripts(
      { plugin: "shipwright", command: "dev-task" },
      { pluginCacheDir: cacheDir, workspace },
    );

    // Plugins alphabetical (custom < shipwright), workspace last.
    expect(scripts).toEqual([cross, own, ws]);
  });

  test("filename order within a single plugin hook dir", () => {
    const cacheDir = tmp();
    const b = seedPluginHook(
      cacheDir,
      "custom",
      "shipwright:patch",
      "20-second.sh",
    );
    const a = seedPluginHook(
      cacheDir,
      "custom",
      "shipwright:patch",
      "10-first.sh",
    );

    const scripts = resolveHookScripts(
      { plugin: "shipwright", command: "patch" },
      { pluginCacheDir: cacheDir },
    );

    expect(scripts).toEqual([a, b]);
  });

  test("non-executable files are ignored", () => {
    const cacheDir = tmp();
    const dir = join(cacheDir, "custom", "hooks", "shipwright:dev-task.pre");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "not a hook\n"); // no exec bit
    const exec = join(dir, "10-run.sh");
    writeExec(exec);

    const scripts = resolveHookScripts(
      { plugin: "shipwright", command: "dev-task" },
      { pluginCacheDir: cacheDir },
    );

    expect(scripts).toEqual([exec]);
  });

  test("no hook dirs anywhere ⇒ empty list", () => {
    const scripts = resolveHookScripts(
      { plugin: "shipwright", command: "dev-task" },
      { pluginCacheDir: tmp(), workspace: tmp() },
    );
    expect(scripts).toEqual([]);
  });

  test("resolves cross-plugin hooks via installed_plugins.json manifest", () => {
    const installDir = tmp();
    const customRoot = join(installDir, "custom");
    mkdirSync(customRoot, { recursive: true });
    const hook = seedPluginHook(
      installDir,
      "custom",
      "shipwright:dev-task",
      "10-a.sh",
    );

    const manifestDir = tmp();
    const manifestPath = join(manifestDir, "installed_plugins.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 2,
        plugins: {
          "custom@foundryeng/custom": [{ installPath: customRoot }],
          "shipwright@app-vitals/shipwright": [
            { installPath: join(installDir, "shipwright") },
          ],
        },
      }),
    );

    const scripts = resolveHookScripts(
      { plugin: "shipwright", command: "dev-task" },
      { pluginManifestPath: manifestPath },
    );

    expect(scripts).toEqual([hook]);
  });

  test("a dangling symlink in a hook dir throws HookError (fail closed)", () => {
    const cacheDir = tmp();
    const dir = join(cacheDir, "custom", "hooks", "shipwright:dev-task.pre");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(dir, "missing-target.sh"), join(dir, "10-dangling.sh"));

    expect(() =>
      resolveHookScripts(
        { plugin: "shipwright", command: "dev-task" },
        { pluginCacheDir: cacheDir },
      ),
    ).toThrow(HookError);
  });

  test("an absent plugin manifest is the no-hooks passthrough case", async () => {
    const runner = mock((_m: string, _k?: string) => Promise.resolve(okResult));
    const { spawner, calls } = recordingSpawner([]);
    const wrapped = withCommandHooks(runner, {
      pluginManifestPath: join(tmp(), "installed_plugins.json"), // never written
      spawner,
    });

    const out = await wrapped("/shipwright:dev-task acme/x#1");

    expect(out).toBe(okResult);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  test("a corrupt plugin manifest throws HookError and blocks the session (fail closed)", async () => {
    const manifestPath = join(tmp(), "installed_plugins.json");
    writeFileSync(manifestPath, "not json {{");
    const runner = mock((_m: string, _k?: string) => Promise.resolve(okResult));
    const { spawner } = recordingSpawner([]);
    const wrapped = withCommandHooks(runner, {
      pluginManifestPath: manifestPath,
      spawner,
    });

    const err = await wrapped("/shipwright:dev-task acme/x#1").catch((e) => e);

    expect(err).toBeInstanceOf(HookError);
    expect((err as HookError).hookName).toBe(manifestPath);
    expect(runner).not.toHaveBeenCalled();
  });
});

// ─── withCommandHooks — passthrough ──────────────────────────────────────────

describe("withCommandHooks — passthrough (off by default)", () => {
  test("no hooks anywhere ⇒ byte-identical passthrough, spawner never called", async () => {
    const runner = mock((_m: string, _k?: string) => Promise.resolve(okResult));
    const { spawner, calls } = recordingSpawner([]);
    const wrapped = withCommandHooks(runner, {
      pluginCacheDir: tmp(),
      workspace: tmp(),
      spawner,
    });

    const out = await wrapped("/shipwright:dev-task acme/x#1", "chan:ts");

    expect(out).toBe(okResult);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]).toEqual([
      "/shipwright:dev-task acme/x#1",
      "chan:ts",
    ]);
    expect(calls).toHaveLength(0);
  });

  test("non-slash-command message ⇒ passthrough even when hooks exist", async () => {
    const cacheDir = tmp();
    seedPluginHook(cacheDir, "custom", "shipwright:dev-task", "10-a.sh");
    const runner = mock((_m: string, _k?: string) => Promise.resolve(okResult));
    const { spawner, calls } = recordingSpawner([]);
    const wrapped = withCommandHooks(runner, {
      pluginCacheDir: cacheDir,
      spawner,
    });

    await wrapped("just a chat message", undefined);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });
});

// ─── withCommandHooks — execution + context ──────────────────────────────────

describe("withCommandHooks — execution", () => {
  test("runs a resolved hook, then the runner (order + context passed)", async () => {
    const cacheDir = tmp();
    const workspace = tmp();
    const hook = seedPluginHook(
      cacheDir,
      "custom",
      "shipwright:dev-task",
      "10-a.sh",
    );
    const runner = mock((_m: string, _k?: string) => Promise.resolve(okResult));
    const { spawner, calls } = recordingSpawner([fakeProc("", 0)]);

    const message = "/shipwright:dev-task acme/x#1";
    await withCommandHooks(runner, {
      pluginCacheDir: cacheDir,
      workspace,
      spawner,
    })(message, "chan:ts");

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toEqual([hook]);
    expect(calls[0].opts.cwd).toBe(workspace);
    expect(calls[0].opts.env?.SHIPWRIGHT_HOOK_EVENT).toBe("pre");
    expect(calls[0].opts.env?.SHIPWRIGHT_HOOK_COMMAND).toBe(
      "shipwright:dev-task",
    );
    expect(new TextDecoder().decode(calls[0].opts.stdin)).toBe(message);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test("runs multiple hooks sequentially before the runner", async () => {
    const cacheDir = tmp();
    const first = seedPluginHook(
      cacheDir,
      "custom",
      "shipwright:patch",
      "10-a.sh",
    );
    const second = seedPluginHook(
      cacheDir,
      "custom",
      "shipwright:patch",
      "20-b.sh",
    );
    const runner = mock((_m: string, _k?: string) => Promise.resolve(okResult));
    const { spawner, calls } = recordingSpawner([
      fakeProc("", 0),
      fakeProc("", 0),
    ]);

    await withCommandHooks(runner, { pluginCacheDir: cacheDir, spawner })(
      "/shipwright:patch acme/x#2",
    );

    expect(calls.map((c) => c.cmd[0])).toEqual([first, second]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test("guard-abort: nonzero exit throws HookError and the runner never runs", async () => {
    const cacheDir = tmp();
    seedPluginHook(cacheDir, "custom", "shipwright:dev-task", "10-a.sh");
    const runner = mock((_m: string, _k?: string) => Promise.resolve(okResult));
    const { spawner } = recordingSpawner([fakeProc("boom", 1)]);
    const wrapped = withCommandHooks(runner, {
      pluginCacheDir: cacheDir,
      spawner,
    });

    const err = await wrapped("/shipwright:dev-task acme/x#1").catch((e) => e);

    expect(err).toBeInstanceOf(HookError);
    expect((err as HookError).exitCode).toBe(1);
    expect((err as HookError).stderr).toBe("boom");
    expect(runner).not.toHaveBeenCalled();
  });

  test("timeout: a hanging hook is killed and throws a timed-out HookError", async () => {
    const cacheDir = tmp();
    seedPluginHook(cacheDir, "custom", "shipwright:dev-task", "10-a.sh");
    const runner = mock((_m: string, _k?: string) => Promise.resolve(okResult));
    const proc = hangingProc();
    const { spawner } = recordingSpawner([proc]);
    const wrapped = withCommandHooks(runner, {
      pluginCacheDir: cacheDir,
      spawner,
      timeoutMs: 10,
    });

    const err = await wrapped("/shipwright:dev-task acme/x#1").catch((e) => e);

    expect(err).toBeInstanceOf(HookError);
    expect((err as HookError).timedOut).toBe(true);
    expect(proc.killed()).toBe(true);
    expect(runner).not.toHaveBeenCalled();
  });

  test("a later hook is not spawned after an earlier one aborts", async () => {
    const cacheDir = tmp();
    seedPluginHook(cacheDir, "custom", "shipwright:dev-task", "10-a.sh");
    seedPluginHook(cacheDir, "custom", "shipwright:dev-task", "20-b.sh");
    const runner = mock((_m: string, _k?: string) => Promise.resolve(okResult));
    const { spawner, calls } = recordingSpawner([
      fakeProc("nope", 3),
      fakeProc("", 0),
    ]);
    const wrapped = withCommandHooks(runner, {
      pluginCacheDir: cacheDir,
      spawner,
    });

    await wrapped("/shipwright:dev-task acme/x#1").catch(() => {});

    expect(calls).toHaveLength(1); // stopped after the first hook failed
    expect(runner).not.toHaveBeenCalled();
  });

  test("a Slack DM manual invocation fires the same hooks as a loop dispatch", async () => {
    const cacheDir = tmp();
    const hook = seedPluginHook(
      cacheDir,
      "custom",
      "shipwright:dev-task",
      "10-a.sh",
    );
    const runner = mock((_m: string, _k?: string) => Promise.resolve(okResult));
    const { spawner, calls } = recordingSpawner([fakeProc("", 0)]);

    await withCommandHooks(runner, { pluginCacheDir: cacheDir, spawner })(
      "[Eugene Trapeznikov]: /shipwright:dev-task acme/x#1",
      "C123:1.1",
    );

    expect(calls.map((c) => c.cmd[0])).toEqual([hook]);
    expect(calls[0].opts.env?.SHIPWRIGHT_HOOK_COMMAND).toBe(
      "shipwright:dev-task",
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test("real spawn: a SIGTERM-ignoring hook is SIGKILLed after the grace period", async () => {
    const cacheDir = tmp();
    const dir = join(cacheDir, "custom", "hooks", "shipwright:dev-task.pre");
    mkdirSync(dir, { recursive: true });
    writeExec(
      join(dir, "10-stubborn.sh"),
      "#!/usr/bin/env bash\ntrap '' TERM\nwhile true; do sleep 0.05; done\n",
    );
    const runner = mock((_m: string, _k?: string) => Promise.resolve(okResult));
    // No injected spawner — real Bun.spawn, real signals.
    const wrapped = withCommandHooks(runner, {
      pluginCacheDir: cacheDir,
      timeoutMs: 100,
      killGraceMs: 200,
    });

    const started = Date.now();
    const err = await wrapped("/shipwright:dev-task acme/x#1").catch((e) => e);

    expect(err).toBeInstanceOf(HookError);
    expect((err as HookError).timedOut).toBe(true);
    // SIGTERM alone would hang forever — SIGKILL must bound the wait.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(runner).not.toHaveBeenCalled();
  });
});

// ─── HookError through the cron-handler failed-run path ──────────────────────

describe("HookError surfaces as a failed run via cron-handler", () => {
  const mockSlack = {
    chat: { postMessage: mock(() => Promise.resolve({ ok: true, ts: "1.1" })) },
    conversations: {
      open: mock(() => Promise.resolve({ channel: { id: "D" } })),
    },
  } as unknown as Parameters<typeof handleCronRequest>[1]["slack"];

  test("pre-hook failure ⇒ runner not called, run recorded 'failed', error rethrown", async () => {
    const cacheDir = tmp();
    seedPluginHook(cacheDir, "custom", "custom:review-foundry", "10-guard.sh");
    const { spawner } = recordingSpawner([fakeProc("guard rejected", 2)]);

    const innerRunner = mock((_m: string, _k?: string) =>
      Promise.resolve(okResult),
    );
    const hookedRunner = withCommandHooks(innerRunner, {
      pluginCacheDir: cacheDir,
      spawner,
    });

    const completed: Array<{ outcome: string; error?: string }> = [];
    const reporter: CronRunReporter = {
      createRun: async () => "run-1",
      completeRun: async (_c, _r, _t, outcome, opts) => {
        completed.push({ outcome, error: opts?.error });
      },
      skipRun: async () => {},
    };

    await expect(
      handleCronRequest(
        {
          jobId: "review-foundry",
          prompt: "/custom:review-foundry acme/x#3",
          silent: true,
        },
        { slack: mockSlack, runner: hookedRunner, cronRunReporter: reporter },
      ),
    ).rejects.toBeInstanceOf(HookError);

    expect(innerRunner).not.toHaveBeenCalled();
    expect(completed).toHaveLength(1);
    expect(completed[0].outcome).toBe("failed");
    expect(completed[0].error).toContain("review-foundry");
  });
});

// ─── HookError through the chat-poller path ───────────────────────────────────

describe("HookError suppresses a chat-poller session", () => {
  test("pre-hook failure ⇒ runner not called, no reply posted", async () => {
    const cacheDir = tmp();
    seedPluginHook(cacheDir, "custom", "shipwright:dev-task", "10-guard.sh");
    const { spawner } = recordingSpawner([fakeProc("guard rejected", 2)]);

    const innerRunner = mock((_m: string, _k?: string) =>
      Promise.resolve(okResult),
    );
    const hookedRunner = withCommandHooks(innerRunner, {
      pluginCacheDir: cacheDir,
      spawner,
    });

    const replyToMessage = mock(() => Promise.resolve(undefined));
    const client = {
      listThreads: async () => ({
        threads: [{ id: "thread-1" }],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      claimMessage: async () => ({
        id: "msg-1",
        threadId: "thread-1",
        role: "user",
        body: "/shipwright:dev-task acme/x#9",
        attachmentFilename: null,
      }),
      getAttachment: async () => null,
      replyToMessage,
    } as unknown as ChatServiceClient;

    const poller = createChatPoller({ client, runner: hookedRunner });
    await poller.pollOnce();

    expect(innerRunner).not.toHaveBeenCalled();
    expect(replyToMessage).not.toHaveBeenCalled();
  });
});
