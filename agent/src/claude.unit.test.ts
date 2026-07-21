/**
 * Tests for agent/src/claude.ts
 *
 * Strategy: use createRunClaude(spawner, sessions, model, workspace)
 * to inject all dependencies directly. No mock.module() calls needed anywhere.
 * Note: Identity injection removed — identity is now handled via CLAUDE.md in the workspace.
 */

import "./test-env.ts";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { ErrorCapturingClient } from "@shipwright/lib/sentry";
import { TEST_AGENT_HOME } from "./test-env.ts";

const MODEL = "claude-opus-4-6";
const WORKSPACE = join(TEST_AGENT_HOME, "workspace");

// ─── Import module under test ─────────────────────────────────────────────────

const { createRunClaude, setLiveClaudeConfig, dominantModel } = await import(
  "./claude.ts"
);

// ─── Stream-json fixtures (hand-authored per the public CLI schema) ───────────

const cleanMultiTurn = await import(
  "./fixtures/stream-json/clean-multi-turn.ts"
);
const truncatedNoResult = await import(
  "./fixtures/stream-json/truncated-no-result.ts"
);

// ─── Shared test session store ────────────────────────────────────────────────

const mockGetSession = mock((_key: string): string | undefined => undefined);
const mockSetSession = mock((_key: string, _id: string): void => {});
const mockClearSession = mock((_key: string): void => {});
const testSessions = {
  get: mockGetSession,
  set: mockSetSession,
  clear: mockClearSession,
};

let capturedMessages: string[] = [];
let capturedExceptions: unknown[] = [];
const fakeSentryClient: ErrorCapturingClient = {
  captureException: (err: unknown) => {
    capturedExceptions.push(err);
  },
  captureMessage: (message: string) => {
    capturedMessages.push(message);
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bodyStream(content: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(content));
      controller.close();
    },
  });
}

/**
 * Emits each NDJSON line as its OWN stream chunk (with a trailing newline), so
 * the parser under test is exercised across real chunk boundaries rather than
 * one giant buffered string.
 */
function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(enc.encode(`${line}\n`));
      }
      controller.close();
    },
  });
}

function ndjsonProc(lines: string[], stderr = "", exitCode = 0): FakeProc {
  return {
    stdout: ndjsonStream(lines),
    stderr: bodyStream(stderr),
    exited: Promise.resolve(exitCode),
    kill: () => {},
  };
}

interface FakeProc {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
}

function fakeProc(stdout: string, stderr = "", exitCode = 0): FakeProc {
  return {
    stdout: bodyStream(stdout),
    stderr: bodyStream(stderr),
    exited: Promise.resolve(exitCode),
    kill: () => {},
  };
}

/**
 * A fake proc whose stdout emits one NDJSON line every `intervalMs`, for
 * `count` lines — used to exercise idle-reset-vs-ceiling timer races with
 * short REAL timeouts (consistent with this file's existing convention of
 * small millisecond literals rather than fake-timer injection).
 *
 * When `autoCloseAfterDrip` is true, the stream closes itself (and `exited`
 * resolves with 0) right after the last line — simulating a process that
 * finishes cleanly before any timer fires. When false, the stream is left
 * open after the last line (no close(), no result line) and only `kill()`
 * (called by the idle/ceiling timer under test) closes it — simulating a
 * process a timer has to forcibly stop.
 */
function drippingProc(
  line: string,
  intervalMs: number,
  count: number,
  autoCloseAfterDrip = false,
): FakeProc {
  const enc = new TextEncoder();
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExited = r;
  });
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const close = (code: number) => {
    if (closed) return;
    closed = true;
    streamController.close();
    resolveExited(code);
  };
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      (async () => {
        for (let i = 0; i < count; i++) {
          if (closed) return;
          controller.enqueue(enc.encode(`${line}\n`));
          await new Promise((r) => setTimeout(r, intervalMs));
        }
        if (autoCloseAfterDrip) close(0);
      })();
    },
  });
  return {
    stdout,
    stderr: bodyStream(""),
    exited,
    kill: () => close(143),
  };
}

function hangingProc(): FakeProc & { triggerKill: () => void } {
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExited = r;
  });
  const kill = () => resolveExited(143);
  return {
    stdout: bodyStream(""),
    stderr: bodyStream(""),
    exited,
    kill,
    triggerKill: kill,
  };
}

/**
 * A single terminal stream-json `result` line (the CLI emits exactly one on a
 * clean finish). Its shape is byte-identical to the old `--output-format json`
 * single blob, plus the `type`/`subtype` discriminator.
 */
