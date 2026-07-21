/**
 * metrics/src/lib/coalescing-cache.ts
 * Single-flight + short-TTL cache for coalescing redundant concurrent fetches.
 *
 * Concurrent get(key, fn) calls with the same key share the exact same
 * in-flight promise, however long fn() takes to settle — in-flight sharing is
 * promise-identity-based, not time-boxed. The TTL governs only post-resolution
 * retention: the eviction timer starts when the promise resolves, never at
 * call time, so a slow fetch is never evicted mid-flight. A rejected promise
 * is never cached — the next get() call re-invokes fn from scratch.
 *
 * Time comes from an injected Clock (never Date.now()), and eviction is a
 * lazy check-on-read (compare clock.now() against a stored expiry timestamp)
 * rather than a real timer, keeping the cache deterministic and fast to test.
 */

import type { Clock } from "./clock.ts";

interface CacheEntry<T> {
  /** The in-flight or settled promise for this key. */
  promise: Promise<T>;
  /** Epoch ms after which this entry is considered expired. Set only once
   * the promise has resolved — undefined while still pending, which makes
   * the entry immune to eviction until settlement. */
  expiresAtMs?: number;
}

export class CoalescingCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs: number = 5000,
  ) {}

  /**
   * Returns the cached value for `key`, sharing any in-flight call and
   * reusing any still-fresh resolved value. Otherwise invokes `fn()`, caches
   * the result once it resolves (starting the TTL countdown at that moment),
   * and never caches a rejection.
   */
  get<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key) as CacheEntry<T> | undefined;
    if (existing) {
      // Still pending (no expiry set yet) → always share, regardless of TTL.
      // Resolved and not yet expired → share the cached value.
      if (
        existing.expiresAtMs === undefined ||
        this.clock.now().getTime() < existing.expiresAtMs
      ) {
        return existing.promise;
      }
      // Expired — fall through to re-invoke fn().
      this.entries.delete(key);
    }

    const promise = fn();
    const entry: CacheEntry<T> = { promise };
    this.entries.set(key, entry as CacheEntry<unknown>);

    promise.then(
      () => {
        // Only start the TTL countdown once the promise actually resolves.
        entry.expiresAtMs = this.clock.now().getTime() + this.ttlMs;
      },
      () => {
        // Never cache a rejection — evict immediately so the next call
        // re-invokes fn() from scratch.
        if (this.entries.get(key) === (entry as CacheEntry<unknown>)) {
          this.entries.delete(key);
        }
      },
    );

    return promise;
  }
}
