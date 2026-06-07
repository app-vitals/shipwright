/**
 * metrics/src/lib/clock.ts
 * Clock interface and production implementation for injectable time.
 */

export interface Clock {
  /** Returns the current time as a Date. */
  now(): Date;
}

export function SystemClock(): Clock {
  return {
    now(): Date {
      return new Date();
    },
  };
}
