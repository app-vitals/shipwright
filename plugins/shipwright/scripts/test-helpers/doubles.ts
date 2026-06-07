/**
 * plugins/shipwright/scripts/test-helpers/doubles.ts
 *
 * Local test doubles for plugin unit tests.
 *
 * FixedClock is the only double here — it is a self-contained helper so the
 * plugin tests do not depend on any cross-package imports.
 */

import type { Clock } from "../clock.ts";

/**
 * A deterministic test clock that returns a fixed instant in time.
 *
 * Pass a Date or ISO 8601 string to set the starting point.
 * Call `advance(ms)` to move the clock forward without touching wall time.
 *
 * @example
 * const clock = FixedClock("2026-05-31T16:00:00Z");
 * clock.now(); // → 2026-05-31T16:00:00.000Z
 * clock.advance(3_600_000);
 * clock.now(); // → 2026-05-31T17:00:00.000Z
 */
export function FixedClock(
  t: Date | string,
): Clock & { advance(ms: number): void } {
  const baseMs = typeof t === "string" ? new Date(t).getTime() : t.getTime();
  let offsetMs = 0;

  return {
    now(): Date {
      return new Date(baseMs + offsetMs);
    },
    advance(ms: number): void {
      offsetMs += ms;
    },
  };
}
