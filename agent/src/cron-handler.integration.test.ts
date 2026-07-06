/**
 * Integration tests for cron-handler.ts and POST /cron endpoint in health.ts.
 *
 * Strategy: inject all deps. No real Slack or Claude calls.
 *
 * - runner: mock function
 * - slack: mock WebClient with chat.postMessage and conversations.open
 * - formatter: identity function (no markdown conversion)
 * - HTTP tests: real Bun.serve via startHealthServer
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErrorCapturingClient } from "@shipwright/lib/sentry";
import type { WebClient } from "@slack/web-api";
import type { Server } from "bun";
import { FixedClock } from "./clock.ts";
import type { ModelUsage, TokenUsage } from "./claude.ts";
import { ValidationError, handleCronRequest } from "./cron-handler.ts";
import { HttpCronRunReporter } from "./cron-run-reporter.ts";
import { startHealthServer } from "./health.ts";

// ─── Shared mocks ─────────────────────────────────────────────────────────────

const mockPostMessage = mock(() =>
  Promise.resolve({ ok: true, ts: "1234567890.000001" }),
);
const mockConversationsOpen = mock(() =>
  Promise.resolve({ channel: { id: "D_DM_CHANNEL" } }),
);
const mockReactionsAdd = mock(() => Promise.resolve({ ok: true }));
const mockFilesUploadV2 = mock(() => Promise.resolve({ ok: true }));
const mockSlack = {
  chat: { postMessage: mockPostMessage },
  conversations: { open: mockConversationsOpen },
  reactions: { add: mockReactionsAdd },
  files: { uploadV2: mockFilesUploadV2 },
} as unknown as WebClient;

const mockRunner = mock(
  (): Promise<{
    result: string;
    sessionId?: string;
    usage?: TokenUsage;
    totalCostUsd?: number;
    modelUsage?: ModelUsage;
  }> => Promise.resolve({ result: "claude reply", sessionId: "sess-1" }),
);

const deps = {
  slack: mockSlack,
  runner: mockRunner,
  formatter: (text: string) => text, // identity — no markdown conversion in tests
};

afterEach(() => {
  mockPostMessage.mockClear();
  mockConversationsOpen.mockClear();
  mockRunner.mockClear();
  mockReactionsAdd.mockClear();
  mockFilesUploadV2.mockClear();
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe("handleCronRequest — validation", () => {
  test("throws ValidationError when prompt is empty string", async () => {
    await expect(
      handleCronRequest({ jobId: "j1", prompt: "" }, deps),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("throws ValidationError when neither channel nor user is provided (and not silent)", async () => {
    await expect(
      handleCronRequest({ jobId: "j1", prompt: "hello" }, deps),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("does not throw when silent=true and no channel/user", async () => {
    await expect(
      handleCronRequest({ jobId: "j1", prompt: "hello", silent: true }, deps),
    ).resolves.toBeUndefined();
  });

  test("runs runner but skips posting when silent=true", async () => {
    await handleCronRequest(
      { jobId: "j1", prompt: "hello", silent: true },
      deps,
    );
    expect(mockRunner).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});

// ─── Channel delivery ─────────────────────────────────────────────────────────

describe("handleCronRequest — channel delivery", () => {
  test("posts result to channel", async () => {
    mockRunner.mockResolvedValueOnce({ result: "the report", sessionId: "s1" });

    await handleCronRequest(
      { jobId: "daily", prompt: "Summarise the day", channel: "C-REPORTS" },
      deps,
    );

    expect(mockRunner).toHaveBeenCalledTimes(1);
    const runArg = (mockRunner.mock.calls as unknown as string[][])[0][0];
    expect(runArg).toContain("daily");
    expect(runArg).toContain("Summarise the day");

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(
      (mockPostMessage.mock.calls as unknown as unknown[][])[0][0],
    ).toMatchObject({
      channel: "C-REPORTS",
      text: "the report",
    });
  });

  test("prefers channel over user when both are provided", async () => {
    await handleCronRequest(
      { jobId: "dual", prompt: "hello", channel: "C-MAIN", user: "U-SOMEONE" },
      deps,
    );

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(
      (mockPostMessage.mock.calls as unknown as unknown[][])[0][0],
    ).toMatchObject({ channel: "C-MAIN" });
    expect(mockConversationsOpen).not.toHaveBeenCalled();
  });

  test("calls onPost callback with channel and ts after posting", async () => {
    const onPost = mock((_ch: string, _ts: string) => {});
    await handleCronRequest(
      { jobId: "j1", prompt: "hello", channel: "C-TEST" },
      { ...deps, onPost },
    );

    expect(onPost).toHaveBeenCalledTimes(1);
    expect(onPost.mock.calls[0]).toEqual(["C-TEST", "1234567890.000001"]);
  });

  test("calls onSession callback when sessionId is returned", async () => {
    const onSession = mock((_ch: string, _ts: string, _sid: string) => {});
    mockRunner.mockResolvedValueOnce({
      result: "reply",
      sessionId: "sess-xyz",
    });

    await handleCronRequest(
      { jobId: "j1", prompt: "hello", channel: "C-TEST" },
      { ...deps, onSession },
    );

    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession.mock.calls[0]).toEqual([
      "C-TEST",
      "1234567890.000001",
      "sess-xyz",
    ]);
  });

  test("formatter applied to Claude result before posting", async () => {
    const upperFormatter = (text: string) => text.toUpperCase();
    mockRunner.mockResolvedValueOnce({
      result: "lower case result",
      sessionId: "s1",
    });

    await handleCronRequest(
      { jobId: "fmt-job", prompt: "run", channel: "C-TEST" },
      { ...deps, formatter: upperFormatter },
    );

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(
      (mockPostMessage.mock.calls as unknown as unknown[][])[0][0],
    ).toMatchObject({
      channel: "C-TEST",
      text: "LOWER CASE RESULT",
    });
  });

  test("does not call onPost when postMessage returns no ts", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock — intentionally omitting ts
    mockPostMessage.mockResolvedValueOnce({ ok: true } as any); // no ts
    mockRunner.mockResolvedValueOnce({ result: "report", sessionId: "s1" });
    const onPost = mock(() => {});

    await handleCronRequest(
      { jobId: "daily", prompt: "run", channel: "C-X" },
      { ...deps, onPost },
    );

    expect(onPost).not.toHaveBeenCalled();
  });
});

// ─── User (DM) delivery ───────────────────────────────────────────────────────

describe("handleCronRequest — user DM delivery", () => {
  test("opens DM and posts when only user is provided", async () => {
    mockRunner.mockResolvedValueOnce({ result: "dm reply", sessionId: "s2" });

    await handleCronRequest(
      { jobId: "dm-job", prompt: "check in", user: "U-DAN" },
      deps,
    );

    expect(mockConversationsOpen).toHaveBeenCalledTimes(1);
    expect(
      (mockConversationsOpen.mock.calls as unknown as unknown[][])[0][0],
    ).toMatchObject({ users: "U-DAN" });

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(
      (mockPostMessage.mock.calls as unknown as unknown[][])[0][0],
    ).toMatchObject({
      channel: "D_DM_CHANNEL",
      text: "dm reply",
    });
  });

  test("calls onPost with DM channel after DM post", async () => {
    const onPost = mock((_ch: string, _ts: string) => {});
    await handleCronRequest(
      { jobId: "j1", prompt: "hello", user: "U-DAN" },
      { ...deps, onPost },
    );

    expect(onPost).toHaveBeenCalledTimes(1);
    expect(onPost.mock.calls[0][0]).toBe("D_DM_CHANNEL");
  });

  test("throws when conversations.open returns no channel id", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock — intentionally null channel
    mockConversationsOpen.mockResolvedValueOnce({ channel: null } as any);

    await expect(
      handleCronRequest(
        { jobId: "dm-fail", prompt: "test", user: "U-BAD" },
        deps,
      ),
    ).rejects.toThrow();
  });

  test("calls onPost AND onSession for DM posts", async () => {
    mockRunner.mockResolvedValueOnce({
      result: "digest",
      sessionId: "sess-dm-1",
    });
    const onPost = mock(() => {});
    const onSession = mock(() => {});

    await handleCronRequest(
      { jobId: "dm-job", prompt: "What's on the agenda?", user: "U-TARGET" },
      { ...deps, onPost, onSession },
    );

    expect(onPost).toHaveBeenCalledTimes(1);
    expect(onPost).toHaveBeenCalledWith("D_DM_CHANNEL", "1234567890.000001");
    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenCalledWith(
      "D_DM_CHANNEL",
      "1234567890.000001",
      "sess-dm-1",
    );
  });
});

// ─── Silent marker ────────────────────────────────────────────────────────────

describe("handleCronRequest — [silent] marker", () => {
  test("[silent] in result suppresses channel post", async () => {
    mockRunner.mockResolvedValueOnce({
      result: "text [silent]",
      sessionId: "s3",
    });

    await handleCronRequest(
      { jobId: "j1", prompt: "hello", channel: "C-MAIN" },
      deps,
    );

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test("[silent] in result is IGNORED for DM — DM always gets a reply", async () => {
    mockRunner.mockResolvedValueOnce({
      result: "text [silent]",
      sessionId: "s4",
    });

    await handleCronRequest(
      { jobId: "j1", prompt: "hello", user: "U-DAN" },
      deps,
    );

    expect(mockConversationsOpen).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });

  test("silent=true dep flag suppresses post", async () => {
    mockRunner.mockResolvedValueOnce({ result: "result", sessionId: "s5" });

    await handleCronRequest(
      { jobId: "j1", prompt: "hello", channel: "C-MAIN", silent: true },
      deps,
    );

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test("silent=true dep flag also suppresses DM posts", async () => {
    mockRunner.mockResolvedValueOnce({ result: "result", sessionId: "s6" });

    await handleCronRequest(
      { jobId: "j1", prompt: "hello", user: "U-DAN", silent: true },
      deps,
    );

    expect(mockConversationsOpen).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});

// ─── onSession callback ───────────────────────────────────────────────────────

describe("handleCronRequest — onSession callback", () => {
  test("calls onSession with channel, ts, and sessionId after channel post", async () => {
    mockRunner.mockResolvedValueOnce({
      result: "report",
      sessionId: "sess-cron-1",
    });
    const onSession = mock(() => {});

    await handleCronRequest(
      { jobId: "daily", prompt: "Summarise the day", channel: "C-REPORTS" },
      { ...deps, onSession },
    );

    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenCalledWith(
      "C-REPORTS",
      "1234567890.000001",
      "sess-cron-1",
    );
  });

  test("does not call onSession when sessionId is absent", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock — intentionally omitting sessionId
    mockRunner.mockResolvedValueOnce({ result: "report" } as any);
    const onSession = mock(() => {});

    await handleCronRequest(
      { jobId: "daily", prompt: "Summarise the day", channel: "C-REPORTS" },
      { ...deps, onSession },
    );

    expect(onSession).not.toHaveBeenCalled();
  });

  test("does not call onSession when silent", async () => {
    const onSession = mock(() => {});

    await handleCronRequest(
      { jobId: "quiet", prompt: "run", channel: "C-X", silent: true },
      { ...deps, onSession },
    );

    expect(onSession).not.toHaveBeenCalled();
  });
});

// ─── Marker dispatch ──────────────────────────────────────────────────────────

describe("handleCronRequest — marker dispatch", () => {
  test("[react:thumbsup] in response → reactions.add called with channel, timestamp, name", async () => {
    mockRunner.mockResolvedValueOnce({
      result: "good news [react:thumbsup]",
      sessionId: "s1",
    });

    await handleCronRequest(
      { jobId: "react-job", prompt: "run", channel: "C-REPORTS" },
      deps,
    );

    expect(mockReactionsAdd).toHaveBeenCalledTimes(1);
    expect(mockReactionsAdd).toHaveBeenCalledWith({
      channel: "C-REPORTS",
      timestamp: "1234567890.000001",
      name: "thumbsup",
    });
  });

  test("[react:emoji1,emoji2] → reactions.add called once per emoji", async () => {
    mockRunner.mockResolvedValueOnce({
      result: "done [react:white_check_mark,tada]",
      sessionId: "s1",
    });

    await handleCronRequest(
      { jobId: "react-multi", prompt: "run", channel: "C-REPORTS" },
      deps,
    );

    expect(mockReactionsAdd).toHaveBeenCalledTimes(2);
    expect(mockReactionsAdd).toHaveBeenCalledWith({
      channel: "C-REPORTS",
      timestamp: "1234567890.000001",
      name: "white_check_mark",
    });
    expect(mockReactionsAdd).toHaveBeenCalledWith({
      channel: "C-REPORTS",
      timestamp: "1234567890.000001",
      name: "tada",
    });
  });

  test("[react:thumbsup] when postMessage returns no ts → reactions.add not called", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock — intentionally omitting ts
    mockPostMessage.mockResolvedValueOnce({ ok: true } as any); // no ts
    mockRunner.mockResolvedValueOnce({
      result: "good news [react:thumbsup]",
      sessionId: "s1",
    });

    await handleCronRequest(
      { jobId: "react-nots", prompt: "run", channel: "C-REPORTS" },
      deps,
    );

    expect(mockReactionsAdd).not.toHaveBeenCalled();
  });

  test("[upload:/path/to/file] → files.uploadV2 called with the correct file path", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cron-upload-test-"));
    const filePath = join(tmpDir, "report.txt");
    writeFileSync(filePath, "report content");

    mockRunner.mockResolvedValueOnce({
      result: `here is the report [upload:${filePath}]`,
      sessionId: "s1",
    });

    await handleCronRequest(
      { jobId: "upload-job", prompt: "run", channel: "C-REPORTS" },
      deps,
    );

    expect(mockFilesUploadV2).toHaveBeenCalledTimes(1);
    const uploadCall = (
      mockFilesUploadV2.mock.calls as unknown as unknown[][]
    )[0][0] as {
      channel_id: string;
      filename: string;
    };
    expect(uploadCall.channel_id).toBe("C-REPORTS");
    expect(uploadCall.filename).toBe("report.txt");
  });

  test("[speak:hello world] with synthesizeSpeechFn injected → fn called and audio uploaded", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cron-speak-test-"));
    const audioPath = join(tmpDir, "response.mp3");
    writeFileSync(audioPath, Buffer.from("fake-audio-data"));

    const mockSynthesize = mock(() => Promise.resolve(audioPath));
    mockRunner.mockResolvedValueOnce({
      result: "here is audio [speak:hello world]",
      sessionId: "s1",
    });

    await handleCronRequest(
      { jobId: "speak-job", prompt: "run", channel: "C-VOICE" },
      {
        ...deps,
        synthesizeSpeechFn: mockSynthesize,
        voiceConfig: { groqApiKey: "test-key" },
      },
    );

    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    expect((mockSynthesize.mock.calls as unknown as string[][])[0][0]).toBe(
      "hello world",
    );
    expect(mockFilesUploadV2).toHaveBeenCalledTimes(1);
  });

  test("[speak:hello] without synthesizeSpeechFn injected → no throw, no upload", async () => {
    mockRunner.mockResolvedValueOnce({
      result: "here is audio [speak:hello]",
      sessionId: "s1",
    });

    await expect(
      handleCronRequest(
        { jobId: "speak-nofn", prompt: "run", channel: "C-VOICE" },
        deps, // no synthesizeSpeechFn
      ),
    ).resolves.toBeUndefined();

    expect(mockFilesUploadV2).not.toHaveBeenCalled();
  });

  test("marker tags are stripped from visible message text before posting", async () => {
    mockRunner.mockResolvedValueOnce({
      result: "the report [react:thumbsup]",
      sessionId: "s1",
    });

    await handleCronRequest(
      { jobId: "strip-job", prompt: "run", channel: "C-REPORTS" },
      deps,
    );

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const postArg = (
      mockPostMessage.mock.calls as unknown as unknown[][]
    )[0][0] as {
      text: string;
    };
    expect(postArg.text).not.toContain("[react:thumbsup]");
    expect(postArg.text).toContain("the report");
  });
});

// ─── Runner error ─────────────────────────────────────────────────────────────

describe("handleCronRequest — runner error", () => {
  test("propagates error from runner", async () => {
    mockRunner.mockRejectedValueOnce(new Error("claude crashed"));

    await expect(
      handleCronRequest(
        { jobId: "err-job", prompt: "do stuff", channel: "C-X" },
        deps,
      ),
    ).rejects.toThrow("claude crashed");
  });
});

// ─── preCheck ─────────────────────────────────────────────────────────────────

describe("handleCronRequest — preCheck", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
    mkdirSync(join(tmpDir, "shipwright", "scripts"), { recursive: true });
  });

  test("skips job when preCheck script exits 1 (no work)", async () => {
    const script = join(tmpDir, "check.ts");
    writeFileSync(script, "process.exit(1);");

    await handleCronRequest(
      { jobId: "j1", prompt: "hello", channel: "C-TEST", preCheck: script },
      deps,
    );

    expect(mockRunner).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test("uses preCheck output as prompt when it exits 0 with output", async () => {
    const script = join(tmpDir, "check.ts");
    writeFileSync(script, `console.log("precheck prompt"); process.exit(0);`);

    await handleCronRequest(
      { jobId: "j1", prompt: "original", channel: "C-TEST", preCheck: script },
      deps,
    );

    expect(mockRunner).toHaveBeenCalledTimes(1);
    const runArg = (mockRunner.mock.calls as unknown as string[][])[0][0];
    expect(runArg).toContain("precheck prompt");
  });

  test("preCheck inherits runtime process.env mutations (env: process.env passthrough)", async () => {
    // config-sync mutates process.env at runtime (Object.assign every 60s). The
    // preCheck child must see those mutations, not a Bun-startup snapshot —
    // regression for a rotated SHIPWRIGHT_TASK_STORE_TOKEN causing 401s until
    // the pod restarted. The probe key is absent from the process's boot env, so
    // without env: process.env the child reads "MISSING".
    const key = "CRON_PRECHECK_ENV_PROBE";
    process.env[key] = "runtime-value";
    try {
      const script = join(tmpDir, "check.ts");
      writeFileSync(
        script,
        `console.log(process.env.${key} ?? "MISSING"); process.exit(0);`,
      );

      await handleCronRequest(
        {
          jobId: "j1",
          prompt: "original",
          channel: "C-TEST",
          preCheck: script,
        },
        deps,
      );

      expect(mockRunner).toHaveBeenCalledTimes(1);
      const runArg = (mockRunner.mock.calls as unknown as string[][])[0][0];
      expect(runArg).toContain("runtime-value");
    } finally {
      delete process.env[key];
    }
  });

  test("runs preCheck with cwd = workspace (resolves state relative to workspace)", async () => {
    // Plugin preChecks resolve state relative to process.cwd() — e.g.
    // check-review.ts / check-deploy.ts (via check-helpers.ts) read
    // workspace-relative files like `state/agent-policy.md`. The file lives
    // in the workspace; the preCheck must run there, not in the agent's cwd
    // (/app in prod, the repo root in tests).
    const ws = join(tmpDir, "ws");
    mkdirSync(join(ws, "state"), { recursive: true });
    writeFileSync(join(ws, "state", "agent-policy.md"), "# Agent Policy\n");
    const script = join(tmpDir, "check.ts");
    writeFileSync(
      script,
      `import { existsSync } from "node:fs";\nconsole.log(existsSync("state/agent-policy.md") ? "HAS_STATE" : "NO_STATE");\nprocess.exit(0);`,
    );

    await handleCronRequest(
      { jobId: "j1", prompt: "original", channel: "C-TEST", preCheck: script },
      { ...deps, workspace: ws },
    );

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
      { ...deps, pluginCacheDir: tmpDir },
    );

    expect(mockRunner).not.toHaveBeenCalled();
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

    await handleCronRequest(
      {
        jobId: "precheck-crash",
        prompt: "original prompt",
        silent: true,
        preCheck: "shipwright:check-dev-task.ts",
      },
      { ...deps, pluginCacheDir: tmpDir, alertsChannel: "C_ALERTS" },
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

    await expect(
      handleCronRequest(
        {
          jobId: "precheck-crash-no-alert",
          prompt: "original prompt",
          silent: true,
          preCheck: "shipwright:check-dev-task.ts",
        },
        { ...deps, pluginCacheDir: tmpDir },
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

    await handleCronRequest(
      {
        jobId: "precheck-no-output",
        prompt: "original prompt",
        silent: true,
        preCheck: "shipwright:check-dev-task.ts",
      },
      { ...deps, pluginCacheDir: tmpDir },
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
          { ...deps, pluginCacheDir: tmpDir },
        ),
      ).resolves.toBeUndefined();

      expect(mockRunner).not.toHaveBeenCalled();
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

    // biome-ignore lint/suspicious/noExplicitAny: test mock — sessionId optional
    mockRunner.mockResolvedValueOnce({ result: "done [silent]" } as any);

    await handleCronRequest(
      {
        jobId: "precheck-manifest",
        prompt: "original prompt",
        silent: true,
        preCheck: "shipwright:check-dev-task.ts",
      },
      { ...deps, pluginManifestPath: manifestPath },
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
          },
        ),
      ).resolves.toBeUndefined();

      expect(mockRunner).not.toHaveBeenCalled();
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

    // biome-ignore lint/suspicious/noExplicitAny: test mock — sessionId optional
    mockRunner.mockResolvedValueOnce({ result: "done [silent]" } as any);

    await handleCronRequest(
      {
        jobId: "precheck-relpath",
        prompt: "original prompt",
        silent: true,
        preCheck: "./scripts/check.ts",
      },
      { ...deps, workspace: tmpWorkspace },
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

    // biome-ignore lint/suspicious/noExplicitAny: test mock — sessionId optional
    mockRunner.mockResolvedValueOnce({ result: "done [silent]" } as any);

    await handleCronRequest(
      {
        jobId: "precheck-absolute",
        prompt: "original prompt",
        silent: true,
        preCheck: scriptPath,
      },
      { ...deps },
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
          { ...deps },
        ),
      ).resolves.toBeUndefined();

      expect(mockRunner).not.toHaveBeenCalled();
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
          { ...deps, workspace: tmpWorkspace },
        ),
      ).resolves.toBeUndefined();

      expect(mockRunner).not.toHaveBeenCalled();
      expect(
        warnMessages.some((m) => m.includes("preCheck script not found")),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ─── CronRunReporter integration ─────────────────────────────────────────────

const FIXED_TIME = new Date("2026-01-01T00:00:00.000Z");

// Stub server helpers for cron-handler reporter tests

interface ReporterStubState {
  requests: Array<{ method: string; url: string; body: unknown }>;
  runIdToReturn: string;
}

function startReporterStub(
  port: number,
  state: ReporterStubState,
  // biome-ignore lint/suspicious/noExplicitAny: Server type param varies by bun version
): ReturnType<typeof Bun.serve<any>> {
  return Bun.serve({
    port,
    fetch: async (req) => {
      const body = await req.json().catch(() => null);
      state.requests.push({ method: req.method, url: req.url, body });

      if (req.method === "POST") {
        return new Response(
          JSON.stringify({ run: { id: state.runIdToReturn } }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ run: { id: state.runIdToReturn } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
}

describe("handleCronRequest — CronRunReporter", () => {
  let tmpDir: string;
  // biome-ignore lint/suspicious/noExplicitAny: Server type param varies by bun version
  let reporterServer: ReturnType<typeof Bun.serve<any>> | undefined;
  let reporterState: ReporterStubState;

  const REPORTER_PORT = 19965;
  const REPORTER_BASE_URL = `http://localhost:${REPORTER_PORT}`;
  const AGENT_ID = "test-agent-id";

  function makeHttpReporter() {
    return new HttpCronRunReporter({
      apiUrl: REPORTER_BASE_URL,
      agentId: AGENT_ID,
      apiKey: "test-key",
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cron-reporter-test-"));
    mkdirSync(join(tmpDir, "shipwright", "scripts"), { recursive: true });
    reporterState = { requests: [], runIdToReturn: "run-test-1" };
    reporterServer = startReporterStub(REPORTER_PORT, reporterState);
  });

  afterEach(() => {
    reporterServer?.stop(true);
    reporterServer = undefined;
  });

  test("no reporter dep — existing tests unaffected (no-op)", async () => {
    mockRunner.mockResolvedValueOnce({ result: "reply", sessionId: "s1" });
    // no cronRunReporter in deps — should not throw
    await expect(
      handleCronRequest({ jobId: "j1", prompt: "hello", channel: "C-X" }, deps),
    ).resolves.toBeUndefined();
  });

  test("CREATE is called at run start with startedAt before runner executes", async () => {
    mockRunner.mockResolvedValueOnce({
      result: "reply",
      sessionId: "s1",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    const reporter = makeHttpReporter();
    await handleCronRequest(
      { jobId: "create-test", prompt: "hello", channel: "C-X" },
      { ...deps, cronRunReporter: reporter, clock: FixedClock(FIXED_TIME) },
    );

    // First request must be a POST (CREATE)
    expect(reporterState.requests.length).toBeGreaterThanOrEqual(2);
    expect(reporterState.requests[0].method).toBe("POST");
    expect(reporterState.requests[0].url).toContain(
      `/agents/${AGENT_ID}/crons/create-test/runs`,
    );
    const createBody = reporterState.requests[0].body as Record<string, unknown>;
    expect(createBody.startedAt).toBe(FIXED_TIME.toISOString());
    expect(Object.keys(createBody)).toEqual(["startedAt"]);
  });

  test("PATCH called after successful completion with outcome='completed' + token data", async () => {
    mockRunner.mockResolvedValueOnce({
      result: "the reply",
      sessionId: "s1",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
      },
      totalCostUsd: 0.005,
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 10,
          costUSD: 0.005,
        },
      },
    });

    const reporter = makeHttpReporter();
    await handleCronRequest(
      { jobId: "complete-test", prompt: "hello", channel: "C-REPORTS" },
      { ...deps, cronRunReporter: reporter, clock: FixedClock(FIXED_TIME) },
    );

    // Second request must be a PATCH (complete)
    const patchReq = reporterState.requests.find((r) => r.method === "PATCH");
    expect(patchReq).toBeDefined();
    expect(patchReq?.url).toContain(
      `/agents/${AGENT_ID}/crons/complete-test/runs/run-test-1`,
    );
    const patchBody = patchReq?.body as Record<string, unknown>;
    expect(patchBody.outcome).toBe("completed");
    expect(patchBody.completedAt).toBeDefined();
    expect(patchBody.inputTokens).toBe(100);
    expect(patchBody.outputTokens).toBe(50);
    expect(patchBody.cacheReadTokens).toBe(20);
    expect(patchBody.cacheCreationTokens).toBe(10);
    const modelBreakdown = patchBody.modelBreakdown as Array<
      Record<string, unknown>
    >;
    expect(modelBreakdown).toHaveLength(1);
    expect(modelBreakdown[0].costUsd).toBe(0.005);
  });

  test("token data sent correctly when multiple models used (modelBreakdown preserved)", async () => {
    mockRunner.mockResolvedValueOnce({
      result: "the reply",
      sessionId: "s1",
      usage: {
        input_tokens: 300,
        output_tokens: 250,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      totalCostUsd: 0.012,
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.002,
        },
        "claude-opus-4-8": {
          inputTokens: 200,
          outputTokens: 200,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.01,
        },
      },
    });

    const reporter = makeHttpReporter();
    await handleCronRequest(
      { jobId: "dominant-model-test", prompt: "hello", channel: "C-REPORTS" },
      { ...deps, cronRunReporter: reporter, clock: FixedClock(FIXED_TIME) },
    );

    const patchReq = reporterState.requests.find((r) => r.method === "PATCH");
    expect(patchReq).toBeDefined();
    const patchBody = patchReq?.body as Record<string, unknown>;
    // Token data present, plus per-model costUsd passed through directly from costUSD
    expect(patchBody.inputTokens).toBe(300);
    expect(patchBody.outputTokens).toBe(250);
    const modelBreakdown = patchBody.modelBreakdown as Array<
      Record<string, unknown>
    >;
    expect(modelBreakdown).toHaveLength(2);
    const byModel = Object.fromEntries(
      modelBreakdown.map((m) => [m.model, m]),
    );
    expect(byModel["claude-sonnet-4-6"].costUsd).toBe(0.002);
    expect(byModel["claude-opus-4-8"].costUsd).toBe(0.01);
  });

  test("PATCH called with outcome='failed' + error message when runner throws", async () => {
    mockRunner.mockRejectedValueOnce(new Error("runner exploded"));

    const reporter = makeHttpReporter();
    await expect(
      handleCronRequest(
        { jobId: "error-test", prompt: "hello", channel: "C-X" },
        { ...deps, cronRunReporter: reporter, clock: FixedClock(FIXED_TIME) },
      ),
    ).rejects.toThrow("runner exploded");

    const patchReq = reporterState.requests.find((r) => r.method === "PATCH");
    expect(patchReq).toBeDefined();
    expect(patchReq?.url).toContain(
      `/agents/${AGENT_ID}/crons/error-test/runs/run-test-1`,
    );
    const patchBody = patchReq?.body as Record<string, unknown>;
    expect(patchBody.outcome).toBe("failed");
    expect(patchBody.error).toBe("runner exploded");
  });

  test("preCheck not found → skipRun called with skipped:true, skipReason:'preCheck:not-found'", async () => {
    const reporter = makeHttpReporter();

    await handleCronRequest(
      {
        jobId: "missing-precheck",
        prompt: "hello",
        channel: "C-TEST",
        preCheck: "nonexistent-plugin:check.ts",
      },
      {
        ...deps,
        pluginCacheDir: tmpDir,
        cronRunReporter: reporter,
        clock: FixedClock(FIXED_TIME),
      },
    );

    expect(mockRunner).not.toHaveBeenCalled();

    // Should have a POST (create) and PATCH (skip)
    const postReq = reporterState.requests.find((r) => r.method === "POST");
    const patchReq = reporterState.requests.find((r) => r.method === "PATCH");
    expect(postReq).toBeDefined();
    expect(patchReq).toBeDefined();
    const patchBody = patchReq?.body as Record<string, unknown>;
    expect(patchBody.skipped).toBe(true);
    expect(patchBody.skipReason).toBe("preCheck:not-found");
    expect(patchBody.completedAt).toBeDefined();
  });

  test("preCheck exit 1 (no output) → skipRun with skipReason:'preCheck:no-output'", async () => {
    const scriptPath = join(
      tmpDir,
      "shipwright",
      "scripts",
      "check-no-output.ts",
    );
    writeFileSync(scriptPath, "process.exit(1);", { mode: 0o755 });

    const reporter = makeHttpReporter();
    await handleCronRequest(
      {
        jobId: "precheck-no-output",
        prompt: "original",
        channel: "C-TEST",
        preCheck: "shipwright:check-no-output.ts",
      },
      {
        ...deps,
        pluginCacheDir: tmpDir,
        cronRunReporter: reporter,
        clock: FixedClock(FIXED_TIME),
      },
    );

    expect(mockRunner).not.toHaveBeenCalled();
    const patchReq = reporterState.requests.find((r) => r.method === "PATCH");
    expect(patchReq).toBeDefined();
    const patchBody = patchReq?.body as Record<string, unknown>;
    expect(patchBody.skipped).toBe(true);
    expect(patchBody.skipReason).toBe("preCheck:no-output");
  });

  test("preCheck crash (exit ≥2) → skipRun with skipReason:'preCheck:crash' + error", async () => {
    const scriptPath = join(tmpDir, "shipwright", "scripts", "check-crash.ts");
    writeFileSync(
      scriptPath,
      `process.stderr.write("something blew up\\n"); process.exit(2);`,
      { mode: 0o755 },
    );

    const reporter = makeHttpReporter();
    await handleCronRequest(
      {
        jobId: "precheck-crash-reporter",
        prompt: "original",
        silent: true,
        preCheck: "shipwright:check-crash.ts",
      },
      {
        ...deps,
        pluginCacheDir: tmpDir,
        cronRunReporter: reporter,
        clock: FixedClock(FIXED_TIME),
      },
    );

    const patchReq = reporterState.requests.find((r) => r.method === "PATCH");
    expect(patchReq).toBeDefined();
    const patchBody = patchReq?.body as Record<string, unknown>;
    expect(patchBody.skipped).toBe(true);
    expect(patchBody.skipReason).toBe("preCheck:crash");
    expect(patchBody.error).toBe("something blew up");
  });

  test("silent=true → completeRun called with outcome:'completed'", async () => {
    mockRunner.mockResolvedValueOnce({
      result: "reply",
      sessionId: "s1",
      usage: {
        input_tokens: 5,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    const reporter = makeHttpReporter();
    await handleCronRequest(
      { jobId: "silent-job", prompt: "hello", silent: true },
      { ...deps, cronRunReporter: reporter, clock: FixedClock(FIXED_TIME) },
    );

    const patchReq = reporterState.requests.find((r) => r.method === "PATCH");
    expect(patchReq).toBeDefined();
    const patchBody = patchReq?.body as Record<string, unknown>;
    expect(patchBody.outcome).toBe("completed");
  });

  test("[silent] marker → completeRun called with outcome:'completed'", async () => {
    mockRunner.mockResolvedValueOnce({
      result: "text [silent]",
      sessionId: "s1",
      usage: {
        input_tokens: 5,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    const reporter = makeHttpReporter();
    await handleCronRequest(
      { jobId: "silent-marker-job", prompt: "hello", channel: "C-MAIN" },
      { ...deps, cronRunReporter: reporter, clock: FixedClock(FIXED_TIME) },
    );

    const patchReq = reporterState.requests.find((r) => r.method === "PATCH");
    expect(patchReq).toBeDefined();
    const patchBody = patchReq?.body as Record<string, unknown>;
    expect(patchBody.outcome).toBe("completed");
  });

  test("channel post → completeRun called with outcome:'completed'", async () => {
    mockRunner.mockResolvedValueOnce({
      result: "the report",
      sessionId: "s1",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    const reporter = makeHttpReporter();
    await handleCronRequest(
      { jobId: "channel-job", prompt: "hello", channel: "C-REPORTS" },
      { ...deps, cronRunReporter: reporter, clock: FixedClock(FIXED_TIME) },
    );

    const patchReq = reporterState.requests.find((r) => r.method === "PATCH");
    expect(patchReq).toBeDefined();
    const patchBody = patchReq?.body as Record<string, unknown>;
    expect(patchBody.outcome).toBe("completed");
  });

  test("DM post → completeRun called with outcome:'completed'", async () => {
    mockRunner.mockResolvedValueOnce({
      result: "dm reply",
      sessionId: "s1",
      usage: {
        input_tokens: 30,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    const reporter = makeHttpReporter();
    await handleCronRequest(
      { jobId: "dm-job", prompt: "hello", user: "U-DAN" },
      { ...deps, cronRunReporter: reporter, clock: FixedClock(FIXED_TIME) },
    );

    const patchReq = reporterState.requests.find((r) => r.method === "PATCH");
    expect(patchReq).toBeDefined();
    const patchBody = patchReq?.body as Record<string, unknown>;
    expect(patchBody.outcome).toBe("completed");
  });
});

// ─── POST /cron HTTP endpoint ─────────────────────────────────────────────────

describe("POST /cron HTTP endpoint", () => {
  // biome-ignore lint/suspicious/noExplicitAny: Server type param varies by bun version
  const servers: Server<any>[] = [];

  function serve(
    port: number,
    sentryClient?: ErrorCapturingClient,
    // biome-ignore lint/suspicious/noExplicitAny: Server type param varies by bun version
  ): Server<any> {
    const s = startHealthServer(
      port,
      undefined,
      deps,
      undefined,
      undefined,
      sentryClient,
    );
    servers.push(s);
    return s;
  }

  afterEach(() => {
    for (const s of servers) s.stop(true);
    servers.length = 0;
  });

  test("200 on valid channel request", async () => {
    mockRunner.mockResolvedValueOnce({ result: "ok", sessionId: "s" });
    serve(19920);

    const res = await fetch("http://localhost:19920/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "j1", prompt: "hello", channel: "C-X" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });

  test("200 on valid user DM request", async () => {
    mockRunner.mockResolvedValueOnce({ result: "dm reply", sessionId: "s" });
    serve(19921);

    const res = await fetch("http://localhost:19921/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "j2", prompt: "daily", user: "U-DAN" }),
    });
    expect(res.status).toBe(200);
    expect(mockConversationsOpen).toHaveBeenCalledTimes(1);
  });

  test("400 for missing prompt", async () => {
    serve(19922);

    const res = await fetch("http://localhost:19922/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "j3" }),
    });
    expect(res.status).toBe(400);
  });

  test("422 when neither channel nor user and not silent", async () => {
    serve(19923);

    const res = await fetch("http://localhost:19923/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "j4", prompt: "hello" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("delivery target");
  });

  test("400 for invalid JSON body", async () => {
    serve(19924);

    const res = await fetch("http://localhost:19924/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json {{",
    });
    expect(res.status).toBe(400);
  });

  test("400 for missing jobId in body", async () => {
    serve(19925);

    const res = await fetch("http://localhost:19925/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", channel: "C-X" }),
    });
    expect(res.status).toBe(400);
  });

  test("500 when Claude runner throws", async () => {
    mockRunner.mockRejectedValueOnce(new Error("claude down"));
    serve(19926);

    const res = await fetch("http://localhost:19926/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "j5", prompt: "run", channel: "C-X" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("claude down");
  });

  test("500 with sentryClient injected — captureException called with the error, response unchanged", async () => {
    mockRunner.mockRejectedValueOnce(new Error("claude down"));
    const capturedErrors: unknown[] = [];
    const fakeSentryClient: ErrorCapturingClient = {
      captureException: (err: unknown) => {
        capturedErrors.push(err);
      },
    };
    serve(19930, fakeSentryClient);

    const res = await fetch("http://localhost:19930/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "j8", prompt: "run", channel: "C-X" }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("claude down");
    expect(capturedErrors.length).toBe(1);
    expect((capturedErrors[0] as Error).message).toBe("claude down");
  });

  test("422 ValidationError does NOT call sentryClient.captureException", async () => {
    const capturedErrors: unknown[] = [];
    const fakeSentryClient: ErrorCapturingClient = {
      captureException: (err: unknown) => {
        capturedErrors.push(err);
      },
    };
    serve(19931, fakeSentryClient);

    const res = await fetch("http://localhost:19931/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "j9", prompt: "hello" }),
    });

    expect(res.status).toBe(422);
    expect(capturedErrors.length).toBe(0);
  });

  test("500 with no sentryClient wired — behaves exactly as before (no throw, same response)", async () => {
    mockRunner.mockRejectedValueOnce(new Error("claude down"));
    serve(19932);

    const res = await fetch("http://localhost:19932/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "j10", prompt: "run", channel: "C-X" }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("claude down");
  });

  test("200 with silent=true — no Slack post", async () => {
    mockRunner.mockResolvedValueOnce({ result: "done", sessionId: "s" });
    serve(19927);

    const res = await fetch("http://localhost:19927/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "j6", prompt: "run", silent: true }),
    });
    expect(res.status).toBe(200);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test("503 when cronDeps not configured", async () => {
    const s = startHealthServer(19928);
    servers.push(s);

    const res = await fetch("http://localhost:19928/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "j7", prompt: "run", channel: "C-X" }),
    });
    expect(res.status).toBe(503);
  });

  test("405 on GET /cron", async () => {
    serve(19929);

    const res = await fetch("http://localhost:19929/cron", {
      method: "GET",
    });
    expect(res.status).toBe(405);
  });
});
