/**
 * metrics/src/cache.ts
 * Simple Map-based in-memory cache with TTL expiry. No external deps.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class Cache<T = unknown> {
  private readonly store = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    const nowMs = Date.now(); // infra: in-memory cache TTL
    if (nowMs > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs }); // infra: in-memory cache TTL
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

/** Build a cache key from query + optional date range using Web Crypto SHA-256 */
export async function buildCacheKey(
  query: string,
  dateFrom?: string,
  dateTo?: string,
): Promise<string> {
  const input = `${query}|${dateFrom ?? ""}|${dateTo ?? ""}`;
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
