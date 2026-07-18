import { type SpawnOptions, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiperVoicePaths, validatePiperVoice } from "./piper-voice.ts";

const VOICE_DIR = join(tmpdir(), "shipwright-agent-voice");
const WHISPER_MAX_BYTES = 25 * 1024 * 1024; // 25MB

export interface VoiceConfig {
  groqApiKey?: string;
  elevenLabsApiKey?: string;
  voiceId?: string;
  piperVoice?: string;
  whisperServiceUrl?: string;
}

// DI seam for the whisper-svc HTTP client — replaces spawnFn from the old local-Whisper path
export type WhisperClientFn = (
  audioBuffer: Buffer,
  audioPath: string,
) => Promise<string | null>;

type SpawnFn = (
  command: string,
  args: string[],
  options?: SpawnOptions,
) => ReturnType<typeof spawn>;

const defaultSpawn: SpawnFn = (cmd, args, opts) => spawn(cmd, args, opts ?? {});

/**
 * Creates an HTTP client that transcribes audio via the self-hosted Whisper pod
 * the chart ships: onerahmet/openai-whisper-asr-webservice.
 *
 * That image exposes a single ASR endpoint — `POST /asr` — with the audio
 * attached as the multipart field `audio_file`. The behaviour is selected via
 * query params; with `output=txt` the service returns the transcription as a
 * plain-text body (NOT JSON). We pin:
 *   - task=transcribe   (transcribe, not translate-to-English)
 *   - output=txt        (plain text body, simplest to consume)
 *   - encode=true        (let ffmpeg inside the image decode arbitrary input)
 *
 * Accepts an optional fetchFn for dependency injection in tests (avoids
 * global.fetch mocking).
 */
export function makeWhisperSvcClient(
  serviceUrl: string,
  fetchFn: typeof fetch = globalThis.fetch,
): WhisperClientFn {
  return async (
    audioBuffer: Buffer,
    audioPath: string,
  ): Promise<string | null> => {
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(audioBuffer)]);
    // onerahmet's ASR endpoint reads the upload from the `audio_file` field.
    formData.append(
      "audio_file",
      blob,
      audioPath.split("/").pop() ?? "audio.wav",
    );

    const base = serviceUrl.replace(/\/+$/, "");
    const url = `${base}/asr?encode=true&task=transcribe&output=txt`;

    let resp: Response;
    try {
      resp = await fetchFn(url, {
        method: "POST",
        body: formData,
      });
    } catch (err) {
      console.warn("[voice] whisper-svc request failed:", err);
      return null;
    }

    if (!resp.ok) {
      console.warn(
        "[voice] whisper-svc transcription failed:",
        resp.status,
        await resp.text(),
      );
      return null;
    }

    // output=txt → the body IS the transcription (no JSON envelope).
    const text = (await resp.text()).trim();
    return text.length > 0 ? text : null;
  };
}

/**
 * Transcribe an audio file via Groq Whisper API.
 * Returns the transcription text, or null on any error.
 */
async function transcribeGroq(
  audioPath: string,
  fileBuffer: Buffer,
  apiKey: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<string | null> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(fileBuffer)]);
  formData.append("file", blob, audioPath.split("/").pop() ?? "audio.webm");
  formData.append("model", "whisper-large-v3");

  let resp: Response;
  try {
    resp = await fetchFn(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      },
    );
  } catch (err) {
    console.error("[voice] Groq STT request failed:", err);
    return null;
  }

  if (!resp.ok) {
    console.error("[voice] Groq STT failed:", resp.status, await resp.text());
    return null;
  }

  const data = (await resp.json()) as { text: string };
  return data.text ?? null;
}

/**
 * Transcribe an audio file.
 * Fallback chain: Groq (if key set) → whisper-svc HTTP (if URL set or client injected) → null
 *
 * Accepts an optional fetchFn for DI in tests (avoids global.fetch mocking).
 * Accepts an optional whisperClientFn for tests that inject a custom WhisperClientFn directly.
 */
