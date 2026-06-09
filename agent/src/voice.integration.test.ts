/**
 * Integration tests for agent/src/voice.ts
 *
 * Strategy: use injected fetchFn for Groq/ElevenLabs HTTP calls — no global.*
 * mutation (test-system.md forbids it). Use real readFileSync so file-size
 * checks work against actual temp files. Use injected fetchFn for the
 * whisper-svc HTTP client tests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceConfig } from "./voice.ts";
import {
  makeWhisperSvcClient,
  synthesizeSpeech,
  transcribeAudio,
} from "./voice.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Cast a mock function to typeof fetch without TypeScript complaining. */
function asFetch(fn: unknown): typeof fetch {
  return fn as unknown as typeof fetch;
}

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

  test("calls Groq API and returns transcription text on success (injected fetchFn)", async () => {
    const mockFetch = mock(async (_url: string, _opts: unknown) =>
      Response.json({ text: "hello world" }),
    );

    const result = await transcribeAudio(tmpFile, testConfig, asFetch(mockFetch));

    expect(result).toBe("hello world");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toContain("groq.com");
  });

  test("includes Authorization header with groqApiKey (injected fetchFn)", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const mockFetch = mock(async (_url: string, opts: RequestInit) => {
      capturedHeaders.push(opts.headers as Record<string, string>);
      return Response.json({ text: "test" });
    });

    await transcribeAudio(tmpFile, testConfig, asFetch(mockFetch));

    expect(capturedHeaders[0]?.Authorization).toBe("Bearer test-groq-key");
  });

  test("returns null on non-ok Groq response (injected fetchFn)", async () => {
    const mockFetch = mock(
      async () => new Response("Bad request", { status: 400 }),
    );

    const errorMsgs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errorMsgs.push(String(args[0]));

    const result = await transcribeAudio(tmpFile, testConfig, asFetch(mockFetch));

    console.error = origError;

    expect(result).toBeNull();
    expect(errorMsgs.some((m) => m.includes("Groq STT failed"))).toBe(true);
  });

  test("returns null on Groq fetch error (injected fetchFn)", async () => {
    const mockFetch = mock(async () => {
      throw new Error("network error");
    });

    const errorMsgs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errorMsgs.push(String(args[0]));

    const result = await transcribeAudio(tmpFile, testConfig, asFetch(mockFetch));

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

  test("posts audio to /transcribe and returns transcription text (injected fetchFn success)", async () => {
    const fakeFetch = mock(async (_url: string, _opts: RequestInit) =>
      Response.json({ text: "transcribed text" }),
    );
    const client = makeWhisperSvcClient(
      "http://whisper-svc:8000",
      asFetch(fakeFetch),
    );

    const buffer = Buffer.from("audio data");
    const result = await client(buffer, "test.webm");

    expect(result).toBe("transcribed text");
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url] = fakeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://whisper-svc:8000/transcribe");
  });

  test("sends audio as multipart form data (injected fetchFn)", async () => {
    const capturedOpts: RequestInit[] = [];
    const fakeFetch = mock(async (_url: string, opts: RequestInit) => {
      capturedOpts.push(opts);
      return Response.json({ text: "ok" });
    });
    const client = makeWhisperSvcClient(
      "http://whisper-svc:8000",
      asFetch(fakeFetch),
    );

    const buffer = Buffer.from("audio bytes");
    await client(buffer, "recording.webm");

    expect(capturedOpts[0]?.method).toBe("POST");
    expect(capturedOpts[0]?.body).toBeInstanceOf(FormData);
  });

  test("returns null when service responds with 500 (injected fetchFn non-2xx)", async () => {
    const fakeFetch = mock(
      async () => new Response("Service Unavailable", { status: 500 }),
    );
    const client = makeWhisperSvcClient(
      "http://whisper-svc:8000",
      asFetch(fakeFetch),
    );

    const warnMsgs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnMsgs.push(String(args[0]));

    const result = await client(Buffer.from("audio"), "test.webm");

    console.warn = origWarn;

    expect(result).toBeNull();
    expect(warnMsgs.some((m) => m.includes("whisper-svc"))).toBe(true);
  });

  test("returns null and warns on network error (injected fetchFn)", async () => {
    const fakeFetch = mock(async () => {
      throw new Error("connection refused");
    });
    const client = makeWhisperSvcClient(
      "http://whisper-svc:8000",
      asFetch(fakeFetch),
    );

    const warnMsgs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnMsgs.push(String(args[0]));

    const result = await client(Buffer.from("audio"), "test.webm");

    console.warn = origWarn;

    expect(result).toBeNull();
    expect(warnMsgs.some((m) => m.includes("whisper-svc"))).toBe(true);
  });

  test("uses the audio filename as the form field filename (injected fetchFn)", async () => {
    const capturedBodies: FormData[] = [];
    const fakeFetch = mock(async (_url: string, opts: RequestInit) => {
      capturedBodies.push(opts.body as FormData);
      return Response.json({ text: "ok" });
    });
    const client = makeWhisperSvcClient(
      "http://whisper-svc:8000",
      asFetch(fakeFetch),
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
  test("returns null when no elevenLabsApiKey and edge-tts fallback fails", async () => {
    const result = await synthesizeSpeech("hello", {}, undefined, makeFailExitSpawn(1));

    expect(result).toBeNull();
  });

  test("calls ElevenLabs API with elevenLabsApiKey and voiceId (injected fetchFn)", async () => {
    const capturedCalls: Array<{ url: string; opts: RequestInit }> = [];
    const mockFetch = mock(async (url: string, opts: RequestInit) => {
      capturedCalls.push({ url, opts });
      return new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 });
    });

    const result = await synthesizeSpeech("hello", testConfig, asFetch(mockFetch));

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].url).toContain("elevenlabs.io");
    expect(capturedCalls[0].url).toContain("test-voice-id");
    const headers = capturedCalls[0].opts.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("test-eleven-key");
    expect(result).not.toBeNull();
    expect(result).toContain(".mp3");
  });

  test("ElevenLabs success → writes tmp file and returns path (injected fetchFn)", async () => {
    const mockFetch = mock(async () => {
      return new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 });
    });

    const outPath = await synthesizeSpeech("hello", testConfig, asFetch(mockFetch));

    expect(outPath).not.toBeNull();
    if (outPath) {
      expect(existsSync(outPath)).toBe(true);
      unlinkSync(outPath);
    }
  });

  test("returns null and logs error on non-ok ElevenLabs response (injected fetchFn)", async () => {
    const mockFetch = mock(async () => new Response("error", { status: 500 }));

    const errorMsgs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errorMsgs.push(String(args[0]));

    const result = await synthesizeSpeech("hello", testConfig, asFetch(mockFetch));

    console.error = origError;

    expect(result).toBeNull();
    expect(errorMsgs.some((m) => m.includes("ElevenLabs TTS failed"))).toBe(
      true,
    );
  });

  test("uses default Roger voiceId when voiceId not set (injected fetchFn)", async () => {
    const capturedUrls: string[] = [];
    const mockFetch = mock(async (url: string) => {
      capturedUrls.push(url);
      return new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 });
    });

    await synthesizeSpeech(
      "hello",
      { elevenLabsApiKey: "test-key" },
      asFetch(mockFetch),
    );

    expect(capturedUrls[0]).toContain("CwhRBWXzGAHq8TQ4Fs17");
  });
});

// ─── Helpers for subprocess injection (TTS edge-tts fallback only) ────────────

type SpawnFn = (
  command: string,
  args: string[],
  options?: SpawnOptions,
) => ChildProcess;

/** Build a mock ChildProcess-like EventEmitter with the properties voice.ts needs. */
function makeMockProc(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { destroy: () => void };
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { destroy: () => void };
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { destroy: () => {} };
  return proc;
}

function makeFailExitSpawn(code: number): SpawnFn {
  return (_cmd, _args, _opts) => {
    const proc = makeMockProc();
    setImmediate(() => {
      proc.emit("close", code);
    });
    return proc as unknown as ChildProcess;
  };
}