function jsonOutput(
  result: string,
  sessionId = "sess-abc",
  isError = false,
): string {
  return JSON.stringify({
    type: "result",
    subtype: isError ? "error" : "success",
    result,
    session_id: sessionId,
    is_error: isError,
  });
}

// ─── runClaude tests ──────────────────────────────────────────────────────────

describe("runClaude", () => {
  // biome-ignore lint/suspicious/noExplicitAny: mock return type
  let mockSpawn: any;
  let runClaude: ReturnType<typeof createRunClaude>;

  beforeEach(() => {
    mockGetSession.mockClear();
    mockSetSession.mockClear();
    mockClearSession.mockClear();
    capturedMessages = [];
    capturedExceptions = [];
    mockSpawn = mock(
      () =>
        fakeProc(jsonOutput("Hello from Claude")) as ReturnType<
          typeof Bun.spawn
        >,
    );
    runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
    );
  });

  test("calls spawn with claude as the command", async () => {
    await runClaude("test message");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];
    expect(cmd[0]).toBe("claude");
  });

  test("passes -p flag for non-interactive mode", async () => {
    await runClaude("test");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];
    expect(cmd).toContain("-p");
  });

  test("passes --output-format stream-json --verbose", async () => {
    await runClaude("test");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];
    const idx = cmd.indexOf("--output-format");
    expect(idx).toBeGreaterThan(-1);
    expect(cmd[idx + 1]).toBe("stream-json");
    expect(cmd).toContain("--verbose");
  });

  test("passes --model from config", async () => {
    await runClaude("test");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];
    const idx = cmd.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(cmd[idx + 1]).toBe("claude-opus-4-6");
  });

  test("does not pass --fallback-model when not configured", async () => {
    await runClaude("test");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];
    expect(cmd).not.toContain("--fallback-model");
  });

  test("does not pass --effort when not configured", async () => {
    await runClaude("test");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];
    expect(cmd).not.toContain("--effort");
  });

  test("passes --effort when configured", async () => {
    const runClaudeWithEffort = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
      [],
      undefined,
      "xhigh",
    );
    await runClaudeWithEffort("test");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];
    const idx = cmd.indexOf("--effort");
    expect(idx).toBeGreaterThan(-1);
    expect(cmd[idx + 1]).toBe("xhigh");
  });

  test("passes --fallback-model when configured", async () => {
    const runClaudeWithFallback = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
      [],
      "claude-sonnet-4-6",
    );
    await runClaudeWithFallback("test");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];
    const idx = cmd.indexOf("--fallback-model");
    expect(idx).toBeGreaterThan(-1);
    expect(cmd[idx + 1]).toBe("claude-sonnet-4-6");
  });

  test("passes correct cwd, stdout, stderr spawn options", async () => {
    await runClaude("test");
    const [, opts] = mockSpawn.mock.calls[0] as [
      string[],
      { cwd: string; stdout: string; stderr: string },
    ];
    expect(opts.cwd).toBe(join(TEST_AGENT_HOME, "workspace"));
    expect(opts.stdout).toBe("pipe");
    expect(opts.stderr).toBe("pipe");
  });

  test("passes message as last arg without identity injection", async () => {
    await runClaude("my prompt");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];
    const lastArg = cmd[cmd.length - 1];
    expect(lastArg).toBe("my prompt");
  });

  test("passes raw message when resuming an existing session", async () => {
    mockGetSession.mockReturnValueOnce("existing-sid");
    await runClaude("follow-up question", "chan:ts");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];
    const lastArg = cmd[cmd.length - 1];
    expect(lastArg).toBe("follow-up question");
  });

  test("returns result and sessionId on success", async () => {
    const output = await runClaude("hello");
    expect(output.result).toBe("Hello from Claude");
    expect(output.sessionId).toBe("sess-abc");
  });

  test("returns usage from JSON output when present", async () => {
    const usageJson = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Hello with usage",
      session_id: "sess-usage",
      is_error: false,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 25,
        cache_creation_input_tokens: 10,
      },
    });
    mockSpawn.mockReturnValue(
      fakeProc(usageJson) as ReturnType<typeof Bun.spawn>,
    );
    const output = await runClaude("hello");
    expect(output.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 25,
      cache_creation_input_tokens: 10,
    });
  });

  test("returns undefined usage when not in JSON output", async () => {
    // Default mockSpawn produces jsonOutput("Hello from Claude") which has no usage field
    const output = await runClaude("hello");
    expect(output.usage).toBeUndefined();
  });

  test("without sessionKey does not call getSession or setSession", async () => {
    await runClaude("hello");
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  test("with sessionKey calls getSession to look up existing session", async () => {
    await runClaude("hello", "chan:ts");
    expect(mockGetSession).toHaveBeenCalledWith("chan:ts");
  });

  test("adds -r flag when existing session is found", async () => {
    mockGetSession.mockReturnValueOnce("existing-sid");
    await runClaude("hello", "chan:ts");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];
    const rIdx = cmd.indexOf("-r");
    expect(rIdx).toBeGreaterThan(-1);
    expect(cmd[rIdx + 1]).toBe("existing-sid");
  });

  test("omits -r flag when no existing session", async () => {
    mockGetSession.mockReturnValueOnce(undefined);
    await runClaude("hello", "chan:ts");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];
    expect(cmd).not.toContain("-r");
  });

  test("saves session after successful run when sessionKey provided", async () => {
    await runClaude("hello", "chan:ts");
    expect(mockSetSession).toHaveBeenCalledWith("chan:ts", "sess-abc");
  });

  test("throws on non-zero exit code", async () => {
    mockSpawn.mockReturnValue(
      fakeProc("", "claude: command not found", 127) as ReturnType<
        typeof Bun.spawn
      >,
    );
    await expect(runClaude("hello")).rejects.toThrow("claude exited 127");
  });

  test("non-zero exit error includes stderr in message", async () => {
    mockSpawn.mockReturnValue(
      fakeProc("", "auth failure", 1) as ReturnType<typeof Bun.spawn>,
    );
    await expect(runClaude("hello")).rejects.toThrow("auth failure");
  });

  test("non-zero exit falls back to stdout when stderr is empty", async () => {
    mockSpawn.mockReturnValue(
      fakeProc("stdout fallback msg", "", 2) as ReturnType<typeof Bun.spawn>,
    );
    await expect(runClaude("hello")).rejects.toThrow("stdout fallback msg");
  });

  test("throws on is_error=true in response", async () => {
    mockSpawn.mockReturnValue(
      fakeProc(jsonOutput("tool call failed", "sess-abc", true)) as ReturnType<
        typeof Bun.spawn
      >,
    );
    await expect(runClaude("hello")).rejects.toThrow(
      "claude error: tool call failed",
    );
  });

  test("does not save session when is_error=true", async () => {
    mockSpawn.mockReturnValue(
      fakeProc(jsonOutput("tool error", "sess-abc", true)) as ReturnType<
        typeof Bun.spawn
      >,
    );
    await expect(runClaude("hello", "chan:ts")).rejects.toThrow();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  test("throws ClaudeTimeoutError when process exceeds timeoutMs", async () => {
    const proc = hangingProc();
    const mockSpawnTimeout = mock(
      () => proc as unknown as ReturnType<typeof Bun.spawn>,
    );
    const runClaudeWithTimeout = createRunClaude(
      mockSpawnTimeout as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
      undefined,
      undefined,
      undefined,
      1000, // 1s ceiling headroom — well clear of the idle timeout below
      10, // 10ms idle timeout — hangingProc never emits a line, so idle fires first
    );

    const { ClaudeTimeoutError } = await import("./claude.ts");
    const err = await runClaudeWithTimeout("hello").catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeTimeoutError);
    expect((err as InstanceType<typeof ClaudeTimeoutError>).reason).toBe(
      "idle",
    );
  });

  test("throws ClaudeTimeoutError on stale-session timeout and does not retry (spawn called once)", async () => {
    const proc = hangingProc();
    const mockSpawnTimeout = mock(
      () => proc as unknown as ReturnType<typeof Bun.spawn>,
    );

    mockGetSession.mockClear();
    mockSetSession.mockClear();
    mockClearSession.mockClear();
    // Simulate an existing session so we enter the stale-session catch block
    mockGetSession.mockReturnValueOnce("stale-sid");

    const runClaudeWithTimeout = createRunClaude(
      mockSpawnTimeout as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
      undefined,
      undefined,
      undefined,
      10, // 10ms ceiling timeout
      10, // 10ms idle timeout
    );

    const { ClaudeTimeoutError } = await import("./claude.ts");
    await expect(
      runClaudeWithTimeout("hello", "chan:ts"),
    ).rejects.toBeInstanceOf(ClaudeTimeoutError);
    // Guard prevents retry — spawn must be called exactly once
    expect(mockSpawnTimeout).toHaveBeenCalledTimes(1);
  });

  test("idle-reset-on-activity: frequent stdout lines keep resetting the idle timer, so no timeout occurs even past the idle window", async () => {
    // 6 lines at 15ms apart = 90ms total elapsed, well past the 20ms idle
    // timeout if it were never reset — but each line resets it, so the
    // idle timer never actually lapses. Ceiling (500ms) has ample headroom.
    // The stream auto-closes right after the last line, so the run finishes
    // cleanly (streamIncomplete: true — no result event) instead of hanging.
    const proc = drippingProc(
      JSON.stringify({ type: "system", subtype: "init" }),
      15,
      6,
      true, // autoCloseAfterDrip
    );
    const mockSpawnActivity = mock(
      () => proc as unknown as ReturnType<typeof Bun.spawn>,
    );

    const runClaudeWithIdleReset = createRunClaude(
      mockSpawnActivity as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
      undefined,
      undefined,
      undefined,
      500, // 500ms ceiling — plenty of headroom
      20, // 20ms idle timeout — shorter than total elapsed time, but reset each 15ms line
    );

    const output = await runClaudeWithIdleReset("hello");
    // Stream never got a `result` event but finished cleanly (no timeout) —
    // proves the idle timer never fired despite total elapsed time exceeding
    // its window, because each line kept resetting it.
    expect(output.streamIncomplete).toBe(true);
  });

  test("idle-fires-despite-ceiling-headroom: stdout goes silent past the idle timeout well before the ceiling would fire", async () => {
    const proc = hangingProc(); // never emits a line — silent from the start
    const mockSpawnIdle = mock(
      () => proc as unknown as ReturnType<typeof Bun.spawn>,
    );

    const runClaudeIdleOnly = createRunClaude(
      mockSpawnIdle as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
      undefined,
      undefined,
      undefined,
      5000, // 5s ceiling — nowhere near firing in this test
      15, // 15ms idle timeout — fires quickly since stdout is silent
    );

    const { ClaudeTimeoutError } = await import("./claude.ts");
    const err = await runClaudeIdleOnly("hello").catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeTimeoutError);
    expect((err as InstanceType<typeof ClaudeTimeoutError>).reason).toBe(
      "idle",
    );
  });

  test("ceiling-fires-despite-continuous-activity: stdout lines keep resetting idle indefinitely, but total elapsed exceeds the ceiling", async () => {
    // Lines arrive every 5ms — always resetting the idle timer well before
    // its 30ms window lapses — but the process runs long enough (well past
    // 25ms) that the 25ms ceiling fires first regardless of activity.
    const proc = drippingProc(
      JSON.stringify({ type: "system", subtype: "init" }),
      5,
      50, // enough lines to keep the drip going past the ceiling
    );

    const mockSpawnCeiling = mock(
      () => proc as unknown as ReturnType<typeof Bun.spawn>,
    );

    const runClaudeCeiling = createRunClaude(
      mockSpawnCeiling as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
      undefined,
      undefined,
      undefined,
      25, // 25ms ceiling — fires despite continuous sub-idle-window activity
      30, // 30ms idle timeout — never lapses since lines arrive every 5ms
    );

    const { ClaudeTimeoutError } = await import("./claude.ts");
    const err = await runClaudeCeiling("hello").catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeTimeoutError);
    expect((err as InstanceType<typeof ClaudeTimeoutError>).reason).toBe(
      "ceiling",
    );
  });

  test("non-zero exit with JSON stdout throws ClaudeRunError with api_error_status", async () => {
    const json = JSON.stringify({
      type: "result",
      subtype: "error",
      result: "You've hit your org's monthly usage limit",
      session_id: "sess-x",
      is_error: true,
      api_error_status: 429,
    });
    mockSpawn.mockReturnValue(
      fakeProc(json, "", 1) as ReturnType<typeof Bun.spawn>,
    );
    const { ClaudeRunError } = await import("./claude.ts");
    try {
      await runClaude("hello");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeRunError);
      const e = err as InstanceType<typeof ClaudeRunError>;
      expect(e.apiErrorStatus).toBe(429);
      expect(e.resultMessage).toContain("monthly usage limit");
    }
  });
});

