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
  "application/pdf",
  "application/json",
]);

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
