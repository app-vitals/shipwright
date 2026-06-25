/**
 * agent/src/clock.ts
 * Clock interface and production implementation for injectable time.
 *
 * Any code that needs the current time should accept a `Clock` via dependency
 * injection rather than calling `new Date()` or `Date.now()` directly.
 * This makes time-dependent logic trivially testable and deterministic.
 */

// ─── Interface ────────────────────────────────────────────────────────────────

export interface Clock {
  /** Returns the current time as a Date. */
  now(): Date;
}

// ─── SystemClock ──────────────────────────────────────────────────────────────

/**
 * Production clock — delegates to the real system time.
 *
 * @example
 * const clock = SystemClock();
 * clock.now(); // → current wall-clock time
 */
export function SystemClock(): Clock {
  return {
    now(): Date {
      return new Date();
    },
  };
}

/**
 * Fixed-time clock for deterministic testing.
 *
 * @example
 * const clock = FixedClock(new Date("2024-01-01T00:00:00Z"));
 * clock.now(); // → always 2024-01-01T00:00:00.000Z
 */
export function FixedClock(date: Date): Clock {
  return {
    now(): Date {
      return new Date(date);
    },
  };
}