// ─── Stale session fallback tests ─────────────────────────────────────────────

describe("resume retry", () => {
  test("retries the same resumed session once when it fails, then succeeds", async () => {
    let callCount = 0;
    const mockSpawn = mock(() => {
      callCount++;
      if (callCount === 1) {
        // First call (resume) fails
        return fakeProc("", "socket closed", 1) as ReturnType<typeof Bun.spawn>;
      }
      // Second call (retry, same resumed session) succeeds
      return fakeProc(jsonOutput("recovered", "stale-sess-id")) as ReturnType<
        typeof Bun.spawn
      >;
    });

    mockGetSession.mockClear();
    mockSetSession.mockClear();
    mockClearSession.mockClear();
    capturedMessages = [];
    capturedExceptions = [];
    mockGetSession.mockReturnValue("stale-sess-id");

    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
    );

    const result = await runClaude("hello", "chan:ts");

    expect(result.result).toBe("recovered");
    expect(result.sessionId).toBe("stale-sess-id");
    expect(result.recoveredFromError).toBe(true);
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(mockSetSession).toHaveBeenCalledWith("chan:ts", "stale-sess-id");
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    // Verify both calls resumed the SAME session id via -r
    const [firstCmd] = mockSpawn.mock.calls[0] as unknown as [string[]];
    const [secondCmd] = mockSpawn.mock.calls[1] as unknown as [string[]];
    const firstRIdx = firstCmd.indexOf("-r");
    const secondRIdx = secondCmd.indexOf("-r");
    expect(firstRIdx).toBeGreaterThan(-1);
    expect(secondRIdx).toBeGreaterThan(-1);
    expect(firstCmd[firstRIdx + 1]).toBe("stale-sess-id");
    expect(secondCmd[secondRIdx + 1]).toBe("stale-sess-id");
  });

  test("does not retry when there is no existing session (fresh call fails)", async () => {
    const mockSpawn = mock(
      () => fakeProc("", "auth failure", 1) as ReturnType<typeof Bun.spawn>,
    );

    mockGetSession.mockClear();
    mockGetSession.mockReturnValue(undefined);

    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
    );

    await expect(runClaude("hello")).rejects.toThrow("auth failure");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  test("throws if both resume attempts fail, preserving the session mapping", async () => {
    const mockSpawn = mock(
      () => fakeProc("", "total failure", 1) as ReturnType<typeof Bun.spawn>,
    );

    // Stateful in-memory session store double — NOT the module-level spy mocks.
    const store = new Map<string, string>([["chan:ts", "stale-sess"]]);
    const clearSpy = mock((_key: string): void => {});
    const statefulSessions = {
      get: (key: string) => store.get(key),
      set: (key: string, id: string) => {
        store.set(key, id);
      },
      clear: clearSpy,
    };

    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      statefulSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
    );

    await expect(runClaude("hello", "chan:ts")).rejects.toThrow(
      "total failure",
    );
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(clearSpy).not.toHaveBeenCalled();
    // The mapping must still point at the original session id.
    expect(store.get("chan:ts")).toBe("stale-sess");
    // Retry-exhausted case is reported to Sentry with the ORIGINAL error.
    expect(capturedExceptions).toHaveLength(1);
    expect((capturedExceptions[0] as Error).message).toContain("total failure");
  });

  test("does not report to Sentry when the retry succeeds", async () => {
    let callCount = 0;
    const mockSpawn = mock(() => {
      callCount++;
      if (callCount === 1) {
        return fakeProc("", "socket closed", 1) as ReturnType<typeof Bun.spawn>;
      }
      return fakeProc(jsonOutput("recovered", "stale-sess-id")) as ReturnType<
        typeof Bun.spawn
      >;
    });

    mockGetSession.mockClear();
    mockSetSession.mockClear();
    mockClearSession.mockClear();
    capturedExceptions = [];
    mockGetSession.mockReturnValue("stale-sess-id");

    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
    );

    const result = await runClaude("hello", "chan:ts");

    expect(result.recoveredFromError).toBe(true);
    expect(capturedExceptions).toHaveLength(0);
  });
});

