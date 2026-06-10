/**
 * Integration tests for agent/src/voice.ts
 *
 * Strategy: use injected fetchFn for Groq/ElevenLabs HTTP calls (no global.* mutation
 * per test-system.md). Use an injected fetchFn for the whisper-svc HTTP client tests.
 * Use real readFileSync so file-size checks work against actual temp files.
 * Use real file I/O for tmp audio files.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceConfig, WhisperClientFn } from "./voice.ts";
import {
  makeWhisperSvcClient,
  synthesizeSpeech,
  transcribeAudio,
} from "./voice.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempAudioFile(sizeBytes = 1000): string {
  const p = join(tmpdir(), `voice-test-${Date.now()}.webm`);
  writeFileSync(p, Buffer.alloc(sizeBytes));
  return p;
}

const testConfig: VoiceConfig = {
  groqApiKey: "test-groq-key",
  elevenLabsApiKey: "test-eleven-key",
  voiceId: "test-voice-id",
};

// ─── transcribeAudio ──────────────────────────────────────────────────────────

describe("transcribeAudio", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = makeTempAudioFile(1000);
  });

  afterEach(() => {
    if (tmpFile && existsSync(tmpFile)) unlinkSync(tmpFile);
  });

  test("skips Groq and returns null when groqApiKey is not set and no whisper client", async () => {
    const result = await transcribeAudio(tmpFile, {});
    expect(result).toBeNull();
  });

  test("returns null and warns when file exceeds 25MB", async () => {
    const bigFile = join(tmpdir(), `voice-test-big-${Date.now()}.webm`);
    writeFileSync(bigFile, Buffer.alloc(26 * 1024 * 1024));

    const warnMsgs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnMsgs.push(String(args[0]));

    const result = await transcribeAudio(bigFile, testConfig);

    console.warn = origWarn;
    unlinkSync(bigFile);

    expect(result).toBeNull();
    expect(warnMsgs.some((m) => m.includes("25MB"))).toBe(true);
  });

  test("returns null and warns when file does not exist", async () => {
    const warnMsgs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnMsgs.push(String(args[0]));

    const result = await transcribeAudio("/nonexistent/audio.webm", testConfig);

    console.warn = origWarn;
    expect(result).toBeNull();
    expect(warnMsgs.some((m) => m.includes("could not read"))).toBe(true);
  });

  test("calls Groq API and returns transcription text on success", async () => {
    const mockFetch = mock(async (_url: string, _opts: unknown) =>
      Response.json({ text: "hello world" }),
    );

    const result = await transcribeAudio(
      tmpFile,
      testConfig,
      mockFetch as unknown as typeof fetch,
    );

    expect(result).toBe("hello world");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toContain("groq.com");
  });

  test("includes Authorization header with groqApiKey", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const mockFetch = mock(async (_url: string, opts: RequestInit) => {
      capturedHeaders.push(opts.headers as Record<string, string>);
      return Response.json({ text: "test" });
    });

    await transcribeAudio(
      tmpFile,
      testConfig,
      mockFetch as unknown as typeof fetch,
    );

    expect(capturedHeaders[0]?.Authorization).toBe("Bearer test-groq-key");
  });

  test("returns null and logs error on non-ok Groq response, then tries whisper-svc", async () => {
    const mockFetch = mock(
      async () => new Response("Bad request", { status: 400 }),
    );

    const errorMsgs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errorMsgs.push(String(args[0]));

    const nullClient: WhisperClientFn = async () => null;
    const result = await transcribeAudio(
      tmpFile,
      testConfig,
      mockFetch as unknown as typeof fetch,
      nullClient,
    );

    console.error = origError;

    expect(result).toBeNull();
    expect(errorMsgs.some((m) => m.includes("Groq STT failed"))).toBe(true);
  });

  test("returns null and logs warning on Groq fetch error, then tries whisper-svc", async () => {
    const mockFetch = mock(async () => {
      throw new Error("network error");
    });

    const errorMsgs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errorMsgs.push(String(args[0]));

    const nullClient: WhisperClientFn = async () => null;
    const result = await transcribeAudio(
      tmpFile,
      testConfig,
      mockFetch as unknown as typeof fetch,
      nullClient,
    );

    console.error = origError;

    expect(result).toBeNull();
    expect(errorMsgs.some((m) => m.includes("request failed"))).toBe(true);
  });
});

// ─── makeWhisperSvcClient ─────────────────────────────────────────────────────

describe("makeWhisperSvcClient — HTTP transcription client", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = makeTempAudioFile(1000);
  });

  afterEach(() => {
    if (tmpFile && existsSync(tmpFile)) unlinkSync(tmpFile);
  });

  test("posts audio to /transcribe and returns transcription text", async () => {
    const fakeFetch = mock(async (_url: string, _opts: RequestInit) =>
      Response.json({ text: "transcribed text" }),
    );
    const client = makeWhisperSvcClient(
      "http://whisper-svc:8000",
      fakeFetch as unknown as typeof fetch,
    );

    const buffer = Buffer.from("audio data");
    const result = await client(buffer, "test.webm");

    expect(result).toBe("transcribed text");
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url] = fakeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://whisper-svc:8000/transcribe");
  });

  test("sends audio as multipart form data", async () => {
    const capturedOpts: RequestInit[] = [];
    const fakeFetch = mock(async (_url: string, opts: RequestInit) => {
      capturedOpts.push(opts);
      return Response.json({ text: "ok" });
    });
    const client = makeWhisperSvcClient(
      "http://whisper-svc:8000",
      fakeFetch as unknown as typeof fetch,
    );

    const buffer = Buffer.from("audio bytes");
    await client(buffer, "recording.webm");

    expect(capturedOpts[0]?.method).toBe("POST");
    expect(capturedOpts[0]?.body).toBeInstanceOf(FormData);
  });

  test("returns null and warns when service responds with non-2xx status", async () => {
    const fakeFetch = mock(
      async () => new Response("Service Unavailable", { status: 503 }),
    );
    const client = makeWhisperSvcClient(
      "http://whisper-svc:8000",
      fakeFetch as unknown as typeof fetch,
    );

    const warnMsgs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnMsgs.push(String(args[0]));

    const result = await client(Buffer.from("audio"), "test.webm");

    console.warn = origWarn;

    expect(result).toBeNull();
    expect(warnMsgs.some((m) => m.includes("whisper-svc"))).toBe(true);
  });

  test("returns null and warns on network error", async () => {
    const fakeFetch = mock(async () => {
      throw new Error("connection refused");
    });
    const client = makeWhisperSvcClient(
      "http://whisper-svc:8000",
      fakeFetch as unknown as typeof fetch,
    );

    const warnMsgs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnMsgs.push(String(args[0]));

    const result = await client(Buffer.from("audio"), "test.webm");

    console.warn = origWarn;

    expect(result).toBeNull();
    expect(warnMsgs.some((m) => m.includes("whisper-svc"))).toBe(true);
  });

  test("uses the audio filename as the form field filename", async () => {
    const capturedBodies: FormData[] = [];
    const fakeFetch = mock(async (_url: string, opts: RequestInit) => {
      capturedBodies.push(opts.body as FormData);
      return Response.json({ text: "ok" });
    });
    const client = makeWhisperSvcClient(
      "http://whisper-svc:8000",
      fakeFetch as unknown as typeof fetch,
    );

    await client(Buffer.from("audio"), "/tmp/my-recording.webm");

    const formData = capturedBodies[0];
    expect(formData).toBeDefined();
    const file = formData?.get("file") as File | null;
    expect(file?.name).toBe("my-recording.webm");
  });
});

// ─── synthesizeSpeech (ElevenLabs) ────────────────────────────────────────────

describe("synthesizeSpeech — ElevenLabs", () => {
  test("returns null when no keys are set and edge-tts fallback fails", async () => {
    const result = await synthesizeSpeech(
      "hello",
      {},
      undefined,
      makeFailExitSpawn(1),
    );

    expect(result).toBeNull();
  });

  test("returns an audio path when edge-tts fallback succeeds", async () => {
    const result = await synthesizeSpeech(
      "hello",
      {},
      undefined,
      makeSuccessSpawn(""),
    );

    expect(result).not.toBeNull();
    expect(result).toContain("response.mp3");
  });

  test("calls ElevenLabs API with elevenLabsApiKey and voiceId", async () => {
    const capturedCalls: Array<{ url: string; opts: RequestInit }> = [];
    const mockFetch = mock(async (url: string, opts: RequestInit) => {
      capturedCalls.push({ url, opts });
      return new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 });
    });

    const result = await synthesizeSpeech(
      "hello",
      testConfig,
      mockFetch as unknown as typeof fetch,
    );

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].url).toContain("elevenlabs.io");
    expect(capturedCalls[0].url).toContain("test-voice-id");
    const headers = capturedCalls[0].opts.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("test-eleven-key");
    expect(result).not.toBeNull();
    expect(result).toContain(".mp3");
  });

  test("uses default Roger voiceId when voiceId is not set", async () => {
    const capturedUrls: string[] = [];
    const mockFetch = mock(async (url: string) => {
      capturedUrls.push(url);
      return new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 });
    });

    await synthesizeSpeech(
      "hello",
      { elevenLabsApiKey: "test-key" },
      mockFetch as unknown as typeof fetch,
    );

    expect(capturedUrls[0]).toContain("CwhRBWXzGAHq8TQ4Fs17");
  });

  test("returns null and logs error on non-ok ElevenLabs response", async () => {
    const mockFetch = mock(async () => new Response("error", { status: 500 }));

    const errorMsgs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errorMsgs.push(String(args[0]));

    const result = await synthesizeSpeech(
      "hello",
      testConfig,
      mockFetch as unknown as typeof fetch,
    );

    console.error = origError;

    expect(result).toBeNull();
    expect(errorMsgs.some((m) => m.includes("ElevenLabs TTS failed"))).toBe(
      true,
    );
  });

  test("cleans up by writing mp3 file to tmp voice dir", async () => {
    const mockFetch = mock(async () => {
      return new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 });
    });

    const outPath = await synthesizeSpeech(
      "hello",
      testConfig,
      mockFetch as unknown as typeof fetch,
    );

    expect(outPath).not.toBeNull();
    if (outPath) {
      expect(existsSync(outPath)).toBe(true);
      unlinkSync(outPath);
    }
  });
});

// ─── Helpers for subprocess injection (TTS only) ─────────────────────────────

type SpawnFn = (
  command: string,
  args: string[],
  options?: SpawnOptions,
) => ChildProcess;

function makeSuccessSpawn(output: string): SpawnFn {
  return (_cmd, _args, _opts) => {
    // biome-ignore lint/suspicious/noExplicitAny: test helper needs dynamic property assignment
    const proc: any = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { destroy: () => {} };
    setImmediate(() => {
      if (output) proc.stdout.emit("data", Buffer.from(output));
      proc.emit("close", 0);
    });
    return proc as unknown as ChildProcess;
  };
}

function makeFailExitSpawn(code: number): SpawnFn {
  return (_cmd, _args, _opts) => {
    // biome-ignore lint/suspicious/noExplicitAny: test helper needs dynamic property assignment
    const proc: any = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { destroy: () => {} };
    setImmediate(() => {
      proc.emit("close", code);
    });
    return proc as unknown as ChildProcess;
  };
}

// ─── transcribeAudio — fallback chain ────────────────────────────────────────

describe("transcribeAudio — fallback chain", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(tmpdir(), `voice-fallback-test-${Date.now()}.webm`);
    writeFileSync(tmpFile, Buffer.alloc(1000));
  });

  afterEach(() => {
    if (tmpFile && existsSync(tmpFile)) unlinkSync(tmpFile);
  });

  test("uses injected whisper-svc client when groqApiKey is not set", async () => {
    const whisperClient: WhisperClientFn = async () => "whisper result";
    const result = await transcribeAudio(tmpFile, {}, undefined, whisperClient);
    expect(result).toBe("whisper result");
  });

  test("uses whisper-svc URL from voiceConfig when no client is injected", async () => {
    const fakeFetch = mock(async () =>
      Response.json({ text: "from config url" }),
    );
    const configWithUrl: VoiceConfig = {
      whisperServiceUrl: "http://whisper-svc:8000",
    };

    const result = await transcribeAudio(
      tmpFile,
      configWithUrl,
      fakeFetch as unknown as typeof fetch,
    );

    expect(result).toBe("from config url");
  });

  test("falls back to whisper-svc client when Groq returns null due to fetch error", async () => {
    const failingFetch = mock(async () => {
      throw new Error("network error");
    });

    const origError = console.error;
    console.error = () => {};

    const whisperClient: WhisperClientFn = async () => "fallback";
    const result = await transcribeAudio(
      tmpFile,
      testConfig,
      failingFetch as unknown as typeof fetch,
      whisperClient,
    );

    console.error = origError;

    expect(result).toBe("fallback");
  });

  test("returns Groq result without invoking whisper-svc client when Groq succeeds", async () => {
    const mockFetch = mock(async () => Response.json({ text: "groq result" }));

    const throwingClient: WhisperClientFn = async () => {
      throw new Error("whisper client should not have been called");
    };
    const result = await transcribeAudio(
      tmpFile,
      testConfig,
      mockFetch as unknown as typeof fetch,
      throwingClient,
    );

    expect(result).toBe("groq result");
  });

  test("returns null when no groqApiKey and no whisper client or URL configured", async () => {
    const result = await transcribeAudio(tmpFile, {});
    expect(result).toBeNull();
  });

  test("returns null when Groq key present but both Groq and whisper-svc client fail", async () => {
    const failingFetch = mock(async () => {
      throw new Error("network error");
    });
    const origError = console.error;
    console.error = () => {};

    const nullClient: WhisperClientFn = async () => null;
    const result = await transcribeAudio(
      tmpFile,
      testConfig,
      failingFetch as unknown as typeof fetch,
      nullClient,
    );

    console.error = origError;
    expect(result).toBeNull();
  });
});
