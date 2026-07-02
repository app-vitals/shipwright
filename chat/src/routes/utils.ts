/**
 * chat/src/routes/utils.ts
 * Shared utilities for chat route handlers.
 */

/**
 * Parse a query-string integer parameter with a default fallback.
 * Returns defaultValue when the parameter is absent, non-numeric, or negative.
 */
export function parseIntParam(
  value: string | undefined,
  defaultValue: number,
): number {
  if (value === undefined) return defaultValue;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) || n < 0 ? defaultValue : n;
}
