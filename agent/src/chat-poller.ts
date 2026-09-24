/**
 * agent/src/chat-poller.ts
 *
 * Chat poll loop — polls the chat service for pending user messages, runs them
 * through Claude, and posts replies back.
 *
 * The poll loop:
 *  1. Lists threads for the agent (via ChatServiceClient.listThreads)
 *  2. For each thread, attempts to claim the next unclaimed user message
 *  3. For a claimed message: runs it through the Claude runner with
 *     `chat:<threadId>` as the session key, then posts the reply
 *
 * Error isolation: failures on individual threads are caught and logged; other
 * threads continue processing.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeRunResult, ProgressCallback } from "./claude.ts";
import type { ChatServiceClient } from "./http-chat-service-client.ts";
import { parseMarkers } from "./markers.ts";
import {
  synthesizeSpeech,
  transcribeAudio,
  type VoiceConfig,
} from "./voice.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChatRunner = (
  message: string,
  sessionKey?: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
) => Promise<ClaudeRunResult>;

/** DI seam for STT — defaults to `transcribeAudio` from ./voice.ts. */
export type TranscribeAudioFn = typeof transcribeAudio;
/** DI seam for TTS — defaults to `synthesizeSpeech` from ./voice.ts. */
export type SynthesizeSpeechFn = typeof synthesizeSpeech;

/**
 * Audio attachment extensions recognized as voice notes. Detected by
 * filename extension (not mimetype — the chat service doesn't surface one)
 * against the same set of formats Slack's voice-note handling accepts.
 */
const AUDIO_EXTENSION_REGEX = /\.(webm|ogg|wav|m4a|mp3)$/i;

/**
 * Heartbeat cadence while a reply is in flight.
 *
 * Interval-driven, NOT progress-driven. A single long-running tool call (a
 * multi-minute `Bash`, say) emits one stream event and then nothing at all
 * until it returns, so a heartbeat tied to Claude turns goes silent during
 * exactly the long wait it exists to cover. Liveness is a property of the
 * agent process, not of the model's output cadence — so it gets its own
 * timer. 3s keeps proof of life well inside the admin UI's poll interval.
 */
const HEARTBEAT_INTERVAL_MS = 3_000;

export interface ChatPollerOptions {
  client: ChatServiceClient;
  runner: ChatRunner;
  /** Poll interval in ms. Default: 5000 */
  intervalMs?: number;
  /** Heartbeat cadence in ms while a reply is in flight. Default: 3000 */
  heartbeatIntervalMs?: number;
  /**
   * Agent workspace directory. When set, attachments on claimed messages are
   * pulled into `<workspaceDir>/uploads/` so Claude can Read them.
   */
  workspaceDir?: string;
  /** Injected for tests so timer behavior is deterministic. */
  setIntervalFn?: typeof setInterval;
  /** Injected for tests so timer behavior is deterministic. */
  clearIntervalFn?: typeof clearInterval;
  /** STT: transcribes an audio attachment. Default: transcribeAudio from ./voice.ts. */
  transcribeAudioFn?: TranscribeAudioFn;
  /** TTS: synthesizes a [speak:] marker's text to audio. Default: synthesizeSpeech from ./voice.ts. */
  synthesizeSpeechFn?: SynthesizeSpeechFn;
  /** Voice provider config (Groq/whisper-svc for STT, ElevenLabs/Piper for TTS). */
  voiceConfig?: VoiceConfig;
}

export interface ChatPoller {
  /** Start the poll interval. */
  start(): void;
  /** Stop the poll interval. */
  stop(): void;
  /** Run a single poll iteration. Exposed for testing. */
  pollOnce(): Promise<void>;
}

// ─── createChatPoller ─────────────────────────────────────────────────────────

