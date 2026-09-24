/**
 * admin/src/attachment-validation.ts
 *
 * Pure, I/O-free validation for chat message attachments. Enforces the size cap
 * and an allowlist of MIME types before an upload is ever handed to the chat
 * service. Kept side-effect-free so it is trivially unit-testable.
 */

/** Maximum allowed attachment size (10 MB) — mirrors the chat service guard. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** MIME type prefixes accepted wholesale (e.g. any text/* file). */
export const ALLOWED_MIME_PREFIXES = ["text/"];

/** Exact MIME types accepted beyond the prefix list. */
export const ALLOWED_MIME_EXACT = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/json",
  // VM-3.1: mic-recorded blobs are submitted through this same upload path —
  // these are the exact MIME strings Chrome/Firefox's MediaRecorder emits
  // (browser/codec dependent, so all three are allowed).
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/ogg",
]);

/**
 * Filename extensions rendered as an inline <audio> player instead of a
 * plain filename badge (VM-3.1). No MIME type is persisted end-to-end on a
 * ChatMessage — the chat service only stores attachmentFilename/attachmentSize
 * — so audio-ness is inferred from the filename extension. Covers both
 * MediaRecorder-authored user attachments (.webm/.ogg, this task) and
 * TTS-authored assistant attachments (.wav/.mp3, from VM-2.1's chat-poller).
 */
const AUDIO_FILE_EXTENSIONS = [".wav", ".mp3", ".webm", ".ogg"];

/** Whether an attachment's filename indicates audio content. */
export function isAudioFilename(filename: string | null | undefined): boolean {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  return AUDIO_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

const AUDIO_CONTENT_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
};

/**
 * Map an audio filename's extension to a real `audio/*` Content-Type, for
 * the admin attachment-proxy route to serve. The chat service's own
 * GET /:id/attachment always streams `application/octet-stream`
 * (chat/src/routes/messages.ts), which most browsers refuse to play inline
 * in an <audio> element — the proxy route re-labels the response using this
 * mapping instead. Returns null for a non-audio (or unrecognized) filename.
 */
export function audioContentTypeForFilename(
  filename: string | null | undefined,
): string | null {
  if (!filename) return null;
  const lower = filename.toLowerCase();
  const ext = AUDIO_FILE_EXTENSIONS.find((e) => lower.endsWith(e));
  return ext ? (AUDIO_CONTENT_TYPES[ext] ?? null) : null;
}

export type AttachmentValidationResult =
  | { ok: false; error: string; status: 413 | 415 }
  | { ok: true; filename: string; size: number };

/**
 * Validate an attachment by filename, byte size, and MIME type.
 * Returns a discriminated result: on failure it carries a clear error message
 * and the appropriate HTTP status (413 too large, 415 unsupported type).
 */
export function validateAttachment(
  filename: string,
  size: number,
  mimeType: string,
): AttachmentValidationResult {
  if (size > MAX_ATTACHMENT_BYTES) {
    const mb = Math.round((size / 1024 / 1024) * 10) / 10;
    return {
      ok: false,
      status: 413,
      error: `Attachment exceeds the 10 MB limit (received ~${mb} MB)`,
    };
  }

  const isAllowed =
    ALLOWED_MIME_EXACT.has(mimeType) ||
    ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));

  if (!isAllowed) {
    return {
      ok: false,
      status: 415,
      error: `Attachment type "${mimeType || "unknown"}" is not allowed`,
    };
  }

  return { ok: true, filename, size };
}
