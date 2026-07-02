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