// ─── _enqueue serialization tests ────────────────────────────────────────────

describe("_enqueue (via runClaude with sessionKey)", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockSetSession.mockReset();
    mockClearSession.mockReset();
  });

  test("second call with same key waits for first to complete before spawning", async () => {
    let spawnCount = 0;
    let resolveFirst!: (code: number) => void;
    const firstExited = new Promise<number>((r) => {
      resolveFirst = r;
    });

    const mockSpawn = mock(() => {
      spawnCount++;
      const exited = spawnCount === 1 ? firstExited : Promise.resolve(0);
      return {
        stdout: bodyStream(jsonOutput(`result-${spawnCount}`)),
        stderr: bodyStream(""),
        exited,
      } as ReturnType<typeof Bun.spawn>;
    });
    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
    );

    const p1 = runClaude("msg1", "serial-key");
    const p2 = runClaude("msg2", "serial-key");

    await new Promise((r) => setTimeout(r, 0));
    expect(spawnCount).toBe(1);

    resolveFirst(0);
    await p1;

    await new Promise((r) => setTimeout(r, 0));
    expect(spawnCount).toBe(2);

    await p2;
  });

  test("calls with different keys run concurrently (not serialized)", async () => {
    const mockSpawn = mock(() => {
      return {
        stdout: bodyStream(jsonOutput("ok")),
        stderr: bodyStream(""),
        exited: Promise.resolve(0),
      } as ReturnType<typeof Bun.spawn>;
    });
    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
    );

    const [r1, r2] = await Promise.all([
      runClaude("msg1", "key-a"),
      runClaude("msg2", "key-b"),
    ]);

    expect(r1.result).toBe("ok");
    expect(r2.result).toBe("ok");
  });

  test("second call still runs after first call throws", async () => {
    let callCount = 0;
    const mockSpawn = mock(() => {
      callCount++;
      const exitCode = callCount === 1 ? 1 : 0;
      return {
        stdout: bodyStream(callCount === 1 ? "" : jsonOutput("recovered")),
        stderr: bodyStream(callCount === 1 ? "error on first" : ""),
        exited: Promise.resolve(exitCode),
      } as ReturnType<typeof Bun.spawn>;
    });
    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
    );

    const p1 = runClaude("msg1", "error-key");
    const p2 = runClaude("msg2", "error-key");

    await expect(p1).rejects.toThrow();
    const r2 = await p2;
    expect(r2.result).toBe("recovered");
  });
});