export function createChatPoller(opts: ChatPollerOptions): ChatPoller {
  const {
    client,
    runner,
    intervalMs = 5_000,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    workspaceDir,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    transcribeAudioFn = transcribeAudio,
    synthesizeSpeechFn = synthesizeSpeech,
    voiceConfig = {},
  } = opts;

  let timer: ReturnType<typeof setInterval> | undefined;
  /** Guards against a slow poll overlapping the next interval tick. */
  let pollInFlight = false;

  async function processThread(threadId: string): Promise<void> {
    const message = await client.claimMessage(threadId);
    if (!message) return; // no unclaimed messages — no-op

    const sessionKey = `chat:${threadId}`;

    // Pull an attachment into the workspace so Claude can Read it.
    let runnerMessage = message.body;
    if (message.attachmentFilename && workspaceDir) {
      try {
        const bytes = await client.getAttachment(threadId, message.id);
        if (bytes) {
          const safeFilename = message.attachmentFilename.replace(
            /[^\w.-]+/g,
            "_",
          );
          const uploadsDir = join(workspaceDir, "uploads");
          await mkdir(uploadsDir, { recursive: true });
          const filePath = join(uploadsDir, `${message.id}-${safeFilename}`);
          await writeFile(filePath, bytes);

          // Voice note: transcribe and replace the runner message entirely
          // (same convention Slack's buildPromptWithFiles uses — the
          // transcript stands in for the message body, it isn't appended to
          // it). Any failure (no fn injected, non-audio extension, a thrown
          // transcribeAudioFn, or a null/blank transcript) falls through to
          // the generic attached-file note below.
          let transcript: string | null = null;
          if (transcribeAudioFn && AUDIO_EXTENSION_REGEX.test(safeFilename)) {
            try {
              transcript = await transcribeAudioFn(filePath, voiceConfig);
            } catch (err) {
              console.error(
                `[chat-poller] transcription failed for thread ${threadId} message ${message.id}:`,
                err instanceof Error ? err.message : String(err),
              );
              transcript = null;
            }
          }

          runnerMessage =
            transcript && transcript.trim().length > 0
              ? `[voice transcript: ${transcript.trim()}]`
              : `${message.body}\n\n[Attached file: ${safeFilename} saved at ${filePath}]`;
        }
      } catch (err) {
        console.error(
          `[chat-poller] failed to pull attachment for thread ${threadId} message ${message.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Bidirectional heartbeat: the same 3s tick that proves liveness also
    // learns whether a cancel was requested (via cancelRequestedAt on the
    // returned message) and, if so, aborts the in-flight run. This keeps the
    // architecture pull-only — no second polling loop, no inbound HTTP surface
    // on the agent. Failures are swallowed — a missed heartbeat must never
    // abort the reply itself.
    const abortController = new AbortController();
    let cancelRequested = false;
    const sendHeartbeat = () => {
      client
        .heartbeat(threadId, message.id)
        .then((result) => {
          if (result?.cancelRequested && !abortController.signal.aborted) {
            cancelRequested = true;
            abortController.abort();
          }
        })
        .catch((err) => {
          console.error(
            `[chat-poller] heartbeat failed for thread ${threadId} message ${message.id}:`,
            err instanceof Error ? err.message : String(err),
          );
        });
    };

    let runResult: Awaited<ReturnType<ChatRunner>> | undefined;
    let errorKind: string | undefined;
    const heartbeatTimer = setIntervalFn(sendHeartbeat, heartbeatIntervalMs);
    try {
      runResult = await runner(
        runnerMessage,
        sessionKey,
        undefined,
        abortController.signal,
      );
    } catch (err) {
      // The runner failed. The message must NOT be left claimed forever with
      // no reaper — always fall through to replyToMessage below with an
      // errorKind. A cancel is a deliberate user action, not a stall.
      const name = err instanceof Error ? err.name : "";
      errorKind =
        cancelRequested || name === "ClaudeAbortedError"
          ? "cancelled"
          : "stalled";
      console.error(
        `[chat-poller] runner failed for thread ${threadId} (${errorKind}):`,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearIntervalFn(heartbeatTimer);
    }

    // Derive the reply body + errorKind. The poller ALWAYS replies — a
    // streamIncomplete run has an empty result string, so posting it verbatim
    // would be an EMPTY reply; a thrown runner would otherwise leave the
    // message claimed forever. Every branch produces a non-empty body.
    const {
      body,
      tokens,
      costUsd,
      errorKind: finalErrorKind,
    } = deriveReply(runResult, errorKind);

    // TTS: extract a [speak:] marker (if any) and synthesize it to audio.
    // The marker is stripped from the posted body whenever one is found,
    // regardless of whether synthesis itself succeeds — only the attachment
    // is conditional on success (AC2 stripping + AC4 graceful degradation).
    let replyBody = body;
    let attachmentFilename: string | undefined;
    let attachmentSize: number | undefined;
    let attachmentBytes: Uint8Array | undefined;

    const { cleaned, markers } = parseMarkers(body);
    let speakText: string | undefined;
    for (const marker of markers) {
      if (marker.type === "speak") {
        speakText = marker.text;
        break;
      }
    }

    if (speakText !== undefined) {
      replyBody = cleaned;
      if (synthesizeSpeechFn) {
        try {
          const audioPath = await synthesizeSpeechFn(speakText, voiceConfig);
          if (audioPath) {
            const audioBytes = await readFile(audioPath);
            attachmentBytes = new Uint8Array(audioBytes);
            attachmentFilename = audioPath.split("/").pop() ?? "response.mp3";
            attachmentSize = attachmentBytes.length;
          }
        } catch (err) {
          console.error(
            `[chat-poller] speech synthesis failed for thread ${threadId} message ${message.id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    try {
      await client.replyToMessage(threadId, message.id, {
        body: replyBody,
        tokens,
        costUsd,
        errorKind: finalErrorKind,
        attachmentFilename,
        attachmentSize,
        attachmentBytes,
      });
    } catch (err) {
      console.error(
        `[chat-poller] replyToMessage failed for thread ${threadId} message ${message.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function pollOnce(): Promise<void> {
    let listResult: Awaited<ReturnType<typeof client.listThreads>>;
    try {
      listResult = await client.listThreads({});
    } catch (err) {
      console.error(
        "[chat-poller] listThreads failed:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    if (listResult.threads.length === 0) return;

    // Process each thread independently — errors on one must not block others
    await Promise.all(
      listResult.threads.map((thread) =>
        processThread(thread.id).catch((err) => {
          console.error(
            `[chat-poller] error processing thread ${thread.id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }),
      ),
    );
  }

  return {
    start() {
      if (timer) return; // already running
      // Skip a tick when the previous iteration is still running. A poll that
      // outlives its interval (a long claim + reply cycle always does) would
      // otherwise stack concurrent iterations for as long as it runs.
      timer = setIntervalFn(() => {
        if (pollInFlight) return;
        pollInFlight = true;
        void pollOnce().finally(() => {
          pollInFlight = false;
        });
      }, intervalMs);
    },
    stop() {
      if (timer) {
        clearIntervalFn(timer);
        timer = undefined;
      }
    },
    pollOnce,
  };
}

interface DerivedReply {
  body: string;
  tokens?: unknown;
  costUsd?: number;
  errorKind?: string;
}

/**
 * Turn a run outcome into a reply that is never empty. `errorKind` is the
 * failure-mode already inferred by the caller (`cancelled`/`stalled` for a
 * thrown runner, or undefined for a completed run). Rules:
 *  - cancelled: fixed body, keep errorKind.
 *  - runner threw (no runResult): keep errorKind, synthesize a body.
 *  - streamIncomplete or empty result on a clean finish: errorKind=incomplete
 *    with a non-empty fallback body (never post an empty bubble).
 *  - otherwise: the real reply body + usage.
 */
export function deriveReply(
  runResult: ClaudeRunResult | undefined,
  errorKind: string | undefined,
): DerivedReply {
  if (errorKind === "cancelled") return { body: "Cancelled.", errorKind };

  if (!runResult) {
    // Runner threw — errorKind is "stalled" (cancelled handled above).
    return { body: "The run failed unexpectedly.", errorKind };
  }

  const { usage: tokens, totalCostUsd: costUsd } = runResult;

  if (runResult.streamIncomplete) {
    return {
      body: runResult.result || "The reply was cut off before it finished.",
      tokens,
      costUsd,
      errorKind: "incomplete",
    };
  }

  if (runResult.result.trim().length > 0) {
    return { body: runResult.result, tokens, costUsd, errorKind };
  }

  // Clean finish but empty body — treat as incomplete rather than an empty bubble.
  return {
    body: "The reply was empty.",
    tokens,
    costUsd,
    errorKind: "incomplete",
  };
}
