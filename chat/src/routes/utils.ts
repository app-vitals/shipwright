/**
 * chat/src/routes/utils.ts
 * Shared helpers for route handlers.
 */

/**
 * Parse a query parameter as a non-negative integer.
 * Returns defaultValue when the param is absent, non-numeric, or negative.
 */
export function parseIntParam(
  value: string | undefined,
  defaultValue: number,
): number {
  if (value === undefined) return defaultValue;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) || n < 0 ? defaultValue : n;
}

/**
 * Strip the raw `attachmentBytes` bytea column from a message before it is
 * serialized as JSON. The bytes are served only by GET /:id/attachment;
 * JSON.stringify would expand a Uint8Array to `{"0":12,"1":34,...}` at
 * ~10-14 characters per byte, turning a few MB of retained audio into tens
 * of MB per list response. Applies to every message-shaped response.
 */
export function toApiMessage<T extends object>(
  message: T,
): Omit<T, "attachmentBytes"> {
  const { attachmentBytes: _bytes, ...rest } = message as T & {
    attachmentBytes?: unknown;
  };
  return rest;
}
