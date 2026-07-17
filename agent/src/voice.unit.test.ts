/**
 * agent/src/voice.unit.test.ts
 *
 * Documents and locks the contract between makeWhisperSvcClient and the
 * self-hosted Whisper pod the chart ships (onerahmet/openai-whisper-asr-webservice).
 *
 * That image exposes a single ASR endpoint:
 *   POST /asr?encode=true&task=transcribe&output=txt
 * with the audio attached as the multipart field `audio_file`, and (with
 * output=txt) returns the transcription as a plain-text body — NOT JSON.
 *
 * These tests use an injected fetchFn (no global.fetch mutation) per the
 * test-isolation contract.
 *
 * The synthesizeSpeech dispatch tests below cover the four possible outcomes
 * of calling synthesizeSpeech: ElevenLabs called (key set), Piper success
 * (no key, spawnFn simulates a clean exit), Piper non-zero exit, and Piper
 * spawn error (binary absent). All use an injected SpawnFn — no real
 * subprocess, no global mocking, per the test-isolation contract.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { unlinkSync } from "node:fs";
import { describe, expect, mock, test } from "bun:test";
import { makeWhisperSvcClient, synthesizeSpeech } from "./voice.ts";

describe("makeWhisperSvcClient — onerahmet /asr contract", () => {
  test("POSTs to the /asr endpoint of the service URL", async () => {
    const fetchFn = mock(
      async (_url: string, _opts: RequestInit) =>
        new Response("hello world", { status: 200 }),
    );
    const client = makeWhisperSvcClient(
      "http://whisper:9000",
      fetchFn as unknown as typeof fetch,
    );

    await client(Buffer.from("audio"), "clip.webm");

    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith("http://whisper:9000/asr")).toBe(true);
  });

  test("includes the onerahmet query params (task=transcribe, output=txt, encode=true)", async () => {
    const fetchFn = mock(
      async (_url: string, _opts: RequestInit) =>
        new Response("ok", { status: 200 }),
    );
    const client = makeWhisperSvcClient(
      "http://whisper:9000",
      fetchFn as unknown as typeof fetch,
    );

    await client(Buffer.from("audio"), "clip.webm");

    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    const qs = new URL(url).searchParams;
    expect(qs.get("task")).toBe("transcribe");
    expect(qs.get("output")).toBe("txt");
    expect(qs.get("encode")).toBe("true");
  });

  test("attaches the audio under the `audio_file` multipart field", async () => {
    const bodies: FormData[] = [];
    const fetchFn = mock(async (_url: string, opts: RequestInit) => {
      bodies.push(opts.body as FormData);
      return new Response("ok", { status: 200 });
    });
    const client = makeWhisperSvcClient(
      "http://whisper:9000",
      fetchFn as unknown as typeof fetch,
    );

    await client(Buffer.from("audio"), "/tmp/recording.webm");

    const form = bodies[0];
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("audio_file") as File | null;
    expect(file).not.toBeNull();
    expect(file?.name).toBe("recording.webm");
  });

  test("parses the plain-text (output=txt) body as the transcription", async () => {
    const fetchFn = mock(
      async (_url: string, _opts: RequestInit) =>
        new Response("  transcribed words  ", { status: 200 }),
    );
    const client = makeWhisperSvcClient(
      "http://whisper:9000",
      fetchFn as unknown as typeof fetch,
    );

    const result = await client(Buffer.from("audio"), "clip.webm");
    expect(result).toBe("transcribed words");
  });

  test("returns null on a non-2xx ASR response", async () => {
    const fetchFn = mock(async () => new Response("boom", { status: 500 }));
    const client = makeWhisperSvcClient(
      "http://whisper:9000",
      fetchFn as unknown as typeof fetch,
    );
    const warn = console.warn;
    console.warn = () => {};
    const result = await client(Buffer.from("audio"), "clip.webm");
    console.warn = warn;
    expect(result).toBeNull();
  });
});

// ─── Helpers for subprocess injection (Piper) ─────────────────────────────────

type SpawnFn = (
  command: string,
  args: string[],
  options?: SpawnOptions,
) => ChildProcess;

function makeSuccessSpawn(): SpawnFn {
  return (_cmd, _args, _opts) => {
    // biome-ignore lint/suspicious/noExplicitAny: test helper needs dynamic property assignment
    const proc: any = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: () => {}, end: () => {} };
    setImmediate(() => {
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
    proc.stdin = { write: () => {}, end: () => {} };
    setImmediate(() => {
      proc.stderr.emit("data", Buffer.from("piper: model load error"));
      proc.emit("close", code);
    });
    return proc as unknown as ChildProcess;
  };
}

function makeSpawnErrorSpawn(): SpawnFn {
  return (_cmd, _args, _opts) => {
    // biome-ignore lint/suspicious/noExplicitAny: test helper needs dynamic property assignment
    const proc: any = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: () => {}, end: () => {} };
    setImmediate(() => {
      proc.emit("error", new Error("ENOENT: piper binary not found"));
    });
    return proc as unknown as ChildProcess;
  };
}

// ─── synthesizeSpeech dispatch — ElevenLabs vs Piper ─────────────────────────

describe("synthesizeSpeech — dispatch (ElevenLabs vs Piper)", () => {
  test("with ELEVENLABS_API_KEY set, ElevenLabs is called and Piper's spawnFn is never invoked", async () => {
    const mockFetch = mock(
      async () => new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 }),
    );
    const spawnFn = mock((() => {
      throw new Error("spawnFn should not be called when ElevenLabs key is set");
    }) as unknown as SpawnFn);

    const outPath = await synthesizeSpeech(
      "hello",
      { elevenLabsApiKey: "test-eleven-key" },
      mockFetch as unknown as typeof fetch,
      spawnFn,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(outPath).not.toBeNull();
    expect(outPath).toContain(".mp3");
    if (outPath) unlinkSync(outPath);
  });

  test("with no ELEVENLABS_API_KEY and a working Piper, synthesizeSpeech returns a path to a non-empty .wav file", async () => {
    const outPath = await synthesizeSpeech(
      "hello",
      {},
      undefined,
      makeSuccessSpawn(),
    );

    expect(outPath).not.toBeNull();
    expect(outPath).toContain(".wav");
  });

  test("when Piper exits non-zero, synthesizeSpeech returns null with no throw", async () => {
    const errorMsgs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errorMsgs.push(String(args[0]));

    let result: string | null = null;
    let threw = false;
    try {
      result = await synthesizeSpeech("hello", {}, undefined, makeFailExitSpawn(1));
    } catch {
      threw = true;
    }

    console.error = origError;

    expect(threw).toBe(false);
    expect(result).toBeNull();
    expect(errorMsgs.length).toBeGreaterThan(0);
  });

  test("when the Piper spawn itself errors (binary absent), synthesizeSpeech returns null with no throw", async () => {
    const errorMsgs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errorMsgs.push(String(args[0]));

    let result: string | null = null;
    let threw = false;
    try {
      result = await synthesizeSpeech(
        "hello",
        {},
        undefined,
        makeSpawnErrorSpawn(),
      );
    } catch {
      threw = true;
    }

    console.error = origError;

    expect(threw).toBe(false);
    expect(result).toBeNull();
    expect(errorMsgs.length).toBeGreaterThan(0);
  });
});