// ─── extraAllowedTools tests ──────────────────────────────────────────────────

describe("extraAllowedTools", () => {
  // biome-ignore lint/suspicious/noExplicitAny: mock return type
  let mockSpawn: any;

  beforeEach(() => {
    mockGetSession.mockClear();
    mockSetSession.mockClear();
    mockClearSession.mockClear();
    capturedMessages = [];
    capturedExceptions = [];
    mockSpawn = mock(
      () =>
        fakeProc(jsonOutput("Hello from Claude")) as ReturnType<
          typeof Bun.spawn
        >,
    );
  });

  test("empty extraAllowedTools produces identical args to no extraAllowedTools", async () => {
    const runClaudeDefault = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
    );
    const runClaudeEmpty = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
      [],
    );

    await runClaudeDefault("test");
    const [defaultCmd] = mockSpawn.mock.calls[0] as [string[]];

    mockSpawn.mockClear();

    await runClaudeEmpty("test");
    const [emptyCmd] = mockSpawn.mock.calls[0] as [string[]];

    expect(emptyCmd).toEqual(defaultCmd);
  });

  test("non-empty extraAllowedTools are appended after existing tools in --allowedTools", async () => {
    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
      ["mcp__my_server__my_tool", "mcp__other__tool"],
    );

    await runClaude("test");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];

    const allowedIdx = cmd.indexOf("--allowedTools");
    expect(allowedIdx).toBeGreaterThan(-1);

    // Find all args after --allowedTools until the next flag or end
    const toolsInCmd: string[] = [];
    for (let i = allowedIdx + 1; i < cmd.length; i++) {
      if (cmd[i].startsWith("-")) break;
      toolsInCmd.push(cmd[i]);
    }

    expect(toolsInCmd).toContain("mcp__my_server__my_tool");
    expect(toolsInCmd).toContain("mcp__other__tool");
  });

  test("extraAllowedTools appear after built-in tools (not before)", async () => {
    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
      ["mcp__extra__tool"],
    );

    await runClaude("test");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];

    const allowedIdx = cmd.indexOf("--allowedTools");
    const extraIdx = cmd.indexOf("mcp__extra__tool");
    const agentIdx = cmd.indexOf("Agent"); // built-in tool near the end

    expect(extraIdx).toBeGreaterThan(allowedIdx);
    expect(extraIdx).toBeGreaterThan(agentIdx);
  });
});

