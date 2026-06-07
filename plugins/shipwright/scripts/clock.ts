/**
 * plugins/shipwright/scripts/clock.ts
 *
 * Vendored copy of lib/clock.ts for standalone plugin execution.
 *
 * WHY THIS FILE EXISTS:
 * Precheck scripts (e.g. check-dev-task.ts) are installed into the plugin
 * cache at a path like:
 *   ~/.claude/plugins/cache/vitals-os/shipwright/<version>/scripts/
 * When Bun runs the script from that cache location, a relative import such as
 *   "../../../lib/clock.ts"
 * resolves to a path that does not exist — there is no lib/ directory three
 * levels above the cache. This vendored copy keeps the plugin self-contained so
 * it runs correctly whether invoked from the repo or from the installed cache.
 *
 * SOURCE: lib/clock.ts — do not diverge from that interface.
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