export async function transcribeAudio(
  audioPath: string,
  voiceConfig: VoiceConfig = {},
  fetchFn?: typeof fetch,
  whisperClientFn?: WhisperClientFn,
): Promise<string | null> {
  let fileBuffer: Buffer;
  try {
    fileBuffer = await readFile(audioPath);
  } catch (err) {
    console.warn("[voice] could not read audio file:", err);
    return null;
  }

  if (fileBuffer.byteLength > WHISPER_MAX_BYTES) {
    console.warn(
      `[voice] audio file exceeds 25MB limit (${fileBuffer.byteLength} bytes) — skipping transcription`,
    );
    return null;
  }

  const resolvedFetch = fetchFn ?? globalThis.fetch;

  const apiKey = voiceConfig.groqApiKey;
  if (apiKey) {
    const groqResult = await transcribeGroq(
      audioPath,
      fileBuffer,
      apiKey,
      resolvedFetch,
    );
    if (groqResult !== null) {
      return groqResult;
    }
    console.warn(
      "[voice] Groq transcription failed — falling back to whisper-svc",
    );
  }

  const clientFn =
    whisperClientFn ??
    (voiceConfig.whisperServiceUrl
      ? makeWhisperSvcClient(voiceConfig.whisperServiceUrl, resolvedFetch)
      : null);

  if (!clientFn) return null;
  return clientFn(fileBuffer, audioPath);
}

/**
 * Synthesize speech from text using ElevenLabs (if key available) or the
 * self-hosted Piper TTS binary baked into the image.
 * Returns the path to the generated audio file, or null on failure.
 *
 * Accepts an optional fetchFn for DI in tests (avoids global.fetch mocking).
 * Accepts an optional spawnFn for Piper subprocess injection in tests.
 */
export async function synthesizeSpeech(
  text: string,
  voiceConfig: VoiceConfig = {},
  fetchFn?: typeof fetch,
  spawnFn: SpawnFn = defaultSpawn,
): Promise<string | null> {
  mkdirSync(VOICE_DIR, { recursive: true });

  const elevenKey = voiceConfig.elevenLabsApiKey;
  if (elevenKey) {
    return synthesizeElevenLabs(
      text,
      elevenKey,
      voiceConfig.voiceId,
      fetchFn ?? globalThis.fetch,
    );
  }

  return synthesizePiper(text, voiceConfig, spawnFn);
}

async function synthesizeElevenLabs(
  text: string,
  apiKey: string,
  voiceId?: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<string | null> {
  const vid = voiceId ?? "CwhRBWXzGAHq8TQ4Fs17"; // Roger

  let resp: Response;
  try {
    resp = await fetchFn(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
    });
  } catch (err) {
    console.error("[voice] ElevenLabs TTS request failed:", err);
    return null;
  }

  if (!resp.ok) {
    console.error(
      "[voice] ElevenLabs TTS failed:",
      resp.status,
      await resp.text(),
    );
    return null;
  }

  const outPath = join(VOICE_DIR, `${Date.now()}-response.mp3`);
  await writeFile(outPath, Buffer.from(await resp.arrayBuffer()));
  return outPath;
}

/**
 * Synthesize speech via the self-hosted Piper TTS binary baked into the
 * image. Unlike a network-based TTS provider, Piper is a local
 * binary that reads text from stdin and writes audio directly to
 * `--output_file`. It never requires the network and produces WAV — not
 * MP3 — output, since ffmpeg stays absent from the image (no transcode
 * step; Piper's native WAV output is used directly).
 *
 * The voice is resolved via validatePiperVoice() (falls back to
 * DEFAULT_PIPER_VOICE when voiceConfig.piperVoice is unset or not
 * discovered) and resolvePiperVoicePaths() (only the .onnx model path is
 * needed for --model — Piper auto-discovers the sibling .onnx.json).
 *
 * Never throws — resolves null on every failure path (spawn error, non-zero
 * exit), mirroring synthesizeElevenLabs's never-throw contract.
 */
function synthesizePiper(
  text: string,
  voiceConfig: VoiceConfig = {},
  spawnFn: SpawnFn = defaultSpawn,
): Promise<string | null> {
  const outPath = join(VOICE_DIR, `${Date.now()}-response.wav`);

  const voiceName = validatePiperVoice(voiceConfig.piperVoice);
  const { onnxPath } = resolvePiperVoicePaths(voiceName);

  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawnFn("piper", [
        "--model",
        onnxPath,
        "--output_file",
        outPath,
      ]);
    } catch (err) {
      console.error("[voice] piper spawn error:", err);
      resolve(null);
      return;
    }

    const stderrChunks: Buffer[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    let errorFired = false;
    proc.on("error", (err) => {
      errorFired = true;
      console.error("[voice] piper spawn error:", err);
      resolve(null);
    });

    proc.on("close", (code) => {
      if (errorFired) return;
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString();
        console.error("[voice] piper failed with exit code", code, stderr);
        resolve(null);
        return;
      }
      resolve(outPath);
    });

    proc.stdin?.write(text);
    proc.stdin?.end();
  });
}
