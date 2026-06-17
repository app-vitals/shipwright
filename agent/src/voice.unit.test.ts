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
 */

import { describe, expect, mock, test } from "bun:test";
import { makeWhisperSvcClient } from "./voice.ts";

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
