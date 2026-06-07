/**
 * plugins/shipwright/scripts/clock.ts
 *
 * Clock interface and production implementation for injectable time.
 *
 * WHY THIS FILE EXISTS:
 * Precheck scripts (e.g. check-dev-task.ts) are installed into the plugin
 * cache at a path like:
 *   ~/.claude/plugins/cache/app-vitals/shipwright/<version>/scripts/
 * The scripts must import Clock from a local path that exists in the cache —
 * not from a shared lib/ that only exists in the source repo. This file keeps
 * the plugin fully self-contained so it runs correctly from any install location.
 *
 * Test doubles (FixedClock) live in ./test-helpers/doubles.ts.
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
