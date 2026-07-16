/**
 * Smoke tests for agent/src/hooks.ts — real process spawning.
 *
 * Strategy: this file houses the one command-hook test that deliberately omits
 * the injected spawner to exercise real SIGTERM→SIGKILL signal behavior via
 * `Bun.spawn`. Per `docs/test-readiness/test-system.md`, a test that spawns a
 * real process cannot live in `*.unit.test.ts` ("no process spawning"); the
 * precedent for real-process hook/precheck testing is the smoke layer (see
 * `cron-handler.smoke.test.ts`'s preCheck suite). All other, fixture-based
 * `withCommandHooks` tests remain in `hooks.unit.test.ts` behind an injected
 * spawner double.
 */

import { describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeRunResult } from "./claude.ts";
import { HookError, withCommandHooks } from "./hooks.ts";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function writeExec(path: string, body = "#!/usr/bin/env bash\nexit 0\n"): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

const tmp = () => mkdtempSync(join(tmpdir(), "hooks-smoke-test-"));

const okResult: ClaudeRunResult = { result: "ran", sessionId: "s1" };

// ─── withCommandHooks — real spawn ───────────────────────────────────────────

describe("withCommandHooks — real spawn", () => {
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
