/**
 * metrics/src/lib/coalescing-cache.unit.test.ts
 * Unit tests for CoalescingCache — single-flight + short-TTL cache.
 */

import { describe, expect, test } from "bun:test";
import { CoalescingCache } from "./coalescing-cache.ts";
import { FixedClock } from "./test-helpers.ts";

describe("CoalescingCache", () => {
  test("two concurrent get() calls with the same key and a slow fn share exactly one underlying call", async () => {
    const clock = FixedClock("2026-06-10T12:00:00.000Z");
    const cache = new CoalescingCache(clock);
    let callCount = 0;
    let resolveFn: (v: string) => void = () => {};
    const fn = () =>
      new Promise<string>((resolve) => {
        callCount++;
        resolveFn = resolve;
      });

    const p1 = cache.get("key-a", fn);
    const p2 = cache.get("key-a", fn);

    expect(callCount).toBe(1);

    resolveFn("value");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("value");
    expect(r2).toBe("value");
    expect(callCount).toBe(1);
  });

  test("an in-flight call that outlives the TTL is NOT evicted mid-flight (no duplicate fn invocation while pending)", async () => {
    const clock = FixedClock("2026-06-10T12:00:00.000Z");
    const cache = new CoalescingCache(clock, 5000);
    let callCount = 0;
    let resolveFn: (v: string) => void = () => {};
    const fn = () =>
      new Promise<string>((resolve) => {
        callCount++;
        resolveFn = resolve;
      });

    const p1 = cache.get("key-a", fn);

    // Advance the fake clock well past the TTL while the call is still pending.
    clock.advance(30_000);

    // A second concurrent get() call while still pending must still share the
    // same in-flight promise, not re-invoke fn — the eviction timer only
    // starts at resolution, never at call time.
    const p2 = cache.get("key-a", fn);
    expect(callCount).toBe(1);

    resolveFn("value");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("value");
    expect(r2).toBe("value");
    expect(callCount).toBe(1);
  });

  test("a rejected fn() is not cached — the next get() call re-invokes fn", async () => {
    const clock = FixedClock("2026-06-10T12:00:00.000Z");
    const cache = new CoalescingCache(clock);
    let callCount = 0;
    const fn = () => {
      callCount++;
      return Promise.reject(new Error("boom"));
    };

    await expect(cache.get("key-a", fn)).rejects.toThrow("boom");
    expect(callCount).toBe(1);

    // Next call re-invokes fn from scratch (not poisoned by the rejection).
    const fn2 = () => {
      callCount++;
      return Promise.resolve("recovered");
    };
    const result = await cache.get("key-a", fn2);
    expect(result).toBe("recovered");
    expect(callCount).toBe(2);
  });

  test("after the cached value resolves, advancing the fake clock past the TTL causes the next get() to invoke fn again", async () => {
    const clock = FixedClock("2026-06-10T12:00:00.000Z");
    const cache = new CoalescingCache(clock, 5000);
    let callCount = 0;
    const fn = () => {
      callCount++;
      return Promise.resolve(`value-${callCount}`);
    };

    const first = await cache.get("key-a", fn);
    expect(first).toBe("value-1");
    expect(callCount).toBe(1);

    // Still within TTL — should reuse cached value, no re-invocation.
    clock.advance(4000);
    const second = await cache.get("key-a", fn);
    expect(second).toBe("value-1");
    expect(callCount).toBe(1);

    // Advance past the TTL (measured from resolution time) — next call must
    // invoke fn again.
    clock.advance(2000);
    const third = await cache.get("key-a", fn);
    expect(third).toBe("value-2");
    expect(callCount).toBe(2);
  });

  test("different keys do not interfere with each other", async () => {
    const clock = FixedClock("2026-06-10T12:00:00.000Z");
    const cache = new CoalescingCache(clock);
    let callCountA = 0;
    let callCountB = 0;
    const fnA = () => {
      callCountA++;
      return Promise.resolve("a");
    };
    const fnB = () => {
      callCountB++;
      return Promise.resolve("b");
    };

    const [a, b] = await Promise.all([
      cache.get("key-a", fnA),
      cache.get("key-b", fnB),
    ]);
    expect(a).toBe("a");
    expect(b).toBe("b");
    expect(callCountA).toBe(1);
    expect(callCountB).toBe(1);
  });
});
