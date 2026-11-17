import { expect, test } from "bun:test";
import { SystemClock } from "./clock.ts";

test("SystemClock.now() returns a fresh Date near real time", () => {
  const clock = SystemClock();
  const before = Date.now();
  const a = clock.now();
  expect(a).toBeInstanceOf(Date);
  expect(a.getTime()).toBeGreaterThanOrEqual(before);
  expect(a.getTime()).toBeLessThanOrEqual(Date.now());
  expect(clock.now()).not.toBe(a);
});