// ─── totalCostUsd and modelUsage from JSON output ────────────────────────────

describe("runClaude — totalCostUsd and modelUsage", () => {
  // biome-ignore lint/suspicious/noExplicitAny: mock return type
  let mockSpawn: any;
  let runClaude: ReturnType<typeof createRunClaude>;

  beforeEach(() => {
    mockGetSession.mockClear();
    mockSetSession.mockClear();
    mockClearSession.mockClear();
    capturedMessages = [];
    capturedExceptions = [];
    mockSpawn = mock(
      () =>
        fakeProc(jsonOutput("Hello from Claude")) as ReturnType<
          typeof Bun.spawn
        >,
    );
    runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
    );
  });

  test("returns totalCostUsd from JSON output when total_cost_usd is present", async () => {
    const json = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Hello",
      session_id: "sess-cost",
      is_error: false,
      total_cost_usd: 0.0042,
    });
    mockSpawn.mockReturnValue(fakeProc(json) as ReturnType<typeof Bun.spawn>);
    const output = await runClaude("hello");
    expect(output.totalCostUsd).toBe(0.0042);
  });

  test("returns modelUsage from JSON output when modelUsage is present", async () => {
    const modelUsage = {
      "claude-sonnet-4-6": {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.0021,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    };
    const json = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Hello",
      session_id: "sess-usage",
      is_error: false,
      modelUsage,
    });
    mockSpawn.mockReturnValue(fakeProc(json) as ReturnType<typeof Bun.spawn>);
    const output = await runClaude("hello");
    expect(output.modelUsage).toEqual(modelUsage);
  });

  test("returns undefined totalCostUsd and modelUsage when not in JSON output", async () => {
    // Default mockSpawn produces jsonOutput("Hello from Claude") which has no extra fields
    const output = await runClaude("hello");
    expect(output.totalCostUsd).toBeUndefined();
    expect(output.modelUsage).toBeUndefined();
  });
});

