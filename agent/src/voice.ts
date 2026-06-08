import { type SpawnOptions, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VOICE_DIR = join(tmpdir(), "shipwright-agent-voice");
const WHISPER_MAX_BYTES = 25 * 1024 * 1024; // 25MB

export interface VoiceConfig {
  groqApiKey?: string;
  elevenLabsApiKey?: string;
  voiceId?: string;
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
 * Creates an HTTP client that transcribes audio via the whisper-svc POST /transcribe endpoint.
 * Accepts an optional fetchFn for dependency injection in tests (avoids global.fetch mocking).
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
    formData.append("file", blob, audioPath.split("/").pop() ?? "audio.wav");

    let resp: Response;
    try {
      resp = await fetchFn(`${serviceUrl}/transcribe`, {
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

    const data = (await resp.json()) as { text: string };
    return data.text ?? null;
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
): Promise<string | null> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(fileBuffer)]);
  formData.append("file", blob, audioPath.split("/").pop() ?? "audio.webm");
  formData.append("model", "whisper-large-v3");

  let resp: Response;
  try {
    resp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });
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
 * Accepts an optional whisperClientFn for DI in tests.
 */
export async function transcribeAudio(
  audioPath: string,
  voiceConfig: VoiceConfig = {},
  whisperClientFn?: WhisperClientFn,
): Promise<string | null> {
  let fileBuffer: Buffer;
  try {
    fileBuffer = readFileSync(audioPath);
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

  const apiKey = voiceConfig.groqApiKey;
  if (apiKey) {
    const groqResult = await transcribeGroq(audioPath, fileBuffer, apiKey);
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
      ? makeWhisperSvcClient(voiceConfig.whisperServiceUrl)
      : null);

  if (!clientFn) return null;
  return clientFn(fileBuffer, audioPath);
}

/**
 * Synthesize speech from text using ElevenLabs (if key available) or edge-tts fallback.
 * Returns the path to the generated audio file, or null on failure.
 */
export async function synthesizeSpeech(
  text: string,
  voiceConfig: VoiceConfig = {},
  spawnFn: SpawnFn = defaultSpawn,
): Promise<string | null> {
  mkdirSync(VOICE_DIR, { recursive: true });

  const elevenKey = voiceConfig.elevenLabsApiKey;
  if (elevenKey) {
    return synthesizeElevenLabs(text, elevenKey, voiceConfig.voiceId);
  }

  return synthesizeEdgeTTS(text, spawnFn);
}

async function synthesizeElevenLabs(
  text: string,
  apiKey: string,
  voiceId?: string,
): Promise<string | null> {
  const vid = voiceId ?? "CwhRBWXzGAHq8TQ4Fs17"; // Roger

  let resp: Response;
  try {
    resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
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
  writeFileSync(outPath, Buffer.from(await resp.arrayBuffer()));
  return outPath;
}

function synthesizeEdgeTTS(
  text: string,
  spawnFn: SpawnFn = defaultSpawn,
): Promise<string | null> {
  const outPath = join(VOICE_DIR, `${Date.now()}-response.mp3`);

  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawnFn("edge-tts", [
        "--voice",
        "en-US-GuyNeural",
        // edge-tts validates pitch as `[+-]\d+Hz` — `%` is only valid for rate/volume.
        "--pitch=-15Hz",
        "--text",
        text,
        "--write-media",
        outPath,
      ]);
    } catch (err) {
      console.error("[voice] edge-tts spawn error:", err);
      resolve(null);
      return;
    }

    const stderrChunks: Buffer[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    let errorFired = false;
    proc.on("error", (err) => {
      errorFired = true;
      console.error("[voice] edge-tts spawn error:", err);
      resolve(null);
    });

    proc.on("close", (code) => {
      if (errorFired) return;
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString();
        console.error("[voice] edge-tts failed with exit code", code, stderr);
        resolve(null);
        return;
      }
      resolve(outPath);
    });
  });
}
