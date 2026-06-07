/**
 * metrics/tests/helpers/doubles.ts
 * Test doubles for the metrics workspace.
 * Scoped to only what metrics unit tests need.
 */

import type { Clock } from "../../src/lib/clock.ts";

// ─── FixedClock ───────────────────────────────────────────────────────────────

/**
 * A Clock implementation that always returns the same fixed time.
 * Use in tests to make time-dependent logic deterministic.
 *
 * @param isoString - ISO 8601 timestamp string (e.g. "2026-01-15T08:00:00.000Z")
 */
export function FixedClock(isoString: string): Clock {
  const fixed = new Date(isoString);
  return {
    now(): Date {
      return fixed;
    },
  };
}