// ─── stream-json parsing / onProgress ────────────────────────────────────────

describe("runClaude — stream-json parsing", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockSetSession.mockReset();
    mockClearSession.mockReset();
    capturedMessages = [];
    capturedExceptions = [];
  });

  test("clean multi-turn, multi-model session returns the result event's authoritative totals byte-identically", async () => {
    const mockSpawn = mock(
      () => ndjsonProc(cleanMultiTurn.lines) as ReturnType<typeof Bun.spawn>,
    );
    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
    );

    const output = await runClaude("go");

    expect(output.result).toBe(cleanMultiTurn.expected.result);
    expect(output.sessionId).toBe(cleanMultiTurn.expected.sessionId);
    expect(output.totalCostUsd).toBe(cleanMultiTurn.expected.totalCostUsd);
    // Byte-identical to the terminal result event's modelUsage (NOT the
    // running accumulator, which lacks costUSD).
    expect(output.modelUsage).toEqual(cleanMultiTurn.expected.modelUsage);
    expect(output.streamIncomplete).toBeUndefined();
  });

  test("onProgress fires once per distinct message id with the running accumulated total (deduped)", async () => {
    const mockSpawn = mock(
      () => ndjsonProc(cleanMultiTurn.lines) as ReturnType<typeof Bun.spawn>,
    );
    const progress: Array<Record<string, unknown>> = [];
    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (mu) => {
        progress.push(structuredClone(mu));
      },
    );

    await runClaude("go");

    // msg_1 (deduped from 2 lines), msg_2, msg_3 → exactly 3 progress events.
    expect(progress).toHaveLength(cleanMultiTurn.expectedProgressCount);
    // The final accumulated snapshot matches the fixture's own expected sums.
    expect(progress[progress.length - 1]).toEqual(
      cleanMultiTurn.expectedAccumulated,
    );
  });

  test("skips malformed / non-JSON lines without losing already-accumulated usage", async () => {
    const linesWithGarbage = [
      cleanMultiTurn.lines[0],
      "this is not json at all",
      ...cleanMultiTurn.lines.slice(1, 2),
      "{ broken json",
      ...cleanMultiTurn.lines.slice(2),
    ];
    const mockSpawn = mock(
      () => ndjsonProc(linesWithGarbage) as ReturnType<typeof Bun.spawn>,
    );
    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
    );

    const output = await runClaude("go");
    expect(output.result).toBe(cleanMultiTurn.expected.result);
    expect(output.modelUsage).toEqual(cleanMultiTurn.expected.modelUsage);
  });

  test("truncated stream with no result event surfaces the accumulated partial usage (distinct return shape)", async () => {
    const mockSpawn = mock(
      () => ndjsonProc(truncatedNoResult.lines) as ReturnType<typeof Bun.spawn>,
    );
    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
    );

    const output = await runClaude("go");
    expect(output.streamIncomplete).toBe(true);
    expect(output.modelUsage).toEqual(truncatedNoResult.expectedAccumulated);
    expect(output.result).toBe("");
  });

  test("timeout mid-stream throws ClaudeTimeoutError carrying the accumulated partial usage", async () => {
    // A proc whose stdout emits two assistant turns then never closes / never
    // emits a result — forcing the timeout path.
    let resolveExited!: (code: number) => void;
    const exited = new Promise<number>((r) => {
      resolveExited = r;
    });
    const enc = new TextEncoder();
    // Mirror real proc.kill() semantics: killing the process closes stdout so
    // the reader drains to `done` instead of hanging forever.
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(enc.encode(`${truncatedNoResult.lines[0]}\n`));
        controller.enqueue(enc.encode(`${truncatedNoResult.lines[1]}\n`));
        controller.enqueue(enc.encode(`${truncatedNoResult.lines[2]}\n`));
        // stream intentionally left open — no close(), no result line
      },
    });
    const proc = {
      stdout,
      stderr: bodyStream(""),
      exited,
      kill: () => {
        streamController.close();
        resolveExited(143);
      },
    };
    const mockSpawn = mock(
      () => proc as unknown as ReturnType<typeof Bun.spawn>,
    );

    const runClaudeWithTimeout = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      fakeSentryClient,
      undefined,
      undefined,
      undefined,
      1000, // 1s ceiling headroom — idle timer below should fire first
      10, // 10ms idle timeout — stream goes silent after the 3 initial lines
    );

    const { ClaudeTimeoutError } = await import("./claude.ts");
    try {
      await runClaudeWithTimeout("go");
      throw new Error("expected timeout");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeTimeoutError);
      const e = err as InstanceType<typeof ClaudeTimeoutError>;
      expect(e.reason).toBe("idle");
      expect(e.partialModelUsage).toEqual(truncatedNoResult.expectedAccumulated);
    }
  });
});

