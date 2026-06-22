/**
 * task-store/src/clock.ts
 * Clock interface and implementations for injectable time.
 *
 * Any code that needs the current time should accept a `Clock` via dependency
 * injection rather than calling `new Date()` / `Date.now()` directly. This makes
 * time-dependent logic deterministic and trivially testable.
 */

// ─── Interface ────────────────────────────────────────────────────────────────

export interface Clock {
  /** Returns the current time as a Date. */
  now(): Date;
}

// ─── SystemClock ──────────────────────────────────────────────────────────────

/** Production clock — delegates to the real system time. */
export function SystemClock(): Clock {
  return {
    now(): Date {
      return new Date();
    },
  };
}

/** Fixed-time clock for deterministic testing. */
export function FixedClock(date: Date): Clock {
  return {
    now(): Date {
      return date;
    },
  };
}
