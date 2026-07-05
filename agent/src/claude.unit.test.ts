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
import { TEST_AGENT_HOME } from "./test-env.ts";

const MODEL = "claude-opus-4-6";
const WORKSPACE = join(TEST_AGENT_HOME, "workspace");

// ─── Import module under test ─────────────────────────────────────────────────

const { createRunClaude, setLiveClaudeConfig, dominantModel } =
  await import("./claude.ts");

// ─── Shared test session store ────────────────────────────────────────────────

const mockGetSession = mock((_key: string): string | undefined => undefined);
const mockSetSession = mock((_key: string, _id: string): void => {});
const mockClearSession = mock((_key: string): void => {});
const testSessions = {
  get: mockGetSession,
  set: mockSetSession,
  clear: mockClearSession,
};

const mockTracker = mock((_event: unknown): void => {});

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

function jsonOutput(
  result: string,
  sessionId = "sess-abc",
  isError = false,
): string {
  return JSON.stringify({ result, session_id: sessionId, is_error: isError });
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
    mockTracker.mockClear();
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
      mockTracker,
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

  test("passes --output-format json", async () => {
    await runClaude("test");
    const [cmd] = mockSpawn.mock.calls[0] as [string[]];
    const idx = cmd.indexOf("--output-format");
    expect(idx).toBeGreaterThan(-1);
    expect(cmd[idx + 1]).toBe("json");
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
      mockTracker,
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
      mockTracker,
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

  test("tracks session_start when sessionKey provided and no existing session", async () => {
    mockGetSession.mockReturnValueOnce(undefined);
    await runClaude("hello", "chan:ts");
    expect(mockTracker).toHaveBeenCalledWith({
      type: "session_start",
      sessionKey: "chan:ts",
    });
  });

  test("does not track session_start when resuming an existing session", async () => {
    mockGetSession.mockReturnValueOnce("existing-sid");
    await runClaude("hello", "chan:ts");
    expect(mockTracker).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_start" }),
    );
  });

  test("does not track session_start when no sessionKey provided", async () => {
    await runClaude("hello");
    expect(mockTracker).not.toHaveBeenCalled();
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
      mockTracker,
      undefined,
      undefined,
      undefined,
      10, // 10ms timeout for test speed
    );

    const { ClaudeTimeoutError } = await import("./claude.ts");
    await expect(runClaudeWithTimeout("hello")).rejects.toBeInstanceOf(
      ClaudeTimeoutError,
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
      mockTracker,
      undefined,
      undefined,
      undefined,
      10, // 10ms timeout
    );

    const { ClaudeTimeoutError } = await import("./claude.ts");
    await expect(
      runClaudeWithTimeout("hello", "chan:ts"),
    ).rejects.toBeInstanceOf(ClaudeTimeoutError);
    // Guard prevents retry — spawn must be called exactly once
    expect(mockSpawnTimeout).toHaveBeenCalledTimes(1);
  });

  test("non-zero exit with JSON stdout throws ClaudeRunError with api_error_status", async () => {
    const json = JSON.stringify({
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

describe("stale session fallback", () => {
  test("retries without -r when resume fails, clears stale session", async () => {
    let callCount = 0;
    const mockSpawn = mock(() => {
      callCount++;
      if (callCount === 1) {
        // First call (resume) fails
        return fakeProc("", "session not found", 1) as ReturnType<
          typeof Bun.spawn
        >;
      }
      // Second call (fresh) succeeds
      return fakeProc(jsonOutput("recovered", "new-sess")) as ReturnType<
        typeof Bun.spawn
      >;
    });

    mockGetSession.mockClear();
    mockSetSession.mockClear();
    mockClearSession.mockClear();
    mockTracker.mockClear();
    mockGetSession.mockReturnValue("stale-sess-id");

    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      mockTracker,
    );

    const result = await runClaude("hello", "chan:ts");

    expect(result.result).toBe("recovered");
    expect(result.sessionId).toBe("new-sess");
    expect(mockClearSession).toHaveBeenCalledWith("chan:ts");
    expect(mockSetSession).toHaveBeenCalledWith("chan:ts", "new-sess");
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    // Verify first call had -r, second did not
    const [firstCmd] = mockSpawn.mock.calls[0] as unknown as [string[]];
    const [secondCmd] = mockSpawn.mock.calls[1] as unknown as [string[]];
    expect(firstCmd).toContain("-r");
    expect(secondCmd).not.toContain("-r");
  });

  test("tracks session_fallback with sessionKey and durationMs when stale session retried", async () => {
    let callCount = 0;
    const mockSpawn = mock(() => {
      callCount++;
      if (callCount === 1) {
        return fakeProc("", "session not found", 1) as ReturnType<
          typeof Bun.spawn
        >;
      }
      return fakeProc(jsonOutput("recovered", "new-sess")) as ReturnType<
        typeof Bun.spawn
      >;
    });

    mockGetSession.mockClear();
    mockSetSession.mockClear();
    mockClearSession.mockClear();
    mockTracker.mockClear();
    mockGetSession.mockReturnValue("stale-sess-id");

    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      mockTracker,
    );

    await runClaude("hello", "chan:ts");

    expect(mockTracker).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session_fallback",
        sessionKey: "chan:ts",
        durationMs: expect.any(Number),
      }),
    );
  });

  test("fresh retry passes raw message without identity injection", async () => {
    let callCount = 0;
    const mockSpawn = mock(() => {
      callCount++;
      if (callCount === 1) {
        return fakeProc("", "session expired", 1) as ReturnType<
          typeof Bun.spawn
        >;
      }
      return fakeProc(jsonOutput("ok", "fresh-sess")) as ReturnType<
        typeof Bun.spawn
      >;
    });

    mockGetSession.mockClear();
    mockSetSession.mockClear();
    mockClearSession.mockClear();
    mockGetSession.mockReturnValue("old-sess");

    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
    );

    await runClaude("my question", "chan:ts");

    // Second call (fresh) should have raw message only
    const [secondCmd] = mockSpawn.mock.calls[1] as unknown as [string[]];
    const lastArg = secondCmd[secondCmd.length - 1];
    expect(lastArg).toBe("my question");
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

  test("throws if both resume and fresh retry fail", async () => {
    const mockSpawn = mock(
      () => fakeProc("", "total failure", 1) as ReturnType<typeof Bun.spawn>,
    );

    mockGetSession.mockClear();
    mockClearSession.mockClear();
    mockGetSession.mockReturnValue("stale-sess");

    const runClaude = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
    );

    await expect(runClaude("hello", "chan:ts")).rejects.toThrow(
      "total failure",
    );
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockClearSession).toHaveBeenCalledWith("chan:ts");
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
    mockTracker.mockClear();
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
      mockTracker,
    );
    const runClaudeEmpty = createRunClaude(
      mockSpawn as typeof Bun.spawn,
      testSessions,
      MODEL,
      WORKSPACE,
      mockTracker,
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
      mockTracker,
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
      mockTracker,
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
    mockTracker.mockClear();
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
      mockTracker,
    );
  });

  test("returns totalCostUsd from JSON output when total_cost_usd is present", async () => {
    const json = JSON.stringify({
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
    mockTracker.mockClear();
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
      mockTracker,
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
      mockTracker,
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
      mockTracker,
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
