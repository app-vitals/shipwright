/**
 * Integration tests for cron-handler.ts
 *
 * Strategy: inject all deps. No real Slack or Claude calls.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebClient } from "@slack/web-api";
import { ValidationError, handleCronRequest } from "./cron-handler.ts";

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

const mockRunner = mock(() =>
  Promise.resolve({ result: "claude reply", sessionId: "sess-1" }),
);

const deps = {
  slack: mockSlack,
  runner: mockRunner,
  formatter: (text: string) => text,
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
    await handleCronRequest({ jobId: "j1", prompt: "hello", silent: true }, deps);
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
    expect((mockPostMessage.mock.calls as unknown as unknown[][])[0][0]).toMatchObject({
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
    expect((mockPostMessage.mock.calls as unknown as unknown[][])[0][0]).toMatchObject({ channel: "C-MAIN" });
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
    mockRunner.mockResolvedValueOnce({ result: "reply", sessionId: "sess-xyz" });

    await handleCronRequest(
      { jobId: "j1", prompt: "hello", channel: "C-TEST" },
      { ...deps, onSession },
    );

    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession.mock.calls[0]).toEqual(["C-TEST", "1234567890.000001", "sess-xyz"]);
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
    expect((mockConversationsOpen.mock.calls as unknown as unknown[][])[0][0]).toMatchObject({ users: "U-DAN" });

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect((mockPostMessage.mock.calls as unknown as unknown[][])[0][0]).toMatchObject({
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
});

// ─── Silent marker ────────────────────────────────────────────────────────────

describe("handleCronRequest — [silent] marker", () => {
  test("[silent] in result suppresses channel post", async () => {
    mockRunner.mockResolvedValueOnce({ result: "text [silent]", sessionId: "s3" });

    await handleCronRequest(
      { jobId: "j1", prompt: "hello", channel: "C-MAIN" },
      deps,
    );

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test("[silent] in result suppresses DM post", async () => {
    mockRunner.mockResolvedValueOnce({ result: "text [silent]", sessionId: "s4" });

    await handleCronRequest(
      { jobId: "j1", prompt: "hello", user: "U-DAN" },
      deps,
    );

    expect(mockConversationsOpen).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test("silent=true dep flag suppresses post", async () => {
    mockRunner.mockResolvedValueOnce({ result: "result", sessionId: "s5" });

    await handleCronRequest(
      { jobId: "j1", prompt: "hello", channel: "C-MAIN", silent: true },
      deps,
    );

    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});

// ─── preCheck ─────────────────────────────────────────────────────────────────

describe("handleCronRequest — preCheck", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
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
});