// ─── dominantModel ────────────────────────────────────────────────────────────

describe("dominantModel", () => {
  test("returns the model with the highest outputTokens", () => {
    const result = dominantModel({
      "claude-sonnet-4-6": {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.001,
      },
      "claude-opus-4-8": {
        inputTokens: 200,
        outputTokens: 200,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.01,
      },
    });
    expect(result).toBe("claude-opus-4-8");
  });

  test("returns undefined for empty modelUsage", () => {
    expect(dominantModel({})).toBeUndefined();
  });

  test("handles single model", () => {
    const result = dominantModel({
      "claude-haiku-4-6": {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.0001,
      },
    });
    expect(result).toBe("claude-haiku-4-6");
  });

  test("breaks ties deterministically — returns one of the tied models", () => {
    const result = dominantModel({
      "model-a": {
        inputTokens: 10,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.001,
      },
      "model-b": {
        inputTokens: 10,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.001,
      },
    });
    expect(result === "model-a" || result === "model-b").toBe(true);
  });
});

// ─── liveClaudeConfig / setLiveClaudeConfig tests ────────────────────────────

describe("liveClaudeConfig", () => {
  // biome-ignore lint/suspicious/noExplicitAny: mock return type
  let mockSpawn: any;

  beforeEach(() => {
    mockGetSession.mockClear();
    mockSetSession.mockClear();
    mockClearSession.mockClear();
    capturedMessages = [];
    capturedExceptions = [];
    mockSpawn = mock(
      () =>
        fakeProc(jsonOutput("Hello from Claude")) as ReturnType<
          typeof Bun.spawn
        >,
    );
  });

  test("setLiveClaudeConfig changes --model for module-level runClaude", async () => {
    setLiveClaudeConfig({ model: "claude-haiku-4-6" });

    // createRunClaude() with no explicit model should pick up liveClaudeConfig
    const runClaudeDefault = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      undefined,
      WORKSPACE,
      fakeSentryClient,
    );

    await runClaudeDefault("test");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];
    const idx = cmd.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(cmd[idx + 1]).toBe("claude-haiku-4-6");
  });

  test("explicit model passed to createRunClaude overrides liveClaudeConfig", async () => {
    setLiveClaudeConfig({ model: "claude-haiku-4-6" });

    // Explicit model param takes precedence
    const runClaudeExplicit = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      "claude-opus-4-6",
      WORKSPACE,
      fakeSentryClient,
    );

    await runClaudeExplicit("test");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];
    const idx = cmd.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(cmd[idx + 1]).toBe("claude-opus-4-6");
  });

  test("setLiveClaudeConfig merges partial patches", async () => {
    setLiveClaudeConfig({ model: "claude-sonnet-4-6", effortLevel: "xhigh" });

    const runClaudeDefault = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      undefined,
      WORKSPACE,
      fakeSentryClient,
    );

    await runClaudeDefault("test");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];

    const modelIdx = cmd.indexOf("--model");
    expect(cmd[modelIdx + 1]).toBe("claude-sonnet-4-6");

    const effortIdx = cmd.indexOf("--effort");
    expect(effortIdx).toBeGreaterThan(-1);
    expect(cmd[effortIdx + 1]).toBe("xhigh");
  });
});
