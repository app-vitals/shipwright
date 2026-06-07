/**
 * lib/clock.ts
 * Clock interface and production implementation for injectable time.
 *
 * Why clock injection instead of calling `new Date()` directly:
 *   - `new Date()` is a global side effect — tests that call it get whatever
 *     time the machine thinks it is, making assertions about timestamps fragile
 *     and non-deterministic.
 *   - By accepting a `Clock` as a dependency, any code that needs the current
 *     time becomes fully testable: pass a `FixedClock` (from tests/helpers/doubles.ts)
 *     in tests, `SystemClock` in production, and the logic under test is always
 *     deterministic.
 *
 * Usage:
 *   // Production wiring
 *   const svc = new MyService(SystemClock());
 *
 *   // Test wiring — import FixedClock from tests/helpers/doubles.ts
 */

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * Minimal clock abstraction.
 *
 * Any code that needs the current time should accept a `Clock` via dependency
 * injection rather than calling `new Date()` or `Date.now()` directly.
 * This makes time-dependent logic trivially testable and deterministic.
 */
export interface Clock {
  /** Returns the current time as a Date. */
  now(): Date;
}

// ─── SystemClock ──────────────────────────────────────────────────────────────

/**
 * Production clock — delegates to the real system time.
 *
 * Use this as the default in application wiring. Every call to `now()` returns
 * a fresh `new Date()`, so it behaves identically to direct `new Date()` usage
 * while still being injectable and swappable in tests.
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
